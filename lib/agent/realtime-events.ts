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
 *
 * Defensive: OpenAI sometimes emits follow-up function_call_arguments.delta
 * events with just call_id + delta (no repeat of `name`). Returning null on
 * missing input lets the reducer fall back to the previously-inferred intent.
 */
export function intentFromToolName(toolName: string | undefined | null): IntentMode | null {
  if (!toolName || typeof toolName !== "string") return null;
  if (toolName.startsWith("food__")) return "order";
  if (toolName.startsWith("im__")) return "cook";
  if (toolName.startsWith("dineout__")) return "dine";
  return null;
}

/**
 * Curated food vocabulary. Shared by COOK ("make/prepare X") and ORDER
 * ("order X") matchers — having a food noun in the object position
 * disambiguates the very-overloaded verbs "make" and "order" from
 * non-food idioms ("make sure", "make a plan", "track my order").
 *
 * Conscious choices:
 *   - Includes meal categories (dinner, lunch, …) so "make dinner" works
 *     without naming a dish.
 *   - Includes Indian dish names (biryani, dal, paneer, …) — primary
 *     audience for Swiggy is India.
 *   - Includes broad placeholders ("food", "something to eat") so the
 *     agent picks up "make us some food" or "order something".
 *   - Excludes ambiguous tokens like "tea" alone (it's also a verb), but
 *     "make tea" + the article gap before it is rare enough not to be
 *     a real problem.
 */
const FOOD_NOUNS =
  String.raw`(?:` +
  // Meal categories
  `dinner|lunch|breakfast|brunch|supper|meal|meals|food|snack|snacks|` +
  `dish|dishes|recipe|recipes|something(?:\\s+to\\s+eat)?|leftovers?|` +
  // Italian / Western
  `pasta|pizza|lasagna|lasagne|risotto|spaghetti|ravioli|gnocchi|` +
  `carbonara|bolognese|alfredo|parmigiana|` +
  `sandwich|sandwiches|sub|wrap|wraps|burger|burgers|fries|salad|salads|` +
  `soup|soups|stew|stews|casserole|chili|` +
  `eggs?|omelette|omelet|pancakes?|waffles?|toast|french\\s+toast|` +
  `oats|oatmeal|porridge|cereal|smoothie|smoothies|juice|tea|coffee|latte|` +
  // Indian
  `biryani|biriyani|curry|curries|dal|daal|paneer|tikka|masala|` +
  `naan|paratha|parathas|roti|samosa|samosas|pakora|pakoras|` +
  `dosa|dosas|idli|idlis|vada|vadas|upma|poha|maggi|` +
  `chai|lassi|raita|chutney|sabzi|sabji|khichdi|rajma|chole|sambar|rasam|` +
  `kebab|kebabs|tikka|tandoori|butter\\s+chicken|chicken\\s+tikka|` +
  // Asian
  `ramen|sushi|dumplings|dim\\s+sum|fried\\s+rice|pho|pad\\s+thai|` +
  `noodles?|stir[-\\s]?fry|teriyaki|chow\\s+mein|spring\\s+rolls?|` +
  // Mexican
  `tacos?|burritos?|quesadillas?|enchiladas?|nachos?|fajitas?|` +
  // Proteins
  `chicken|fish|beef|pork|lamb|mutton|salmon|tuna|prawns?|shrimp|tofu|` +
  // Veg / sides
  `vegetables?|veggies?|veg|rice|bread|breads|buns|rolls|` +
  // Sweets / baked
  `cake|cakes|cookies?|brownies?|muffins?|pies?|tarts?|pudding|halwa|kheer|jalebi|gulab\\s+jamun` +
  `)\\b`;

/** Lead-ins users say before a food-action verb. Optional. */
const LEAD_IN =
  String.raw`(?:let'?s\s+|i'?ll\s+|i\s+want\s+to\s+|i\s+wanna\s+|wanna\s+|gonna\s+|going\s+to\s+|i'?d\s+like\s+to\s+|i'?m\s+gonna\s+|i'?m\s+going\s+to\s+|we\s+(?:should|could|will|can|might|gotta)\s+|let\s+me\s+|how\s+about\s+(?:i|we)\s+)?`;

/**
 * Articles / quantifiers allowed between a food-verb and the food noun.
 * Curated — only words people actually use as determiners or qualifiers
 * on food. "sure", "to", "a plan" don't appear here, so "make sure to
 * order pasta" does NOT match cook (it'd match order instead).
 */
const FOOD_ARTICLE_GAP =
  String.raw`(?:(?:some|a|an|the|us|me|y'?all|everyone|our|own|bit|lot|little|of|whole|good|big|small|tasty|simple|quick|nice|extra|more|fresh|hot|just|family|few|tonight|tomorrow)\s+){0,4}`;

/**
 * intentFromUserText — best-effort keyword sniff over the user's final
 * transcribed utterance. Used to flip the bottom intent pill the *moment*
 * the user states their plan, instead of waiting 1–2s for the model to
 * fire its first tool call.
 *
 * Deliberately narrow & voice-tested: only matches words the user actually
 * says out loud at the intent gateway. The model's own tool calls (via
 * intentFromToolName) override this if they disagree.
 *
 * Returns null when the utterance is ambiguous or unrelated — the existing
 * intent stays put.
 *
 * Precedence: dine → cook → order. Reasoning: "going out" / "book a
 * table" is the most lexically specific signal (one phrase, no ambiguity).
 * Cook is checked next because direct verbs ("cook", "bake", "whip up")
 * leave little doubt. Order is last because its strongest token ("order")
 * is also a noun, so it has the heaviest negative-match logic.
 */
export function intentFromUserText(text: string | undefined | null): IntentMode | null {
  if (!text || typeof text !== "string") return null;
  const t = text.toLowerCase();

  // ===== DINE — heading out / booking / restaurant tonight =====
  //
  // Strong phrases (a table for two, reservation, out for dinner) plus
  // "going/heading out" with a verbal lead-in. Also catches the
  // colloquial patterns users actually say once a dining flow has
  // started — "dinner at Olive tonight", "lunch tomorrow at Toscano",
  // bare "table" — which previously fell through to no intent change
  // because they didn't include "book"/"reserve"/"out".
  if (
    new RegExp(
      String.raw`\b(?:` +
        // Direct dining verbs
        `dine|dining|eat(?:ing)?\\s+out|eats\\s+out` +
        `|` +
        // Booking / reserving
        `book(?:ing)?\\s+a\\s+(?:table|spot)|reserve\\s+a\\s+(?:table|spot)|reservation(?:s)?|table\\s+for\\s+\\w+|make\\s+a\\s+reservation|got\\s+a\\s+reservation` +
        `|` +
        // Bare "(a) table" — rarely used outside dining context.
        // Requires word boundaries on both sides so it doesn't match
        // "kitchen table" / "round table discussion".
        `(?:a\\s+|the\\s+)?table\\s+(?:tonight|today|tomorrow|for|at)` +
        `|` +
        // "(book|find|get|grab) a table"
        `(?:find|get|grab|need|want)\\s+(?:a\\s+|us\\s+a\\s+)?table` +
        `|` +
        // "out for dinner/drinks/etc"
        `out\\s+for\\s+(?:dinner|lunch|drinks?|brunch|a\\s+meal|food|the\\s+night)` +
        `|` +
        // "dinner|lunch|brunch at <place>" — the meal-word + "at"
        // construction is a strong dining signal. The "at" gates it so
        // "for dinner I'll cook" doesn't false-match.
        `(?:dinner|lunch|brunch|drinks)\\s+at\\s+\\w+` +
        `|` +
        // "restaurant tonight" / "night out" / "date night"
        `restaurant\\s+(?:tonight|today|tomorrow)|night\\s+out|date\\s+night` +
        `|` +
        // "going / heading / let's go ... out" — physical movement OUT.
        // Requires the directional "out" particle, with optional "for/to"
        // tail so it doesn't fire on "going to cook" or "head to the
        // shop" (no "out" particle).
        `(?:going|gonna\\s+go|let'?s\\s+go|wanna\\s+go|let\\s+me\\s+go|i\\s+want\\s+to\\s+go|i'?d\\s+like\\s+to\\s+go|head(?:ing)?)\\s+out(?:\\s+(?:for|to))?` +
      `)\\b`,
    ).test(t)
  ) {
    return "dine";
  }

  // ===== COOK — cooking at home =====
  //
  // Three families:
  //   1. Direct cook/bake verbs — no food noun needed
  //   2. Domestic-context phrases (homemade, from scratch, …)
  //   3. "make / prepare / whip up X" + food noun, with a strictly
  //      curated article gap to keep "make sure" / "make a plan" out
  if (
    // 1 + 2 — direct verbs / domestic-context phrases.
    //
    // "whip up" and "cook up" are kept as direct verbs (no food noun
    // required) because they're strongly food-coded — rarely used
    // outside the kitchen. "throw together" and "fix up" are NOT here:
    // they're equally common for non-food ("throw together a slide
    // deck", "fix up the car"), so they need the food-noun arm below.
    new RegExp(
      String.raw`\b(?:` +
        `cook(?:ing|ed|s)?|bak(?:e|es|ed|ing)` +
        `|whip(?:ping)?\\s+up|cook(?:ing)?\\s+up` +
        `|home[-\\s]?cook(?:ed|ing)?|home(?:[-\\s])?made|from\\s+scratch` +
        `|kitchen\\s+(?:tonight|today)|at\\s+home\\s+tonight|cook(?:ing)?\\s+at\\s+home` +
        `|recipe\\s+for|raid(?:ing)?\\s+the\\s+(?:pantry|fridge)` +
      `)\\b`,
    ).test(t) ||
    // 3 — "make/prepare/fix/throw together X" + food noun. This is the
    // arm that handles the bug the user reported ("let's make some
    // pasta"). The strictly-curated FOOD_ARTICLE_GAP makes sure
    // "let's make sure to order pasta" does NOT match here ("sure" is
    // not in the article vocab, so the gap can't bridge to "pasta").
    new RegExp(
      String.raw`\b` + LEAD_IN +
      String.raw`(?:make|making|made|prepare|preparing|prepped|fix(?:ing)?|throw(?:ing)?\s+together)\s+` +
      FOOD_ARTICLE_GAP +
      FOOD_NOUNS,
    ).test(t)
  ) {
    return "cook";
  }

  // ===== ORDER — get food delivered =====
  //
  // "order" is brutally overloaded — as a noun it refers to an EXISTING
  // order (track my order, where's my order, cancel that order). Switching
  // to "order" intent on those phrases is wrong: the user is asking about
  // a past order, not initiating a new one.
  //
  // Hard negatives first: any tracking / status / complaint phrasing
  // containing "order" → null (keep current intent). Catches:
  //   - "track my last order"
  //   - "where's my order"
  //   - "cancel that order"
  //   - "what's the status of my order"
  //   - "any update on my order"
  if (
    /\b(track|tracking|cancel|cancell?ed|status|update|details?|where(\s*'?\s*s)?|complaint|wrong|missing|late|report)\b[^.!?]{0,40}\border(s|ed)?\b/.test(
      t,
    )
  ) {
    return null;
  }

  // Positive match — require verbal context. Bare "order" with no nearby
  // verb is too ambiguous to trust.
  if (
    // "ordering in / takeaway / delivered / get / grab / pick up food"
    /\b(ordering(\s*in)?|takeaway|take\s*out|delivery|delivered|get\s*(some\s*)?food|grab\s+(some\s+)?food|pick\s+up\s+food)\b/.test(
      t,
    ) ||
    // "let's / want to / wanna / gonna order"
    /\b(let'?s|want\s*(to)?|wanna|gonna|going\s*to|need\s*to|plan(ning)?\s*to|gotta|how\s+about\s+we|should\s+we)\s+order\b/.test(
      t,
    ) ||
    // "place an order"
    /\bplace\s+an?\s+order\b/.test(t) ||
    // "order + (in|up|out|food|dinner|lunch|breakfast|…dishes…)" — the
    // food-noun arm uses the shared FOOD_NOUNS vocab plus the original
    // discrete particles for "order in / out / up".
    new RegExp(
      String.raw`\border\s+(?:in|up|out|me|us|something|` +
      // Strip the leading "(?:" from FOOD_NOUNS and trailing ")\b"
      FOOD_NOUNS.slice(3, -3) +
      String.raw`)\b`,
    ).test(t)
  ) {
    return "order";
  }

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
  const type = event.type;

  switch (type) {
    // ---------------- Session lifecycle ----------------
    case "session.created":
    case "session.updated":
      return state;

    // ---------------- User audio (server VAD only — manual mode skips these) ----------------
    case "input_audio_buffer.speech_started":
      return {
        ...state,
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
      const finalText = e.transcript ?? state.manifest.userSays ?? "";
      // Eager intent inference from the user's own words so the bottom pill
      // flips the moment they finish their sentence — without waiting for
      // the first tool call (which lags 1–2s behind in a multi-step flow).
      // Keyword-matching is intentionally narrow + voice-friendly; the
      // model's tool choice still has the final say and will override on
      // any subsequent function_call_arguments event.
      const spokenIntent = intentFromUserText(finalText);
      return {
        ...state,
        intent: spokenIntent ?? state.intent,
        manifest: patchManifest(state.manifest, {
          userSays: finalText,
          intent: spokenIntent ?? state.manifest.intent,
        }),
      };
    }

    // ---------------- Agent response lifecycle ----------------
    case "response.created":
      // A fresh response is starting. If we were already speaking (a
      // previous sub-response in a multi-step tool chain just finished),
      // don't claw the orb back through "thinking" — that's the visible
      // flicker between Instamart cart-add steps. Only flip to thinking
      // from terminal states (idle / listening / success).
      if (
        state.manifest.aura === "speaking" ||
        state.manifest.aura === "thinking"
      ) {
        return state;
      }
      return setAura(state, "thinking");

    case "response.output_item.added":
    case "response.content_part.added":
      // Audio content part is about to stream — pre-emptively flip to
      // speaking so the orb doesn't lag the audio output.
      return setAura(state, "speaking");

    case "response.output_audio.delta":
      // Raw audio bytes are flowing (handled by WebRTC track). Belt-and-
      // braces: ensure aura is speaking even if the transcript delta hasn't
      // landed yet (some models emit audio chunks before the first
      // transcript delta).
      return setAura(state, "speaking");

    case "response.output_audio_transcript.delta":
    case "response.audio_transcript.delta":
    case "response.output_text.delta":
    case "response.text.delta": {
      const e = event as { delta?: string };
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

    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
    case "response.output_text.done":
    case "response.text.done": {
      const e = event as { transcript?: string; text?: string };
      return {
        ...state,
        manifest: patchManifest(state.manifest, {
          agentSays: e.transcript ?? e.text ?? state.manifest.agentSays,
        }),
      };
    }

    case "response.output_audio.done":
    case "response.content_part.done":
    case "response.output_item.done":
      // Intra-response milestones; aura stays speaking until response.done.
      return state;

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
      const done = event as ResponseDoneEvent;
      // Two cases:
      //  (a) Response has function_call items → bridge is about to POST
      //      results + fire another response.create. We're mid-chain;
      //      KEEP the current aura state (whatever audio events left
      //      it at) so the orb doesn't blink to a different visual
      //      treatment between sub-responses. The freq bins will decay
      //      naturally during the silent gap because the audio
      //      analyser reports zero energy.
      //  (b) Response has only message content (or empty output) →
      //      this is the true end of the turn. Settle to idle.
      const output = done.response?.output ?? [];
      const hasToolCall = output.some((it) => it.type === "function_call");
      if (hasToolCall) {
        return state;
      }
      return {
        ...state,
        manifest: patchManifest(state.manifest, { aura: "idle" }),
      };
    }

    // ---------------- Errors ----------------
    case "error":
      return setAura(state, "idle");

    default:
      // Forward-compatible safety net. ANY response.*.delta that we didn't
      // explicitly enumerate (new event types in future API versions) still
      // gets treated as "the agent is producing output" — so the orb won't
      // freeze on thinking forever if OpenAI ships a new event shape.
      if (typeof type === "string" && type.startsWith("response.") && type.endsWith(".delta")) {
        return setAura(state, "speaking");
      }
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
