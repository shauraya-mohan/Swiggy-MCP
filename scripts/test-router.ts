#!/usr/bin/env tsx
// Router-layer tests.
//
// The mock layer is already exhaustively covered by test:scenarios — this
// suite only validates the four things the router itself owns:
//   1. Manifest completeness (every mock tool has a manifest entry, & vice-versa).
//   2. Required-parameter validation.
//   3. LIVE_MUTATIONS kill-switch on the three non-idempotent tools.
//   4. Mode dispatch (mock works; real cleanly fails until Step 4).
//
// Run: `npm run test:router`

import { MOCK_TOOL_NAMES } from "../lib/mock";
import { TOOLS, MUTATION_TOOLS, toolHandle } from "../lib/mcp/manifest";
import { callTool, parseToolHandle, toolsForOpenAI } from "../lib/mcp/router";

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

function section(t: string): void {
  console.log(`\n${Y}${t}${X}`);
}

async function main() {
  console.log("\nKitchen Copilot tool-router tests");
  console.log(`${D}validates manifest, validation, kill-switch, mode dispatch${X}`);

  // -------------------------------------------------------------------------
  // 1. Manifest completeness
  // -------------------------------------------------------------------------
  section("Manifest completeness — every mock tool has a router entry");

  // Build a flat set of every mock-side tool handle
  const mockHandles = new Set<string>();
  for (const [server, names] of Object.entries(MOCK_TOOL_NAMES)) {
    for (const n of names) mockHandles.add(`${server}:${n}`);
  }

  const manifestHandles = new Set(TOOLS.map(toolHandle));
  const missingFromManifest = [...mockHandles].filter((h) => !manifestHandles.has(h));
  const missingFromMocks = [...manifestHandles].filter((h) => !mockHandles.has(h));

  assert(
    missingFromManifest.length === 0,
    "every mock tool is in the manifest",
    missingFromManifest.length ? `missing: ${missingFromManifest.join(", ")}` : `${mockHandles.size} tools`,
  );
  assert(
    missingFromMocks.length === 0,
    "every manifest tool is implemented in the mocks",
    missingFromMocks.length ? `missing: ${missingFromMocks.join(", ")}` : undefined,
  );
  assert(TOOLS.length === 35, "manifest has exactly 35 tools", `${TOOLS.length} present`);

  // Mutation marking
  assert(
    MUTATION_TOOLS.length === 3,
    "exactly 3 mutation tools flagged (food:place_food_order, im:checkout, dineout:book_table)",
    MUTATION_TOOLS.join(", "),
  );
  const expectedMutations = ["food:place_food_order", "im:checkout", "dineout:book_table"];
  assert(
    expectedMutations.every((h) => MUTATION_TOOLS.includes(h)),
    "the right 3 tools are flagged as mutations",
  );

  // -------------------------------------------------------------------------
  // 2. Required-parameter validation
  // -------------------------------------------------------------------------
  section("Required-parameter validation");

  const missingAddr = await callTool({ server: "food", tool: "search_restaurants", args: { query: "biryani" } });
  assert(!missingAddr.success, "search_restaurants without addressId is rejected");
  if (!missingAddr.success) {
    assert(missingAddr.error.code === "MISSING_PARAMETER", "uses MISSING_PARAMETER code", missingAddr.error.code);
    assert(missingAddr.error.message.includes("addressId"), "names the missing param in the message");
  }

  const unknownTool = await callTool({ server: "food", tool: "nuclear_launch", args: {} });
  assert(!unknownTool.success, "unknown tool is rejected");
  if (!unknownTool.success) {
    assert(unknownTool.error.code === "UNKNOWN_TOOL", "uses UNKNOWN_TOOL code");
  }

  // Tools with no required params accept empty args
  const okEmpty = await callTool({ server: "food", tool: "get_addresses", args: {} });
  assert(okEmpty.success, "get_addresses with empty args succeeds (no required params)");

  // -------------------------------------------------------------------------
  // 3. LIVE_MUTATIONS kill-switch
  // -------------------------------------------------------------------------
  section("LIVE_MUTATIONS kill-switch");

  for (const handle of expectedMutations) {
    const [server, tool] = handle.split(":") as ["food" | "im" | "dineout", string];
    // Build minimal valid args for each mutation tool
    let args: Record<string, unknown> = {};
    if (handle === "food:place_food_order") args = { addressId: "addr_01HXHM" };
    if (handle === "dineout:book_table") args = {
      restaurantId: "din_001",
      slotId: "slot_TEST",
      guestCount: 2,
      date: "2026-05-15",
      time: "20:00",
    };

    const blocked = await callTool({ server, tool, args }, { liveMutations: false });
    assert(!blocked.success, `${handle} blocked when LIVE_MUTATIONS=false`);
    if (!blocked.success) {
      assert(blocked.error.code === "DEMO_MODE_BLOCKED", `${handle} returns DEMO_MODE_BLOCKED`);
    }
  }

  // With LIVE_MUTATIONS=true, the request reaches the mock (which may legitimately
  // fail on its own grounds — e.g. empty cart — but no longer with DEMO_MODE_BLOCKED).
  const liveAttempt = await callTool(
    { server: "food", tool: "place_food_order", args: { addressId: "addr_01HXHM" } },
    { liveMutations: true },
  );
  if (!liveAttempt.success) {
    assert(
      liveAttempt.error.code !== "DEMO_MODE_BLOCKED",
      "with LIVE_MUTATIONS=true the kill-switch is lifted",
      liveAttempt.error.code,
    );
  } else {
    assert(true, "with LIVE_MUTATIONS=true a real call reaches the mock");
  }

  // Non-mutation tools never hit the kill-switch
  const readOnly = await callTool({ server: "food", tool: "get_addresses", args: {} }, { liveMutations: false });
  assert(readOnly.success, "read-only tools are never gated by LIVE_MUTATIONS");

  // -------------------------------------------------------------------------
  // 4. Mode dispatch
  // -------------------------------------------------------------------------
  section("Mode dispatch (mock works; real needs a token)");

  const mockCall = await callTool({ server: "food", tool: "get_addresses", args: {} }, { mode: "mock" });
  assert(mockCall.success, "mock mode dispatches to the mock layer");

  const realNoToken = await callTool({ server: "food", tool: "get_addresses", args: {} }, { mode: "real" });
  assert(!realNoToken.success, "real mode without a token is rejected");
  if (!realNoToken.success) {
    assert(realNoToken.error.code === "UNAUTHENTICATED", "real-mode no-token uses UNAUTHENTICATED", realNoToken.error.code);
  }

  // -------------------------------------------------------------------------
  // 5. OpenAI tool surface
  // -------------------------------------------------------------------------
  section("OpenAI Realtime tool surface");

  const openaiTools = toolsForOpenAI();
  assert(openaiTools.length === 35, "exposes all 35 tools to OpenAI", `${openaiTools.length}`);
  assert(
    openaiTools.every((t) => /^(food|im|dineout)__[a-z_]+$/.test(t.name)),
    "tool names use `server__tool` form (no colons — OpenAI disallows)",
  );
  assert(
    openaiTools.every((t) => typeof t.description === "string" && t.description.length >= 20),
    "every tool has a meaningful description (≥20 chars)",
  );

  const parsed = parseToolHandle("dineout__book_table");
  assert(
    parsed?.server === "dineout" && parsed.tool === "book_table",
    "parseToolHandle round-trips correctly",
  );
  assert(parseToolHandle("garbage") === null, "parseToolHandle rejects malformed input");
  assert(parseToolHandle("foo__bar") === null, "parseToolHandle rejects unknown servers");

  // -------------------------------------------------------------------------
  console.log("");
  if (failed === 0) {
    console.log(`${G}\u2713 ${passed} assertions across 5 router checks all green.${X}\n`);
    process.exit(0);
  } else {
    console.log(`${R}\u2717 ${failed} of ${passed + failed} assertions failed:${X}`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
