/**
 * realtime-events — typed shapes for the subset of OpenAI Realtime server
 * events we care about, plus a pure reducer that folds a stream of those
 * events into an AgentManifest.
 *
 * Source of truth:
 *   https://developers.openai.com/api/docs/guides/realtime-conversations
 *   https://developers.openai.com/api/docs/api-reference/realtime_server_events/
 *
 * We deliberately do NOT type every event variant the server can emit —
 * unknown events fall through the reducer untouched. Add them as we need them.
 *
 * The reducer is intentionally pure (no fetches, no DOM, no timers) so it
 * runs in node for tests. Side effects (tool calls, audio playback) live in
 * lib/agent/live-provider.ts and lib/agent/tool-bridge.ts.
 */

import type { AgentManifest, AuraState, IntentMode } from "@/lib/agent/manifest";
import { IDLE_MANIFEST } from "@/lib/agent/manifest";

// =========================================================================
//  Server event shapes (subset we react to)
// =========================================================================

export interface SessionCreatedEvent {
  type: "session.created";
  session: { id: string };
}

export interface SpeechStartedEvent {
  type: "input_audio_buffer.speech_started";
}

export interface SpeechStoppedEvent {
  type: "input_audio_buffer.speech_stopped";
}

export interface InputTranscriptionDeltaEvent {
  type: "conversation.item.input_audio_transcription.delta";
  delta: string;
}

export interface InputTranscriptionCompletedEvent {
  type: "conversation.item.input_audio_transcription.completed";
  transcript: string;
}

export interface ResponseCreatedEvent {
  type: "response.created";
  response: { id: string };
}

export interface OutputTranscriptDeltaEvent {
  type: "response.output_audio_transcript.delta";
  delta: string;
  response_id?: string;
}

export interface OutputTranscriptDoneEvent {
  type: "response.output_audio_transcript.done";
  transcript: string;
  response_id?: string;
}

export interface FunctionCallArgsDeltaEvent {
  type: "response.function_call_arguments.delta";
  call_id: string;
  name: string;
  delta: string;
}

export interface FunctionCallArgsDoneEvent {
  type: "response.function_call_arguments.done";
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponseDoneEvent {
  type: "response.done";
  response: {
    id: string;
    status: "completed" | "cancelled" | "failed" | "incomplete";
    output?: Array<
      | {
          type: "function_call";
          name: string;
          call_id: string;
          arguments: string;
        }
      | {
          type: "message";
          role: "assistant";
          content?: Array<{ type: string; transcript?: string; text?: string }>;
        }
    >;
  };
}

export interface ErrorEvent {
  type: "error";
  error: { type: string; message: string; code?: string };
}

export type RealtimeServerEvent =
  | SessionCreatedEvent
  | SpeechStartedEvent
  | SpeechStoppedEvent
  | InputTranscriptionDeltaEvent
  | InputTranscriptionCompletedEvent
  | ResponseCreatedEvent
  | OutputTranscriptDeltaEvent
  | OutputTranscriptDoneEvent
  | FunctionCallArgsDeltaEvent
  | FunctionCallArgsDoneEvent
  | ResponseDoneEvent
  | ErrorEvent
  | { type: string; [k: string]: unknown };

// =========================================================================
//  Client event shapes (the few we send back)
// =========================================================================

export interface FunctionCallOutputItemCreate {
  type: "conversation.item.create";
  item: {
    type: "function_call_output";
    call_id: string;
    output: string; // JSON-stringified result
  };
}

export interface ResponseCreateEvent {
  type: "response.create";
  response?: { instructions?: string };
}

export type RealtimeClientEvent =
  | FunctionCallOutputItemCreate
  | ResponseCreateEvent
  | { type: string; [k: string]: unknown };

// =========================================================================
//  Reducer state
// =========================================================================

export interface LiveSessionState {
  manifest: AgentManifest;
  /** Current intent inferred from tool-call patterns. Persists across turns. */
  intent: IntentMode;
  /** When the model is mid-function-call, we hold call_id → accumulated args. */
  pendingCalls: Record<string, { name: string; argsDelta: string }>;
}

export const INITIAL_LIVE_STATE: LiveSessionState = {
  manifest: IDLE_MANIFEST,
  intent: "idle",
  pendingCalls: {},
};

// =========================================================================
//  Helpers
// =========================================================================

/**
 * Map tool names to intent. Heuristic — Step 8 will replace this with a
 * proper "module" abstraction in the system prompt that sets intent
 * explicitly. For now we infer from which Swiggy server the tool came from.
 */
export function intentFromToolName(toolName: string): IntentMode | null {
  if (toolName.startsWith("food__")) return "order";
  if (toolName.startsWith("im__")) return "cook";
  if (toolName.startsWith("dineout__")) return "dine";
  return null;
}

function patchManifest(
  base: AgentManifest,
  patch: Partial<AgentManifest>,
): AgentManifest {
  return { ...base, ...patch };
}

function setAura(state: LiveSessionState, aura: AuraState): LiveSessionState {
  if (state.manifest.aura === aura) return state;
  return { ...state, manifest: patchManifest(state.manifest, { aura }) };
}

// =========================================================================
//  Reducer
// =========================================================================

/**
 * Pure: fold a server event into LiveSessionState. Returns a new state
 * (never mutates). Unknown events return the state unchanged.
 *
 * Aura state machine:
 *   speech_started        → 'listening'
 *   speech_stopped        → 'thinking'
 *   response.created      → 'thinking' (still — model is composing)
 *   transcript.delta      → 'speaking' (first audible token = speaking)
 *   response.done(ok)     → 'idle'      (turn complete; UI may flip to 'success' transiently)
 *   response.done(error)  → 'idle'
 *
 * Transcript fields:
 *   userSays   — set on input_audio_transcription deltas + completed
 *   agentSays  — set on response.output_audio_transcript deltas + done
 */
export function reduceEvent(
  state: LiveSessionState,
  event: RealtimeServerEvent,
): LiveSessionState {
  switch (event.type) {
    // ---------------- Session lifecycle ----------------
    case "session.created":
      return state;

    // ---------------- User audio ----------------
    case "input_audio_buffer.speech_started":
      return {
        ...setAura(state, "listening"),
        manifest: patchManifest(state.manifest, {
          aura: "listening",
          userSays: "",
          agentSays: undefined,
        }),
      };

    case "input_audio_buffer.speech_stopped":
      return setAura(state, "thinking");

    // ---------------- User transcript ----------------
    case "conversation.item.input_audio_transcription.delta": {
      const e = event as InputTranscriptionDeltaEvent;
      const prev = state.manifest.userSays ?? "";
      return {
        ...state,
        manifest: patchManifest(state.manifest, {
          userSays: prev + (e.delta ?? ""),
        }),
      };
    }

    case "conversation.item.input_audio_transcription.completed": {
      const e = event as InputTranscriptionCompletedEvent;
      return {
        ...state,
        manifest: patchManifest(state.manifest, {
          userSays: e.transcript ?? state.manifest.userSays,
        }),
      };
    }

    // ---------------- Agent response ----------------
    case "response.created":
      // Stay in thinking; will flip to speaking on first transcript delta.
      return setAura(state, "thinking");

    case "response.output_audio_transcript.delta": {
      const e = event as OutputTranscriptDeltaEvent;
      const prev = state.manifest.agentSays ?? "";
      const next = prev + (e.delta ?? "");
      return {
        ...state,
        manifest: patchManifest(state.manifest, {
          aura: "speaking",
          agentSays: next,
        }),
      };
    }

    case "response.output_audio_transcript.done": {
      const e = event as OutputTranscriptDoneEvent;
      return {
        ...state,
        manifest: patchManifest(state.manifest, {
          agentSays: e.transcript ?? state.manifest.agentSays,
        }),
      };
    }

    // ---------------- Tool calls ----------------
    case "response.function_call_arguments.delta": {
      const e = event as FunctionCallArgsDeltaEvent;
      const inferred = intentFromToolName(e.name);
      const prev = state.pendingCalls[e.call_id] ?? { name: e.name, argsDelta: "" };
      return {
        ...state,
        intent: inferred ?? state.intent,
        manifest: patchManifest(state.manifest, {
          intent: inferred ?? state.manifest.intent,
        }),
        pendingCalls: {
          ...state.pendingCalls,
          [e.call_id]: { name: e.name, argsDelta: prev.argsDelta + (e.delta ?? "") },
        },
      };
    }

    case "response.function_call_arguments.done": {
      const e = event as FunctionCallArgsDoneEvent;
      const inferred = intentFromToolName(e.name);
      // Drop the pending entry — caller will execute the tool externally.
      const { [e.call_id]: _drop, ...rest } = state.pendingCalls;
      void _drop;
      return {
        ...state,
        intent: inferred ?? state.intent,
        manifest: patchManifest(state.manifest, {
          intent: inferred ?? state.manifest.intent,
        }),
        pendingCalls: rest,
      };
    }

    // ---------------- Turn end ----------------
    case "response.done": {
      // Don't clear transcripts — the UI fades them on next turn.
      const nextAura: AuraState =
        (event as ResponseDoneEvent).response?.status === "completed" ? "idle" : "idle";
      return {
        ...state,
        manifest: patchManifest(state.manifest, { aura: nextAura }),
      };
    }

    // ---------------- Errors ----------------
    case "error":
      return setAura(state, "idle");

    default:
      return state;
  }
}

/**
 * Extract any function_call items from a response.done payload. The browser
 * uses this to relay results back through the data channel.
 */
export function extractFunctionCalls(event: ResponseDoneEvent): Array<{
  call_id: string;
  name: string;
  arguments: string;
}> {
  const out = event.response?.output ?? [];
  return out
    .filter((o): o is Extract<typeof o, { type: "function_call" }> => o.type === "function_call")
    .map((o) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments }));
}
