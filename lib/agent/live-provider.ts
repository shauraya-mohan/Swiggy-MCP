"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentManifest } from "@/lib/agent/manifest";
import { IDLE_MANIFEST } from "@/lib/agent/manifest";
import {
  reduceEvent,
  extractFunctionCalls,
  INITIAL_LIVE_STATE,
  type LiveSessionState,
  type RealtimeServerEvent,
  type ResponseDoneEvent,
  type FunctionCallArgsDoneEvent,
} from "@/lib/agent/realtime-events";
import { openRealtimeSession, type SessionHandle } from "@/lib/agent/realtime-client";
import { executeToolCall } from "@/lib/agent/tool-bridge";

/**
 * useLiveProvider — drives the real OpenAI Realtime WebRTC voice loop.
 *
 * Wiring:
 *   1. startSession() POSTs /api/voice/session to mint an ek_* ephemeral.
 *   2. openRealtimeSession() opens a WebRTC peer + data channel and pipes
 *      the user's mic up + the agent's audio down (played via a hidden
 *      <audio> element; mirrored into Web Audio AnalyserNodes for the Aura).
 *   3. Server events flow through reduceEvent → AgentManifest updates.
 *   4. Function-call events trigger executeToolCall against /api/tools/*,
 *      whose result is wrapped in a function_call_output item and pushed
 *      back; response.create asks the model to continue.
 *
 * What's NOT wired yet (Step 8):
 *   - Surfacing tool results as Cards / Negotiator panels in the manifest.
 *     The voice loop is whole; the UI just shows the orb + transcripts.
 */
export interface LiveProviderState {
  manifest: AgentManifest;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  /** Push-to-talk: open the floor. Enables mic, clears the input buffer,
   *  flips aura → listening. */
  startListening: () => void;
  /** Push-to-talk: close the floor. Disables mic, commits the buffer,
   *  asks the model to respond, flips aura → thinking. */
  stopListening: () => void;
  /** Cancel an in-progress response (interrupt the agent mid-speech). */
  interruptResponse: () => void;
  inboundAnalyser: AnalyserNode | null;
  outboundAnalyser: AnalyserNode | null;
  liveError: string | null;
  liveConnected: boolean;
  isListening: boolean;
}

export function useLiveProvider(): LiveProviderState {
  const [manifest, setManifest] = useState<AgentManifest>(IDLE_MANIFEST);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [inboundAnalyser, setInboundAnalyser] = useState<AnalyserNode | null>(null);
  const [outboundAnalyser, setOutboundAnalyser] = useState<AnalyserNode | null>(null);
  const [isListening, setIsListening] = useState(false);

  // Mutable session refs — kept out of React state to avoid stale closures
  // during the event loop. We never re-create the session on re-render.
  const sessionRef = useRef<SessionHandle | null>(null);
  const sessionStateRef = useRef<LiveSessionState>(INITIAL_LIVE_STATE);
  const startingRef = useRef<boolean>(false);
  // After the user taps Interrupt we send `response.cancel` but tail-end
  // events for that response (deltas already on the wire, the final
  // response.done with status=cancelled) keep arriving for ~200–500 ms.
  // If we let them flow through the reducer the caption keeps growing and
  // the aura flickers back to speaking — visibly contradicting the user's
  // interrupt. cancellingRef gates the reducer until the next user turn.
  const cancellingRef = useRef<boolean>(false);

  const applyEvent = useCallback((event: RealtimeServerEvent) => {
    // Reducer is meant to be pure; if it ever throws (malformed event from
    // upstream, schema drift), don't take down the session — log it and keep
    // going. The Aura/transcript stay on whatever the last good state was.
    try {
      // Lightweight trace — surfaces every event in the browser console so
      // we can verify the wire-level flow when something looks off. Costs
      // nothing in production builds (you can flip it off if it gets noisy).
      if (typeof window !== "undefined") {
        // eslint-disable-next-line no-console
        console.debug("[realtime]", event.type);
      }
      // Drop tail-end events from a cancelled response. Errors and session
      // lifecycle events still go through; only response.* state churn is
      // suppressed.
      if (cancellingRef.current && typeof event.type === "string" && event.type.startsWith("response.")) {
        if (typeof window !== "undefined") {
          console.debug("[realtime] (cancelled — dropped)", event.type);
        }
        // A response.done with status=cancelled is the OpenAI ack that the
        // cancellation took effect. Once we've seen it, we can stop
        // suppressing — but we still don't *apply* it (no state change).
        const done = event as { type: string; response?: { status?: string } };
        if (event.type === "response.done" && done.response?.status === "cancelled") {
          cancellingRef.current = false;
        }
        return;
      }
      const next = reduceEvent(sessionStateRef.current, event);
      sessionStateRef.current = next;
      setManifest({ ...next.manifest });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Reducer error";
      console.warn("[live] reduceEvent failed for", event.type, "—", message);
    }
  }, []);

  const handleToolCall = useCallback(
    async (call: { call_id: string; name: string; arguments: string }) => {
      const result = await executeToolCall({
        handle: call.name,
        argsJson: call.arguments,
      });

      // Wrap the result in a function_call_output and push it back, then ask
      // the model to continue. The model decides whether to speak, call
      // another tool, or finish the turn.
      sessionRef.current?.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result.body),
        },
      });
      sessionRef.current?.send({ type: "response.create" });
    },
    [],
  );

  const startSession = useCallback(async () => {
    if (sessionRef.current || startingRef.current) return;
    startingRef.current = true;
    setLiveError(null);

    try {
      // Mint an ephemeral token.
      const tokenResp = await fetch("/api/voice/session", { method: "POST" });
      const tokenJson = (await tokenResp.json()) as
        | { success: true; data: { clientSecret: string; model: string; sessionId: string } }
        | { success: false; error: { code: string; message: string } };

      if (!tokenJson.success) {
        throw new Error(tokenJson.error?.message ?? "Failed to mint ephemeral token");
      }

      const { clientSecret, model } = tokenJson.data;

      const handle = await openRealtimeSession({
        clientSecret,
        model,
        onEvent: (event) => {
          applyEvent(event);

          // Tool-call handling.
          //
          // OpenAI emits the *complete* function call in two places:
          //   - response.function_call_arguments.done (call_id, name, arguments)
          //   - response.done (.response.output[].type === "function_call")
          //
          // We act on .arguments.done so we can start executing while
          // response.done is still in flight. response.done is a backup
          // safety net only — guarded by call-id dedupe via pendingCalls.
          if (event.type === "response.function_call_arguments.done") {
            const e = event as FunctionCallArgsDoneEvent;
            void handleToolCall({ call_id: e.call_id, name: e.name, arguments: e.arguments });
          } else if (event.type === "response.done") {
            const calls = extractFunctionCalls(event as ResponseDoneEvent);
            // Most calls were already handled via the .done event; this is a
            // backstop in case the granular events were dropped/coalesced.
            for (const call of calls) {
              if (sessionStateRef.current.pendingCalls[call.call_id]) {
                void handleToolCall(call);
              }
            }
          }
        },
        onOpen: () => {
          setLiveConnected(true);
        },
        onError: (err) => {
          setLiveError(err.message);
        },
        onConnectionState: (state) => {
          if (state === "failed" || state === "closed" || state === "disconnected") {
            setLiveConnected(false);
            sessionRef.current = null;
            sessionStateRef.current = INITIAL_LIVE_STATE;
            setManifest(IDLE_MANIFEST);
            setInboundAnalyser(null);
            setOutboundAnalyser(null);
          }
        },
        onInboundAnalyserReady: (an) => setInboundAnalyser(an),
        onOutboundAnalyserReady: (an) => setOutboundAnalyser(an),
      });

      sessionRef.current = handle;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to open Realtime session";
      setLiveError(message);
      sessionRef.current = null;
      setLiveConnected(false);
    } finally {
      startingRef.current = false;
    }
  }, [applyEvent, handleToolCall]);

  const endSession = useCallback(async () => {
    const handle = sessionRef.current;
    sessionRef.current = null;
    if (handle) {
      await handle.close();
    }
    sessionStateRef.current = INITIAL_LIVE_STATE;
    cancellingRef.current = false;
    setManifest(IDLE_MANIFEST);
    setInboundAnalyser(null);
    setOutboundAnalyser(null);
    setLiveConnected(false);
    setIsListening(false);
  }, []);

  // ---- Push-to-talk turn control ----
  //
  // Manual turn-taking eliminates three classes of bug:
  //   1. Server VAD chopping the transcript on natural pauses.
  //   2. interrupt_response self-canceling when the agent's own audio leaks
  //      into the mic (laptop speakers → built-in mic on the same machine).
  //   3. The model auto-responding before the user has finished thinking.

  const patchManifest = useCallback((patch: Partial<AgentManifest>) => {
    sessionStateRef.current = {
      ...sessionStateRef.current,
      manifest: { ...sessionStateRef.current.manifest, ...patch },
    };
    setManifest({ ...sessionStateRef.current.manifest });
  }, []);

  const startListening = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    // Starting a new turn clears any lingering cancellation state so the
    // next response.* events flow normally — and re-enables playback in
    // case the previous turn was interrupted (which muted the <audio>).
    cancellingRef.current = false;
    handle.setPlaybackMuted(false);
    handle.setMicEnabled(true);
    handle.send({ type: "input_audio_buffer.clear" });
    // Reset transcripts for the new utterance so the bubble starts empty.
    patchManifest({ aura: "listening", userSays: "", agentSays: undefined });
    setIsListening(true);
  }, [patchManifest]);

  const stopListening = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    handle.setMicEnabled(false);
    handle.send({ type: "input_audio_buffer.commit" });
    handle.send({ type: "response.create" });
    patchManifest({ aura: "thinking" });
    setIsListening(false);
  }, [patchManifest]);

  const interruptResponse = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    // Mute the audio element FIRST so the user hears silence immediately —
    // before the network round-trip for response.cancel. The cancellation
    // flag prevents any in-flight transcript deltas from re-inflating the
    // caption while we wait for the official cancelled-response.done.
    cancellingRef.current = true;
    handle.setPlaybackMuted(true);
    handle.send({ type: "response.cancel" });
    // Drop the caption immediately too — visual ack of the interrupt.
    patchManifest({ aura: "idle", agentSays: undefined });
  }, [patchManifest]);

  return {
    manifest,
    startSession,
    endSession,
    startListening,
    stopListening,
    interruptResponse,
    inboundAnalyser,
    outboundAnalyser,
    liveError,
    liveConnected,
    isListening,
  };
}
