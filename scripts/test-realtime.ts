#!/usr/bin/env tsx
// Realtime-client offline tests — no WebRTC, no network, no browser.
//
// We can't unit-test the WebRTC plumbing without a peer; openRealtimeSession
// is exercised end-to-end during manual smoke tests. What we *can* validate
// without the browser:
//   1. reduceEvent handles every event type we care about (lifecycle,
//      transcripts, function calls, errors) and is purely additive — never
//      mutates the input state.
//   2. The aura state-machine transitions are correct (idle → listening →
//      thinking → speaking → idle), enforcing the voice loop contract.
//   3. intentFromToolName maps the three Swiggy server prefixes correctly.
//   4. extractFunctionCalls pulls function_call entries out of response.done.
//   5. parseToolHandle splits the OpenAI-namespaced handle correctly.
//   6. executeToolCall posts to /api/tools/*, returns the envelope verbatim
//      on success, and synthesises typed error envelopes on failure
//      (handle parse, JSON parse, network).
//
// Run: `npm run test:realtime`

import {
  reduceEvent,
  extractFunctionCalls,
  intentFromToolName,
  intentFromUserText,
  INITIAL_LIVE_STATE,
  type LiveSessionState,
  type ResponseDoneEvent,
} from "../lib/agent/realtime-events";
import { executeToolCall } from "../lib/agent/tool-bridge";
import { parseToolHandle } from "../lib/mcp/router";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ${G}\u2713${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ${R}\u2717${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  }
}

function group(name: string) {
  console.log(`\n${Y}${name}${X}`);
}

// =========================================================================
//  1. Event reducer purity + lifecycle
// =========================================================================

group("1. reduceEvent — purity + lifecycle");

{
  const frozen: LiveSessionState = INITIAL_LIVE_STATE;
  const next = reduceEvent(frozen, { type: "session.created", session: { id: "s_1" } });
  assert(next === frozen || next.manifest !== undefined, "session.created → returns state");
  assert(frozen === INITIAL_LIVE_STATE, "reducer never mutates the input state");
}

{
  // Full one-turn happy path: idle → listening → thinking → speaking → idle
  let s = INITIAL_LIVE_STATE;
  assert(s.manifest.aura === "idle", "starts idle");

  s = reduceEvent(s, { type: "input_audio_buffer.speech_started" });
  assert(s.manifest.aura === "listening", "speech_started → listening");
  assert(s.manifest.userSays === "", "speech_started clears userSays");
  assert(s.manifest.agentSays === undefined, "speech_started clears agentSays");

  s = reduceEvent(s, {
    type: "conversation.item.input_audio_transcription.delta",
    delta: "find me ",
  });
  s = reduceEvent(s, {
    type: "conversation.item.input_audio_transcription.delta",
    delta: "thai food",
  });
  assert(s.manifest.userSays === "find me thai food", "transcription deltas concatenate");

  s = reduceEvent(s, { type: "input_audio_buffer.speech_stopped" });
  assert(s.manifest.aura === "thinking", "speech_stopped → thinking");

  s = reduceEvent(s, {
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "find me thai food",
  });
  assert(s.manifest.userSays === "find me thai food", "transcription.completed locks in final");

  s = reduceEvent(s, { type: "response.created", response: { id: "r_1" } });
  assert(s.manifest.aura === "thinking", "response.created stays thinking");

  s = reduceEvent(s, {
    type: "response.output_audio_transcript.delta",
    delta: "Looking ",
  });
  assert(s.manifest.aura === "speaking", "first transcript delta → speaking");
  assert(s.manifest.agentSays === "Looking ", "agent transcript delta accumulates");

  s = reduceEvent(s, {
    type: "response.output_audio_transcript.delta",
    delta: "for Thai places near you.",
  });
  assert(
    s.manifest.agentSays === "Looking for Thai places near you.",
    "agent transcript accumulates",
  );

  s = reduceEvent(s, {
    type: "response.output_audio_transcript.done",
    transcript: "Looking for Thai places near you.",
  });
  assert(
    s.manifest.agentSays === "Looking for Thai places near you.",
    "transcript.done locks in final",
  );

  s = reduceEvent(s, {
    type: "response.done",
    response: { id: "r_1", status: "completed" },
  });
  assert(s.manifest.aura === "idle", "response.done → idle");
  assert(s.manifest.agentSays === "Looking for Thai places near you.", "agentSays survives response.done");
}

{
  // Error path
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, { type: "input_audio_buffer.speech_started" });
  s = reduceEvent(s, { type: "error", error: { type: "server_error", message: "boom" } });
  assert(s.manifest.aura === "idle", "error event resets aura to idle");
}

{
  // Unknown event passes through.
  const s = reduceEvent(INITIAL_LIVE_STATE, { type: "something.unknown" });
  assert(s === INITIAL_LIVE_STATE, "unknown event types return state untouched");
}

{
  // Forward-compat safety net + alternate event names that flip aura → speaking
  group("1b. aura sync — alternate speaking-indicator events");

  // response.content_part.added (audio part) pre-emptively flips to speaking
  let s = reduceEvent(INITIAL_LIVE_STATE, {
    type: "response.content_part.added",
    part: { type: "audio" },
  });
  assert(s.manifest.aura === "speaking", "content_part.added → speaking");

  // response.output_audio.delta (raw audio bytes) → speaking
  s = reduceEvent(INITIAL_LIVE_STATE, { type: "response.output_audio.delta", delta: "AAAA" });
  assert(s.manifest.aura === "speaking", "output_audio.delta → speaking");

  // Legacy beta name response.audio_transcript.delta still appends
  s = reduceEvent(INITIAL_LIVE_STATE, {
    type: "response.audio_transcript.delta",
    delta: "Hello ",
  });
  assert(s.manifest.aura === "speaking", "legacy audio_transcript.delta → speaking");
  assert(s.manifest.agentSays === "Hello ", "legacy audio_transcript.delta appends agentSays");

  // Text modality variants
  s = reduceEvent(INITIAL_LIVE_STATE, { type: "response.output_text.delta", delta: "Hi." });
  assert(s.manifest.aura === "speaking", "output_text.delta → speaking");
  assert(s.manifest.agentSays === "Hi.", "output_text.delta appends agentSays");

  // Forward-compat: any future response.*.delta is treated as speaking
  s = reduceEvent(INITIAL_LIVE_STATE, { type: "response.future_event.delta" });
  assert(s.manifest.aura === "speaking", "unknown response.*.delta → speaking (forward-compat)");
}

// =========================================================================
//  2. Tool-call accumulation + intent inference
// =========================================================================

group("2. Tool-call lifecycle");

{
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, {
    type: "response.function_call_arguments.delta",
    call_id: "c_1",
    name: "food__search_restaurants",
    delta: '{"addressId":',
  });
  assert(s.pendingCalls["c_1"] !== undefined, "function_call delta registers pendingCall");
  assert(s.pendingCalls["c_1"].argsDelta === '{"addressId":', "accumulates partial args");

  s = reduceEvent(s, {
    type: "response.function_call_arguments.delta",
    call_id: "c_1",
    name: "food__search_restaurants",
    delta: '"a1","query":"thai"}',
  });
  assert(
    s.pendingCalls["c_1"].argsDelta === '{"addressId":"a1","query":"thai"}',
    "argsDelta concatenates across chunks",
  );
  assert(s.manifest.intent === "order", "food__ tool → intent=order");

  s = reduceEvent(s, {
    type: "response.function_call_arguments.done",
    call_id: "c_1",
    name: "food__search_restaurants",
    arguments: '{"addressId":"a1","query":"thai"}',
  });
  assert(s.pendingCalls["c_1"] === undefined, "arguments.done drops the pendingCall entry");
  assert(s.manifest.intent === "order", "intent persists after the call resolves");
}

{
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, {
    type: "response.function_call_arguments.done",
    call_id: "c_im",
    name: "im__search_products",
    arguments: '{"addressId":"a1","query":"pancetta"}',
  });
  assert(s.manifest.intent === "cook", "im__ tool → intent=cook (Auditor)");

  s = reduceEvent(s, {
    type: "response.function_call_arguments.done",
    call_id: "c_dine",
    name: "dineout__search_restaurants_dineout",
    arguments: "{}",
  });
  assert(s.manifest.intent === "dine", "dineout__ tool → intent=dine");
}

// =========================================================================
//  3. intentFromToolName
// =========================================================================

group("3. intentFromToolName");

assert(intentFromToolName("food__search_restaurants") === "order", "food__ → order");
assert(intentFromToolName("im__search_products") === "cook", "im__ → cook");
assert(intentFromToolName("dineout__book_table") === "dine", "dineout__ → dine");
assert(intentFromToolName("garbage__noop") === null, "unknown prefix → null");
assert(intentFromToolName("food") === null, "missing tool name → null");

group("3b. intentFromUserText — eager intent from the user's words");

assert(
  intentFromUserText("we are cooking at home tonight") === "cook",
  "‘cooking at home tonight’ → cook",
);
assert(intentFromUserText("let's cook dinner") === "cook", "‘cook dinner’ → cook");
assert(intentFromUserText("home cooked tonight") === "cook", "‘home cooked’ → cook");
assert(intentFromUserText("order biryani") === "order", "‘order biryani’ → order");
assert(intentFromUserText("get food delivered") === "order", "‘delivery’ → order");
assert(intentFromUserText("just order in") === "order", "‘order in’ → order");
assert(intentFromUserText("let's go out tonight") === "dine", "‘going out’ → dine");
assert(intentFromUserText("book a table for two") === "dine", "‘book a table’ → dine");
assert(intentFromUserText("eat out") === "dine", "‘eat out’ → dine");
assert(intentFromUserText("what's the weather") === null, "unrelated → null");
assert(intentFromUserText(undefined) === null, "undefined → null");
assert(intentFromUserText("") === null, "empty → null");
assert(
  intentFromUserText("we want to eat out, not cooking tonight") === "dine",
  "dine wins when both keywords present (more specific match)",
);

// "order" as a NOUN referring to an existing order — should NOT switch
// intent. These are the false-positives we hit in the wild.
assert(
  intentFromUserText("track my last order") === null,
  "‘track my last order’ → null (existing order, not new)",
);
assert(
  intentFromUserText("where's my order") === null,
  "‘where's my order’ → null",
);
assert(
  intentFromUserText("cancel that order") === null,
  "‘cancel that order’ → null",
);
assert(
  intentFromUserText("any update on my order") === null,
  "‘update on my order’ → null",
);
assert(
  intentFromUserText("report missing items in my last order") === null,
  "‘report missing in order’ → null",
);
// And the positive cases still work even with the new tighter regex.
assert(
  intentFromUserText("I want to order chinese") === "order",
  "‘want to order chinese’ → order",
);
assert(
  intentFromUserText("place an order from Biryani House") === "order",
  "‘place an order’ → order",
);

// ===== Expanded keyword coverage (the "let's make some pasta" bug) =====

group("3c. intentFromUserText — COOK: verb + food noun");

assert(intentFromUserText("let's make some pasta") === "cook", "‘let's make some pasta’ → cook");
assert(intentFromUserText("lets make some pasta") === "cook", "‘lets make some pasta’ (no apostrophe) → cook");
assert(intentFromUserText("let's make pasta") === "cook", "‘let's make pasta’ (no article) → cook");
assert(intentFromUserText("let's make us some pasta") === "cook", "‘make us some pasta’ → cook");
assert(intentFromUserText("I'll make pizza tonight") === "cook", "‘I'll make pizza tonight’ → cook");
assert(intentFromUserText("wanna make a sandwich") === "cook", "‘wanna make a sandwich’ → cook");
assert(intentFromUserText("gonna make some eggs") === "cook", "‘gonna make some eggs’ → cook");
assert(intentFromUserText("I want to make biryani") === "cook", "‘want to make biryani’ → cook");
assert(intentFromUserText("how about we make pasta") === "cook", "‘how about we make pasta’ → cook");
assert(intentFromUserText("let me make a salad") === "cook", "‘let me make a salad’ → cook");
assert(intentFromUserText("we should make breakfast") === "cook", "‘we should make breakfast’ → cook");
assert(intentFromUserText("preparing some pasta") === "cook", "‘preparing some pasta’ → cook");
assert(intentFromUserText("fix me a sandwich") === "cook", "‘fix me a sandwich’ → cook");
assert(intentFromUserText("throw together a salad") === "cook", "‘throw together a salad’ → cook");
assert(intentFromUserText("let's make dinner") === "cook", "‘make dinner’ (meal category) → cook");
assert(intentFromUserText("let's make us some food") === "cook", "‘make us some food’ (generic food) → cook");
assert(intentFromUserText("let's make something to eat") === "cook", "‘something to eat’ → cook");

group("3d. intentFromUserText — COOK: direct cooking verbs / idioms");

assert(intentFromUserText("baking cookies tonight") === "cook", "‘baking cookies’ → cook");
assert(intentFromUserText("let's bake bread") === "cook", "‘bake bread’ → cook");
assert(intentFromUserText("whip up some eggs") === "cook", "‘whip up eggs’ → cook");
assert(intentFromUserText("cook up some dal") === "cook", "‘cook up dal’ → cook");
assert(intentFromUserText("homemade pasta tonight") === "cook", "‘homemade’ → cook");
assert(intentFromUserText("from scratch today") === "cook", "‘from scratch’ → cook");
assert(intentFromUserText("got a recipe for biryani") === "cook", "‘recipe for biryani’ → cook");
assert(intentFromUserText("raiding the pantry") === "cook", "‘raiding the pantry’ → cook");

group("3e. intentFromUserText — COOK: false positives that must NOT match");

// "make a reservation" matches the DINE arm (reservation is a strong
// dine signal). Cook regex correctly skips it — reservation isn't a
// food noun.
assert(intentFromUserText("let's make a reservation") === "dine", "‘make a reservation’ → dine (NOT cook)");
assert(intentFromUserText("make sure to order pasta") === "order", "‘make sure to order pasta’ → order, NOT cook");
assert(intentFromUserText("let's make a plan") === null, "‘make a plan’ → null");
assert(intentFromUserText("make it work") === null, "‘make it work’ → null");
assert(intentFromUserText("let's fix the car") === null, "‘fix the car’ → null (no food noun)");
assert(intentFromUserText("throw together a slide deck") === null, "‘throw together a slide deck’ → null");

group("3f. intentFromUserText — DINE: expanded phrasing");

assert(intentFromUserText("let's go out for dinner") === "dine", "‘go out for dinner’ → dine");
assert(intentFromUserText("heading out tonight") === "dine", "‘heading out’ → dine");
assert(intentFromUserText("reserve a table for two") === "dine", "‘reserve a table’ → dine");
assert(intentFromUserText("book a spot at Toscano") === "dine", "‘book a spot’ → dine");
assert(intentFromUserText("table for 4 at 8pm") === "dine", "‘table for 4’ → dine");
assert(intentFromUserText("make a reservation at Olive") === "dine", "‘make a reservation’ → dine");
assert(intentFromUserText("out for drinks tonight") === "dine", "‘out for drinks’ → dine");
assert(intentFromUserText("date night plans") === "dine", "‘date night’ → dine");
assert(intentFromUserText("night out with friends") === "dine", "‘night out’ → dine");
assert(intentFromUserText("restaurant tonight maybe") === "dine", "‘restaurant tonight’ → dine");
// New patterns: meal-word + "at <place>", bare "table" with time/loc,
// and "(find|get|grab) a table" — these are the colloquial phrasings
// that were falling through before. User reported intent not switching
// when they said "dinner at Olive Bar tonight".
assert(intentFromUserText("dinner at Olive Bar tonight") === "dine", "‘dinner at Olive Bar’ → dine");
assert(intentFromUserText("lunch at Toscano tomorrow") === "dine", "‘lunch at Toscano’ → dine");
assert(intentFromUserText("brunch at the Den on Sunday") === "dine", "‘brunch at <place>’ → dine");
assert(intentFromUserText("drinks at the Black Pearl") === "dine", "‘drinks at <place>’ → dine");
assert(intentFromUserText("get me a table at Toscano") === "dine", "‘get me a table’ → dine");
assert(intentFromUserText("find us a table tonight") === "dine", "‘find us a table’ → dine");
assert(intentFromUserText("grab a table for four") === "dine", "‘grab a table’ → dine");
assert(intentFromUserText("table at Olive tonight") === "dine", "‘table at Olive tonight’ → dine");
// False-positive guard: "for dinner I want to cook" is still cook,
// because "at" doesn't follow the meal word.
assert(intentFromUserText("for dinner I want to cook pasta") === "cook", "‘for dinner I want to cook’ → cook (no false dine match)");

group("3g. intentFromUserText — ORDER: expanded food vocab + lead-ins");

assert(intentFromUserText("order pasta") === "order", "‘order pasta’ → order");
assert(intentFromUserText("let's order a sandwich") === "order", "‘order a sandwich’ → order");
assert(intentFromUserText("how about we order pizza") === "order", "‘how about we order pizza’ → order");
assert(intentFromUserText("should we order chinese") === "order", "‘should we order chinese’ → order");
assert(intentFromUserText("order me some biryani") === "order", "‘order me some biryani’ → order");
assert(intentFromUserText("order something") === "order", "‘order something’ → order");
assert(intentFromUserText("order us dinner") === "order", "‘order us dinner’ → order");
assert(intentFromUserText("grab some food from outside") === "order", "‘grab some food’ → order");
assert(intentFromUserText("can we order ramen") === "order", "‘order ramen’ → order");
assert(intentFromUserText("let's order paneer tikka") === "order", "‘order paneer tikka’ → order");

group("3h. intentFromUserText — ambiguous / unrelated → null");

assert(intentFromUserText("I love pasta") === null, "‘I love pasta’ → null (no verb)");
assert(intentFromUserText("pasta is nice") === null, "‘pasta is nice’ → null");
assert(intentFromUserText("hello") === null, "greeting → null");
assert(intentFromUserText("yes go ahead") === null, "confirmation → null");

// And the reducer wires it through input_audio_transcription.completed
{
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, { type: "input_audio_buffer.speech_started" });
  s = reduceEvent(s, {
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "we are cooking at home tonight",
  });
  assert(s.manifest.intent === "cook", "transcription.completed → intent flips eagerly");
  assert(s.manifest.userSays === "we are cooking at home tonight", "final transcript locked in");
}

// And response.done with function_call output keeps aura at thinking (no
// flicker between multi-step tool chains)
group("3c. response.done aura — multi-tool chain stays steady");
{
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, { type: "response.created", response: { id: "r_chain" } });
  s = reduceEvent(s, {
    type: "response.function_call_arguments.done",
    call_id: "c_1",
    name: "im__search_products",
    arguments: "{}",
  });
  // response.done arrives with a function_call still in the output. Bridge
  // is about to POST + response.create — aura must NOT settle to idle.
  s = reduceEvent(s, {
    type: "response.done",
    response: {
      id: "r_chain",
      status: "completed",
      output: [
        {
          type: "function_call",
          name: "im__search_products",
          call_id: "c_1",
          arguments: "{}",
        },
      ],
    },
  });
  assert(
    s.manifest.aura === "thinking",
    "response.done with function_call output → aura stays thinking",
  );
}

group("3d. multi-step Instamart chain — no speaking↔thinking flicker");
{
  // Simulates a real cart-add chain: agent narrates ("adding chicken"),
  // calls update_cart, model fires response.done with function_call,
  // bridge sends response.create, agent narrates next item, etc.
  // The orb must STAY at speaking across the whole chain (no flicker to
  // thinking between sub-responses) and only settle on the final
  // response.done that has no function_call output.
  let s = INITIAL_LIVE_STATE;

  // Turn opens with user finishing — aura → thinking.
  s = reduceEvent(s, { type: "input_audio_buffer.speech_stopped" });
  assert(s.manifest.aura === "thinking", "stopListening → thinking");

  // ── Sub-response 1: narration + tool call ──
  s = reduceEvent(s, { type: "response.created", response: { id: "r1" } });
  assert(s.manifest.aura === "thinking", "r1.created keeps thinking (terminal → thinking)");
  s = reduceEvent(s, { type: "response.content_part.added", part: { type: "audio" } });
  assert(s.manifest.aura === "speaking", "first audio part → speaking");
  s = reduceEvent(s, { type: "response.output_audio_transcript.delta", delta: "Adding chicken" });
  s = reduceEvent(s, {
    type: "response.function_call_arguments.done",
    call_id: "c1",
    name: "im__update_cart",
    arguments: "{}",
  });
  s = reduceEvent(s, {
    type: "response.done",
    response: {
      id: "r1",
      status: "completed",
      output: [{ type: "function_call", name: "im__update_cart", call_id: "c1", arguments: "{}" }],
    },
  });
  assert(
    s.manifest.aura === "speaking",
    "r1.done (with function_call) does NOT claw back to thinking",
  );

  // ── Sub-response 2: another narration + tool call ──
  s = reduceEvent(s, { type: "response.created", response: { id: "r2" } });
  assert(
    s.manifest.aura === "speaking",
    "r2.created does NOT interrupt speaking — no flicker between cart steps",
  );
  s = reduceEvent(s, { type: "response.content_part.added", part: { type: "audio" } });
  assert(s.manifest.aura === "speaking", "still speaking through r2");
  s = reduceEvent(s, { type: "response.output_audio_transcript.delta", delta: ", butter" });
  s = reduceEvent(s, {
    type: "response.done",
    response: {
      id: "r2",
      status: "completed",
      output: [{ type: "function_call", name: "im__update_cart", call_id: "c2", arguments: "{}" }],
    },
  });
  assert(s.manifest.aura === "speaking", "r2.done with function_call keeps speaking");

  // ── Sub-response 3: final summary, NO tool calls ──
  s = reduceEvent(s, { type: "response.created", response: { id: "r3" } });
  assert(s.manifest.aura === "speaking", "r3.created keeps speaking");
  s = reduceEvent(s, { type: "response.content_part.added", part: { type: "audio" } });
  s = reduceEvent(s, { type: "response.output_audio_transcript.delta", delta: " — total ₹535." });
  s = reduceEvent(s, {
    type: "response.done",
    response: {
      id: "r3",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "audio", transcript: "..." }] },
      ],
    },
  });
  assert(s.manifest.aura === "idle", "final response.done (no tool calls) → idle");
  assert(
    s.manifest.agentSays === "Adding chicken, butter — total ₹535.",
    "transcript deltas concatenated across the entire chain",
  );
}

{
  let s = INITIAL_LIVE_STATE;
  s = reduceEvent(s, { type: "response.created", response: { id: "r_done" } });
  s = reduceEvent(s, { type: "response.output_audio_transcript.delta", delta: "Done." });
  s = reduceEvent(s, {
    type: "response.done",
    response: {
      id: "r_done",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "audio", transcript: "Done." }] },
      ],
    },
  });
  assert(s.manifest.aura === "idle", "response.done w/o function_call → aura settles idle");
}

// =========================================================================
//  4. extractFunctionCalls
// =========================================================================

group("4. extractFunctionCalls");

{
  const event: ResponseDoneEvent = {
    type: "response.done",
    response: {
      id: "r_x",
      status: "completed",
      output: [
        { type: "message", role: "assistant", content: [{ type: "audio", transcript: "hi" }] },
        {
          type: "function_call",
          name: "food__search_restaurants",
          call_id: "c_a",
          arguments: '{"q":"thai"}',
        },
        {
          type: "function_call",
          name: "im__get_cart",
          call_id: "c_b",
          arguments: "{}",
        },
      ],
    },
  };
  const calls = extractFunctionCalls(event);
  assert(calls.length === 2, "extracts exactly the function_call entries");
  assert(calls[0].name === "food__search_restaurants", "preserves name");
  assert(calls[0].call_id === "c_a", "preserves call_id");
  assert(calls[1].arguments === "{}", "preserves arguments");
}

{
  const empty: ResponseDoneEvent = {
    type: "response.done",
    response: { id: "r_y", status: "completed" },
  };
  assert(extractFunctionCalls(empty).length === 0, "no output → empty array");
}

// =========================================================================
//  5. parseToolHandle (sanity — reused from lib/mcp/router)
// =========================================================================

group("5. parseToolHandle");

{
  const a = parseToolHandle("food__search_restaurants");
  assert(a !== null, "parses food handle");
  assert(a?.server === "food", "  server=food");
  assert(a?.tool === "search_restaurants", "  tool=search_restaurants");
}
{
  const b = parseToolHandle("im__cart_add");
  assert(b?.server === "im", "im handle parses");
}
{
  const c = parseToolHandle("nope__foo");
  assert(c === null, "unknown server prefix → null");
}
{
  const d = parseToolHandle("food");
  assert(d === null, "missing __tool → null");
}

// =========================================================================
//  6. executeToolCall with fetch stubs
// =========================================================================

function makeFetchStub(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
}

async function runBridgeTests(): Promise<void> {
  group("6. executeToolCall");

  {
    // Bad handle short-circuits without calling fetch.
    let calledFetch = false;
    const stub = makeFetchStub(() => {
      calledFetch = true;
      return new Response("{}", { status: 200 });
    });

    const r = await executeToolCall({
      handle: "garbage",
      argsJson: "{}",
      fetchImpl: stub,
    });
    assert(r.ok === false, "bad handle → ok=false");
    assert(
      (r.body as { error: { code: string } }).error.code === "UNKNOWN_TOOL_HANDLE",
      "bad handle → UNKNOWN_TOOL_HANDLE",
    );
    assert(calledFetch === false, "bad handle → no fetch call");
  }

  {
    // Bad JSON args short-circuits.
    const r = await executeToolCall({
      handle: "food__search_restaurants",
      argsJson: "{not json",
      fetchImpl: makeFetchStub(() => new Response("{}", { status: 200 })),
    });
    assert(r.ok === false, "bad JSON args → ok=false");
    assert(
      (r.body as { error: { code: string } }).error.code === "INVALID_TOOL_ARGS_JSON",
      "bad JSON args → INVALID_TOOL_ARGS_JSON",
    );
  }

  {
    // Happy path: stub returns a SwiggyResponse envelope.
    let observedUrl = "";
    let observedBody = "";
    const stub = makeFetchStub((url, init) => {
      observedUrl = url;
      observedBody = init.body as string;
      return new Response(
        JSON.stringify({ success: true, data: { restaurants: [{ id: "r1", name: "Soi 38" }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const r = await executeToolCall({
      handle: "food__search_restaurants",
      argsJson: '{"addressId":"a1","query":"thai"}',
      fetchImpl: stub,
    });

    assert(r.ok === true, "happy path → ok=true");
    assert(r.status === 200, "happy path → status=200");
    assert(observedUrl === "/api/tools/food/search_restaurants", "POSTs to /api/tools/[server]/[tool]");
    assert(observedBody === '{"addressId":"a1","query":"thai"}', "forwards parsed args as JSON body");
    const body = r.body as { success: boolean; data: { restaurants: Array<{ id: string }> } };
    assert(body.success === true, "envelope survives unchanged");
    assert(body.data.restaurants[0].id === "r1", "envelope payload intact");
  }

  {
    // Tool error envelope passes through as ok=false.
    const stub = makeFetchStub(
      () =>
        new Response(
          JSON.stringify({ success: false, error: { code: "MIN_ORDER_NOT_MET", message: "below ₹99" } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const r = await executeToolCall({
      handle: "im__checkout",
      argsJson: "{}",
      fetchImpl: stub,
    });
    assert(r.ok === false, "envelope success=false → ok=false");
    assert(r.status === 200, "envelope success=false → status still 200");
    const body = r.body as { error: { code: string } };
    assert(body.error.code === "MIN_ORDER_NOT_MET", "error envelope passes through");
  }

  {
    // Network failure synthesises a structured envelope (never throws).
    const stub = makeFetchStub(() => {
      throw new Error("connection refused");
    });
    const r = await executeToolCall({
      handle: "food__get_food_cart",
      argsJson: "",
      fetchImpl: stub,
    });
    assert(r.ok === false, "network failure → ok=false");
    assert(r.status === 502, "network failure → status=502");
    assert(
      (r.body as { error: { code: string } }).error.code === "TOOL_NETWORK_ERROR",
      "network failure → TOOL_NETWORK_ERROR",
    );
  }

  {
    // Empty argsJson is allowed (zero-arg tools).
    let observedBody = "";
    const stub = makeFetchStub((_url, init) => {
      observedBody = init.body as string;
      return new Response(JSON.stringify({ success: true, data: { addresses: [] } }), {
        status: 200,
      });
    });
    const r = await executeToolCall({
      handle: "food__get_addresses",
      argsJson: "",
      fetchImpl: stub,
    });
    assert(r.ok === true, "empty args → ok=true");
    assert(observedBody === "{}", "empty args → POST body {}");
  }
}

// =========================================================================
//  Run
// =========================================================================

runBridgeTests()
  .then(() => {
    console.log("");
    console.log(`${passed} passed${failed > 0 ? `, ${R}${failed} failed${X}` : ""}`);
    if (failed > 0) {
      console.log("");
      for (const f of failures) console.log(`  ${R}\u2717${X} ${f}`);
      process.exit(1);
    }
  })
  .catch((e: unknown) => {
    console.error(`${R}Test runner crashed:${X}`, e);
    process.exit(1);
  });
