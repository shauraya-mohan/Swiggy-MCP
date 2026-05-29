"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentManifest, IntentMode } from "@/lib/agent/manifest";
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
import { cardFromToolResult, syncCartCards, upsertCards } from "@/lib/agent/tool-card-mapper";
import {
  armForInterrupt,
  armForListening,
  armForResponse,
} from "@/lib/agent/turn-control";
import { parseToolHandle } from "@/lib/mcp/router";
import type { SwiggyResponse } from "@/lib/mock/types";

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
 *   5. Tool results pass through cardFromToolResult (lib/agent/tool-card-mapper)
 *      to patch the manifest's cards / negotiator / confirm fields, so the
 *      panel beside the orb reflects whatever the agent just fetched.
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
  /**
   * True while real audio energy is being heard from OpenAI's inbound track.
   * Latches false only after ~500 ms of silence so brief pauses inside a
   * sentence don't flip the orb / button to "idle" prematurely. Sourced from
   * the inbound AnalyserNode, gated off when playback is muted by an
   * interrupt — guaranteed to mirror what the user actually hears.
   */
  agentAudible: boolean;
}

export function useLiveProvider(): LiveProviderState {
  const [manifest, setManifest] = useState<AgentManifest>(IDLE_MANIFEST);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [inboundAnalyser, setInboundAnalyser] = useState<AnalyserNode | null>(null);
  const [outboundAnalyser, setOutboundAnalyser] = useState<AnalyserNode | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [agentAudible, setAgentAudible] = useState(false);
  const agentAudibleRef = useRef(false);

  // Mutable session refs — kept out of React state to avoid stale closures
  // during the event loop. We never re-create the session on re-render.
  const sessionRef = useRef<SessionHandle | null>(null);
  const sessionStateRef = useRef<LiveSessionState>(INITIAL_LIVE_STATE);
  const startingRef = useRef<boolean>(false);
  // Tracks the previously-seen intent so we can clear the visual panel
  // on cook ↔ order ↔ dine transitions. Starts as "idle" — the very
  // first intent change (idle → something) doesn't trigger a clear.
  const prevIntentRef = useRef<IntentMode>("idle");
  // Mutation receipt — ConfirmCard auto-dismisses after this fires.
  // setTimeout id is held in a ref so back-to-back mutations cancel the
  // previous timer (each new confirm resets the dismissal countdown).
  const confirmDismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const CONFIRM_DISMISS_MS = 2800;
  // After the user taps Interrupt we send `response.cancel` but tail-end
  // events for that response (deltas already on the wire, the final
  // response.done with status=cancelled) keep arriving for ~200–500 ms.
  // If we let them flow through the reducer the caption keeps growing and
  // the aura flickers back to speaking — visibly contradicting the user's
  // interrupt. cancellingRef gates the reducer until the next user turn.
  const cancellingRef = useRef<boolean>(false);

  // Per-frame poll of the inbound audio analyser to derive `agentAudible`.
  // This is THE source of truth for "the user is currently hearing the
  // agent" — server events arrive ~200–500ms before the local audio buffer
  // finishes playing, so binding the orb / button to server state alone
  // makes them flip to "idle" while audio is still streaming. Hysteresis
  // (3 frames above, 30 frames below — ~50ms attack, ~500ms release)
  // prevents flicker on natural mid-sentence pauses.
  useEffect(() => {
    if (!inboundAnalyser) {
      if (agentAudibleRef.current) {
        agentAudibleRef.current = false;
        setAgentAudible(false);
      }
      return;
    }
    const buf = new Uint8Array(inboundAnalyser.frequencyBinCount);
    const AUDIBLE_THRESHOLD = 8; // mean byte over the FFT bins (0..255)
    const ATTACK_FRAMES = 3;
    const RELEASE_FRAMES = 30;
    let aboveFrames = 0;
    let belowFrames = 0;
    let raf = 0;

    const tick = () => {
      // If a cancel is in flight the audio element is muted — the user
      // hears nothing regardless of what the analyser sees on the
      // upstream WebRTC track. Force not-audible.
      if (cancellingRef.current) {
        if (agentAudibleRef.current) {
          agentAudibleRef.current = false;
          setAgentAudible(false);
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      inboundAnalyser.getByteFrequencyData(buf);
      let total = 0;
      for (let i = 0; i < buf.length; i++) total += buf[i];
      const avg = total / buf.length;

      if (avg > AUDIBLE_THRESHOLD) {
        aboveFrames++;
        belowFrames = 0;
        if (!agentAudibleRef.current && aboveFrames > ATTACK_FRAMES) {
          agentAudibleRef.current = true;
          setAgentAudible(true);
        }
      } else {
        belowFrames++;
        aboveFrames = 0;
        if (agentAudibleRef.current && belowFrames > RELEASE_FRAMES) {
          agentAudibleRef.current = false;
          setAgentAudible(false);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inboundAnalyser]);

  // Intent-change → clear visual panel.
  //
  // Cards/negotiator/confirm persist across the user's turns within a
  // single intent (cooking a meal can take 6+ search calls and 3+
  // confirmations — see the pasta scenario). But when the user pivots
  // between modes (cook → order, order → dine, …) the panel context
  // from the previous mode is stale and confusing — restaurant cards
  // shouldn't sit alongside grocery cards.
  //
  // Only fires on transitions between two distinct non-idle values:
  //   - idle → cook is a fresh start (nothing to clear).
  //   - cook → cook is unchanged (no effect).
  //   - cook → order is a real pivot (clear).
  useEffect(() => {
    const cur = manifest.intent;
    const prev = prevIntentRef.current;
    if (prev !== cur && prev !== "idle" && cur !== "idle") {
      sessionStateRef.current = {
        ...sessionStateRef.current,
        manifest: {
          ...sessionStateRef.current.manifest,
          cards: undefined,
          negotiator: undefined,
          confirm: undefined,
        },
      };
      setManifest({ ...sessionStateRef.current.manifest });
    }
    prevIntentRef.current = cur;
  }, [manifest.intent]);

  const applyEvent = useCallback((event: RealtimeServerEvent) => {
    // Reducer is meant to be pure; if it ever throws (malformed event from
    // upstream, schema drift), don't take down the session — log it and keep
    // going. The Aura/transcript stay on whatever the last good state was.
    try {
      // Lightweight trace — surfaces every event in the browser console so
      // we can verify the wire-level flow when something looks off. Costs
      // nothing in production builds (you can flip it off if it gets noisy).
      if (typeof window !== "undefined") {
        console.debug("[realtime]", event.type);
      }
      // Drop tail-end events from a cancelled response. Errors and session
      // lifecycle events still go through; only response.* state churn is
      // suppressed.
      //
      // Gate lifetime: cancellingRef stays TRUE from interruptResponse()
      // until the user's next stopListening() (i.e., they tap Send to
      // commit a new turn). We deliberately do NOT release it on the
      // cancelled-ack — see commit message for the flicker fix. The gate
      // also forces agentAudible=false in the polling loop below.
      if (cancellingRef.current && typeof event.type === "string" && event.type.startsWith("response.")) {
        if (typeof window !== "undefined") {
          console.debug("[realtime] (cancelled — dropped)", event.type);
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

  // Manifest mutator — used by both push-to-talk turn control and the
  // tool-bridge to merge per-tool card patches. Lives high in the file
  // so handleToolCall (below) and startListening (further down) can
  // close over it without TDZ surprises.
  const patchManifest = useCallback((patch: Partial<AgentManifest>) => {
    sessionStateRef.current = {
      ...sessionStateRef.current,
      manifest: { ...sessionStateRef.current.manifest, ...patch },
    };
    setManifest({ ...sessionStateRef.current.manifest });
  }, []);

  const handleToolCall = useCallback(
    async (call: { call_id: string; name: string; arguments: string }) => {
      const result = await executeToolCall({
        handle: call.name,
        argsJson: call.arguments,
      });

      // ---- Visual surface: tool result → manifest patch ----
      //
      // Two combine modes the mapper can choose between:
      //
      //   "replace" — fresh tool wins. Restaurant searches and delivery
      //     tracking use this: the user is choosing one restaurant, or
      //     tracking one order; the prior set is stale.
      //
      //   "upsert" — merge by card.id. Instamart shopping uses this so
      //     the basket accumulates across multiple searches. Without
      //     this, searching milk after adding garlic would erase the
      //     garlic card mid-flow.
      //
      // Tools without a visual mapping return null — leave the panel alone.
      // Empty-result mappings also return null (don't wipe context just
      // because a follow-up search came up dry). The mapper is wrapped in
      // try/catch so a malformed envelope from a real MCP server can't
      // crash the voice loop.
      try {
        const parsed = parseToolHandle(call.name);
        if (parsed) {
          const patch = cardFromToolResult(
            { server: parsed.server, tool: parsed.tool },
            result.body as SwiggyResponse<unknown>,
          );
          if (patch) {
            const update: Partial<AgentManifest> = {};
            if (patch.cards !== undefined) {
              const mode = patch.cardsMode ?? "replace";
              const prev = sessionStateRef.current.manifest.cards;
              if (mode === "sync-cart") {
                update.cards = syncCartCards(prev, patch.cards);
              } else if (mode === "upsert") {
                update.cards = upsertCards(prev, patch.cards);
              } else {
                update.cards = patch.cards;
              }
            }
            if (patch.negotiator !== undefined) update.negotiator = patch.negotiator;
            if (patch.confirm !== undefined) update.confirm = patch.confirm;
            if (Object.keys(update).length > 0) {
              patchManifest(update);
            }
            // ConfirmCard auto-dismiss. Each new confirm cancels the
            // previous timer and starts fresh — so rapid-fire mutations
            // (agent adding 4 ingredients in a row) all get their full
            // ~3s of screen time before the panel returns to clean.
            if (patch.confirm !== undefined) {
              if (confirmDismissTimerRef.current) {
                clearTimeout(confirmDismissTimerRef.current);
              }
              confirmDismissTimerRef.current = setTimeout(() => {
                sessionStateRef.current = {
                  ...sessionStateRef.current,
                  manifest: { ...sessionStateRef.current.manifest, confirm: undefined },
                };
                setManifest({ ...sessionStateRef.current.manifest });
                confirmDismissTimerRef.current = null;
              }, CONFIRM_DISMISS_MS);
            }
            // Debug breadcrumb so we can verify in DevTools that the
            // mapper is firing and how the panel changed. One line per
            // tool result, easy to scan. Safe in prod (no PII).
            if (typeof window !== "undefined") {
              const summary = (update.cards ?? []).map((c) => {
                if (c.kind === "instamart") {
                  return `im:${c.id}${c.state === "added" ? "*" : ""}`;
                }
                if (c.kind === "restaurant") return `res:${c.id}`;
                return c.kind;
              });
              console.debug(
                `[live][cards] ${call.name} mode=${patch.cardsMode ?? "replace"} → ${summary.length} cards [${summary.join(", ")}]`,
              );
            }
          } else if (typeof window !== "undefined") {
            console.debug(`[live][cards] ${call.name} → null patch (no UI change)`);
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Mapper error";
        console.warn("[live] cardFromToolResult failed for", call.name, "—", message);
      }

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
    [patchManifest],
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
    agentAudibleRef.current = false;
    prevIntentRef.current = "idle";
    if (confirmDismissTimerRef.current) {
      clearTimeout(confirmDismissTimerRef.current);
      confirmDismissTimerRef.current = null;
    }
    setManifest(IDLE_MANIFEST);
    setInboundAnalyser(null);
    setOutboundAnalyser(null);
    setLiveConnected(false);
    setIsListening(false);
    setAgentAudible(false);
  }, []);

  // ---- Push-to-talk turn control ----
  //
  // Manual turn-taking eliminates three classes of bug:
  //   1. Server VAD chopping the transcript on natural pauses.
  //   2. interrupt_response self-canceling when the agent's own audio leaks
  //      into the mic (laptop speakers → built-in mic on the same machine).
  //   3. The model auto-responding before the user has finished thinking.

  const startListening = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    // Wire-level: enable mic + clear input buffer. We deliberately do
    // NOT touch the inbound audio pipeline here — if the previous turn
    // was interrupted, the audio element stays muted and the receiver
    // track stays disabled through this listening phase. armForResponse()
    // (in stopListening) re-arms the pipeline.
    //
    // cancellingRef.current also stays TRUE through this phase — drops
    // any tail-end response.* events still arriving from the cancelled
    // response.
    armForListening(handle);
    // Keep cards / negotiator / confirm intact across the user's turn —
    // a shopping or ordering flow spans many turns (search, confirm,
    // search more, confirm, …) and wiping the visual context on every
    // tap-to-talk erases the basket the user is building. The visual
    // panel only clears on intent change (cook ↔ order ↔ dine, handled
    // by the effect below) or on session end.
    patchManifest({
      aura: "listening",
      userSays: "",
      agentSays: undefined,
    });
    setIsListening(true);
  }, [patchManifest]);

  const stopListening = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    // Re-arm receiver + playback BEFORE releasing the cancellation gate,
    // so the very first response.* event from the new turn flows through
    // an open pipeline. armForResponse also sends commit + response.create.
    armForResponse(handle);
    cancellingRef.current = false;
    patchManifest({ aura: "thinking" });
    setIsListening(false);
  }, [patchManifest]);

  const interruptResponse = useCallback(() => {
    const handle = sessionRef.current;
    if (!handle) return;
    // See lib/agent/turn-control.ts for the rationale on the call order.
    // Two-line summary:
    //   - Receiver disabled + audio element muted = source silenced AND
    //     audio element keeps draining the jitter buffer in real time,
    //     so there's no backlog of cancelled audio sitting around.
    //   - cancellingRef gates the reducer & polling loop until the next
    //     stopListening — preventing any tail-end response.* events from
    //     mutating the manifest or flickering the orb.
    cancellingRef.current = true;
    armForInterrupt(handle);
    // Hard-clear audible too — don't wait one polling-loop frame for the
    // analyser to notice the receiver went quiet. The button needs to
    // flip instantly.
    agentAudibleRef.current = false;
    setAgentAudible(false);
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
    agentAudible,
  };
}
