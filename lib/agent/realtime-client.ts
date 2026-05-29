"use client";

/**
 * realtime-client — opens a WebRTC peer connection to the OpenAI Realtime
 * GA endpoint using an ephemeral client secret minted server-side by
 * /api/voice/session.
 *
 * Returns a handle exposing:
 *   - send(event)   to push client events through the `oai-events` data channel
 *   - close()       to tear down audio, peer connection, and AudioContexts
 *   - setMicEnabled / setPlaybackMuted / setReceiverAudioEnabled — turn-control
 *     primitives used by lib/agent/turn-control.ts (push-to-talk + interrupt).
 *   - onInboundAnalyserReady / onOutboundAnalyserReady — Web Audio analysers
 *     tapping the agent's output and the user's mic (used by the Aura).
 *
 * Audio architecture note: inbound playback uses a hidden <audio> element
 * (so we don't fight Chrome's AudioContext autoplay restrictions across the
 * SDP await). setPlaybackMuted only toggles `audioEl.muted` — never
 * pause() or srcObject=null — so the element keeps draining the WebRTC
 * jitter buffer continuously, and an interrupt-then-resume can't replay
 * a backlog of pre-interrupt audio. The Web Audio AnalyserNode taps the
 * same MediaStream separately for Aura visualisation.
 *
 * Reference flow:
 *   https://developers.openai.com/api/docs/guides/realtime-webrtc
 */

import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
} from "@/lib/agent/realtime-events";

const REALTIME_SDP_URL = "https://api.openai.com/v1/realtime/calls";

export interface OpenSessionOptions {
  clientSecret: string; // ek_... ephemeral token from /api/voice/session
  model: string;
  /** Called for every server event arriving on the data channel. */
  onEvent: (event: RealtimeServerEvent) => void;
  /** Called once when the data channel opens (good moment to send first messages). */
  onOpen?: () => void;
  /** Called for transport-level errors (SDP, network, data channel). */
  onError?: (err: Error) => void;
  /** Called whenever the underlying RTCPeerConnection state changes. */
  onConnectionState?: (state: RTCPeerConnectionState) => void;
  /** Called once the inbound (agent) audio track is wired into an AnalyserNode. */
  onInboundAnalyserReady?: (analyser: AnalyserNode) => void;
  /** Called once the outbound (mic) track is wired into an AnalyserNode. */
  onOutboundAnalyserReady?: (analyser: AnalyserNode) => void;
}

export interface SessionHandle {
  send: (event: RealtimeClientEvent) => void;
  close: () => Promise<void>;
  /**
   * Toggle the local mic track. In push-to-talk mode we keep the track
   * disabled until the user explicitly opens the floor — this means no
   * audio leaves the browser between turns, even though the WebRTC stream
   * is still up. Cheaper than re-negotiating SDP each turn.
   */
  setMicEnabled: (on: boolean) => void;
  /** Current mic enable state (mirrors the track flag). */
  isMicEnabled: () => boolean;
  /**
   * Toggle the inbound audio output between silent and audible.
   * Implemented as `audioEl.muted = ...` ONLY — no pause(), no
   * srcObject=null. The audio element keeps consuming the MediaStream
   * at the device sample rate regardless of mute state, which is what
   * drains the WebRTC jitter buffer continuously. There is NEVER a
   * backlog of pre-interrupt audio to play out when we un-mute,
   * because nothing was ever paused.
   */
  setPlaybackMuted: (muted: boolean) => void;
  /**
   * Enable / disable the inbound WebRTC audio receiver track at the
   * source. Belt-and-braces alongside setPlaybackMuted: while disabled
   * the track outputs silence regardless of what's landing in the jitter
   * buffer, so the AnalyserNode (used by the Aura's "agent is audible"
   * detector) sees zero energy and the orb stays calm on interrupt.
   */
  setReceiverAudioEnabled: (enabled: boolean) => void;
}

export async function openRealtimeSession(opts: OpenSessionOptions): Promise<SessionHandle> {
  const pc = new RTCPeerConnection();

  // ---- Inbound audio (agent → browser speakers + AnalyserNode) ----
  //
  // Architecture: a hidden HTMLAudioElement handles audible playback,
  // and a separate Web Audio graph taps the same MediaStream for the
  // Aura's frequency visualisation.
  //
  //     <audio srcObject=stream>                  (audible playback;
  //                                                browser handles autoplay)
  //     source(stream) → AnalyserNode             (visualisation only;
  //                                                not connected to destination)
  //
  // CRITICAL invariant for interrupt → resume not replaying old audio:
  //
  //   setPlaybackMuted only toggles `audioEl.muted`. It NEVER calls
  //   `.pause()` and NEVER detaches `srcObject`. An audio element
  //   playing a MediaStream consumes samples at the device sample rate
  //   regardless of the `muted` flag — `muted` only silences output.
  //
  //   This means the WebRTC jitter buffer is ALWAYS being drained, even
  //   during an interrupt window. There's no backlog of "tail audio"
  //   from a cancelled response sitting around to play out when the
  //   user resumes their next turn. The audio element drained it all
  //   to silence as it arrived.
  //
  //   Why not Web Audio for playback too? Because Chrome refuses to
  //   start an AudioContext outside a user gesture, and by the time
  //   openRealtimeSession runs we've already awaited /api/voice/session
  //   (gesture expired). The <audio> element doesn't have this
  //   restriction — `autoplay=true` just works for MediaStream sources.
  const audioEl = document.createElement("audio");
  audioEl.autoplay = true;
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);

  let inboundAudioCtx: AudioContext | null = null;
  let inboundAnalyser: AnalyserNode | null = null;

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    audioEl.srcObject = stream;
    try {
      inboundAudioCtx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const source = inboundAudioCtx.createMediaStreamSource(stream);
      inboundAnalyser = inboundAudioCtx.createAnalyser();
      inboundAnalyser.fftSize = 64; // → 32 freq bins; matches the Aura's bin count.
      inboundAnalyser.smoothingTimeConstant = 0.5;
      source.connect(inboundAnalyser);
      // NOTE: analyser is NOT connected to destination — the <audio>
      // element handles audible playback. Connecting both paths would
      // double-emit on some browsers and silence one on others.
      opts.onInboundAnalyserReady?.(inboundAnalyser);
    } catch (e) {
      // Analyser failure should NOT kill the call — the user can still
      // hear the agent; the Aura just falls back to sin-driven freq.
      const err = e instanceof Error ? e : new Error(String(e));
      console.warn("[realtime] inbound analyser failed:", err.message);
    }
  };

  // ---- Outbound audio (mic → peer connection + AnalyserNode) ----
  let micStream: MediaStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    cleanupAudioEl();
    pc.close();
    const message = e instanceof Error ? e.message : "Microphone permission denied";
    throw new Error(`Microphone access failed: ${message}`);
  }

  // Push-to-talk default: mic track is added (so SDP includes it) but starts
  // disabled so OpenAI receives silence until the user opts in. We don't tear
  // the track down between turns; we just toggle .enabled — re-negotiating
  // SDP per turn is far more expensive.
  for (const track of micStream.getTracks()) {
    track.enabled = false;
    pc.addTrack(track, micStream);
  }

  let outboundAudioCtx: AudioContext | null = null;
  try {
    outboundAudioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const source = outboundAudioCtx.createMediaStreamSource(micStream);
    const outboundAnalyser = outboundAudioCtx.createAnalyser();
    outboundAnalyser.fftSize = 64;
    outboundAnalyser.smoothingTimeConstant = 0.5;
    source.connect(outboundAnalyser);
    opts.onOutboundAnalyserReady?.(outboundAnalyser);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn("[realtime] outbound analyser failed:", err.message);
  }

  // ---- Data channel for events ----
  const dc = pc.createDataChannel("oai-events");

  dc.addEventListener("open", () => {
    opts.onOpen?.();
  });

  dc.addEventListener("message", (e) => {
    try {
      const event = JSON.parse(e.data) as RealtimeServerEvent;
      opts.onEvent(event);
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error("Invalid event JSON"));
    }
  });

  dc.addEventListener("error", (e) => {
    const ev = e as unknown as RTCErrorEvent;
    const msg = ev?.error?.message ?? "Data channel error";
    opts.onError?.(new Error(msg));
  });

  pc.addEventListener("connectionstatechange", () => {
    opts.onConnectionState?.(pc.connectionState);
  });

  // ---- SDP offer/answer ----
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch(`${REALTIME_SDP_URL}?model=${encodeURIComponent(opts.model)}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.clientSecret}`,
      "Content-Type": "application/sdp",
    },
    body: offer.sdp,
  });

  if (!sdpResp.ok) {
    const detail = await sdpResp.text().catch(() => "");
    cleanupAudioEl();
    micStream.getTracks().forEach((t) => t.stop());
    pc.close();
    throw new Error(`Realtime SDP exchange failed (${sdpResp.status}): ${detail || sdpResp.statusText}`);
  }

  const answerSdp = await sdpResp.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });

  // ---- Handle ----
  function cleanupAudioEl() {
    try {
      audioEl.srcObject = null;
      audioEl.remove();
    } catch {
      // ignore
    }
  }

  const send = (event: RealtimeClientEvent) => {
    if (dc.readyState !== "open") {
      opts.onError?.(new Error(`Cannot send: data channel is '${dc.readyState}'`));
      return;
    }
    dc.send(JSON.stringify(event));
  };

  const setMicEnabled = (on: boolean) => {
    for (const track of micStream.getTracks()) {
      track.enabled = on;
    }
  };

  const isMicEnabled = () => {
    const tracks = micStream.getTracks();
    return tracks.length > 0 && tracks.every((t) => t.enabled);
  };

  const setReceiverAudioEnabled = (enabled: boolean) => {
    for (const receiver of pc.getReceivers()) {
      const track = receiver.track;
      if (track && track.kind === "audio") {
        track.enabled = enabled;
      }
    }
  };

  const setPlaybackMuted = (muted: boolean) => {
    // muted-only. No pause(), no srcObject=null. The audio element keeps
    // consuming the MediaStream at the device sample rate either way —
    // `muted` just silences the OUTPUT. That continuous consumption is
    // what drains the WebRTC jitter buffer in real time, so when we
    // unmute on the next turn we hear "live now" and never a backlog
    // of pre-interrupt audio. See the comment block at the top of
    // openRealtimeSession for the deeper rationale.
    audioEl.muted = muted;
  };

  const close = async () => {
    try {
      dc.close();
    } catch {
      // ignore
    }
    try {
      micStream.getTracks().forEach((t) => t.stop());
    } catch {
      // ignore
    }
    try {
      pc.close();
    } catch {
      // ignore
    }
    cleanupAudioEl();
    try {
      await inboundAudioCtx?.close();
    } catch {
      // ignore
    }
    try {
      await outboundAudioCtx?.close();
    } catch {
      // ignore
    }
    inboundAnalyser = null;
  };

  return {
    send,
    close,
    setMicEnabled,
    isMicEnabled,
    setPlaybackMuted,
    setReceiverAudioEnabled,
  };
}
