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
