/**
 * turn-control — pure action sequences for the push-to-talk turn machine.
 *
 * Each function takes a SessionHandle (or a compatible spy in tests) and
 * issues the exact sequence of side-effects required to transition
 * between turn states. Extracted from useLiveProvider so the wire-level
 * call order is unit-testable without React, jsdom, or a real WebRTC
 * stack.
 *
 * Three states the user cycles through:
 *
 *     [agent speaking] ──interrupt──▶ [cancelled]
 *           ▲                              │
 *           │                              │ startListening (Tap to Talk)
 *           │                              ▼
 *     [responding] ◀──stopListening── [listening]
 *
 * The audio pipeline (audio element mute + receiver track) is OFF from
 * interruptResponse through startListening, and turned back ON in
 * stopListening — *before* response.create is sent. This guarantees no
 * leftover audio from a cancelled response can play during the user's
 * next turn.
 *
 * See the comment in realtime-client.ts setPlaybackMuted for the deeper
 * "why" — short version: setPlaybackMuted only toggles `audioEl.muted`,
 * never `.pause()` or `srcObject = null`, so the audio element keeps
 * draining the WebRTC jitter buffer continuously and muted intervals
 * never accumulate a backlog of audio.
 */

import type { RealtimeClientEvent } from "@/lib/agent/realtime-events";

/**
 * The subset of SessionHandle that turn-control needs. Narrowed so test
 * doubles only have to implement these five methods.
 */
export interface TurnControlHandle {
  send: (event: RealtimeClientEvent) => void;
  setMicEnabled: (on: boolean) => void;
  setPlaybackMuted: (muted: boolean) => void;
  setReceiverAudioEnabled: (enabled: boolean) => void;
}

/**
 * Interrupt the agent mid-speech.
 *
 * Order matters:
 *   1. setReceiverAudioEnabled(false) — silence the inbound track at the
 *      source (analyser sees zero, so the Aura/Interrupt button settle
 *      to "tap to talk" with no flicker).
 *   2. setPlaybackMuted(true) — `audioEl.muted = true`. The audio element
 *      keeps consuming the MediaStream so the WebRTC jitter buffer drains
 *      to silence continuously — no backlog accumulates.
 *   3. send(response.cancel) — asks OpenAI to stop generating.
 *
 * Crucially, neither (1) nor (2) PAUSES the audio pipeline — the audio
 * element keeps consuming the inbound stream throughout. By the time the
 * next turn un-mutes, the buffer holds only "live now".
 */
export function armForInterrupt(handle: TurnControlHandle): void {
  handle.setReceiverAudioEnabled(false);
  handle.setPlaybackMuted(true);
  handle.send({ type: "response.cancel" });
}

/**
 * User taps "Tap to Talk".
 *
 * Open the floor: enable mic, clear input buffer. We deliberately
 * do NOT re-enable the audio pipeline here — if the previous turn
 * was interrupted, the pipeline stays muted through this listening
 * phase. The agent isn't speaking during the user's turn anyway,
 * and this guarantees that any in-flight audio from the cancelled
 * response is drained silently to oblivion before the user hears
 * anything.
 */
export function armForListening(handle: TurnControlHandle): void {
  handle.setMicEnabled(true);
  handle.send({ type: "input_audio_buffer.clear" });
}

/**
 * User taps "Tap to Send" — commits their turn and asks for a response.
 *
 * Order matters: re-arm the inbound audio pipeline BEFORE sending
 * response.create, so the very first `response.output_audio.delta`
 * plays through an unmuted audio element. Likewise we re-enable the
 * receiver track first, then unmute, so the analyser is ready to track
 * real energy from byte one.
 */
export function armForResponse(handle: TurnControlHandle): void {
  handle.setMicEnabled(false);
  handle.setReceiverAudioEnabled(true);
  handle.setPlaybackMuted(false);
  handle.send({ type: "input_audio_buffer.commit" });
  handle.send({ type: "response.create" });
}
