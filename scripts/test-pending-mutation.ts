#!/usr/bin/env tsx
// Offline tests for lib/agent/pending-mutation.
//
// Covers:
//   - The MUTATION_TOOL_NAMES set is in sync with lib/mcp/manifest.ts
//     (so we never silently miss a new gated tool).
//   - isMutationTool predicate.
//   - buildPendingMutation for all 4 mutation tools, with realistic
//     manifest context (Negotiator slots for booking, cart cards for
//     update_cart/checkout, restaurant cards for place_food_order).
//   - Defensive behaviour: malformed JSON args, missing context,
//     non-mutation tools all handled gracefully.
//   - Time/date formatting helpers (24h → 12h, ISO → "Today/Tomorrow").
//
// Run: `npm run test:pending-mutation`

import {
  buildPendingMutation,
  isMutationTool,
  MUTATION_TOOL_NAMES,
  __test,
} from "../lib/agent/pending-mutation";
import { MUTATION_TOOLS as ROUTER_MUTATIONS, TOOLS } from "../lib/mcp/manifest";
import type { AgentManifest } from "../lib/agent/manifest";
import { IDLE_MANIFEST } from "../lib/agent/manifest";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

// Accepts `boolean | undefined` so optional-chained probes (which widen
// to `boolean | undefined`) pass directly; `undefined` is falsy → fails.
function assert(cond: boolean | undefined, name: string, detail?: string): void {
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
//  1. Mutation set sync — guards against drift between modules
// =========================================================================
//
// If someone adds a new mutating tool to lib/mcp/manifest.ts with
// `isMutation: true` and forgets to update pending-mutation.ts, the
// sheet will silently NOT appear for that tool. This test catches
// that exact regression.

group("1. MUTATION_TOOL_NAMES sync with lib/mcp/manifest.ts");

{
  // ROUTER_MUTATIONS is in colon form ("dineout:book_table"); our set is
  // in OpenAI underscore form ("dineout__book_table"). Convert before
  // comparing.
  const routerSet = new Set(
    ROUTER_MUTATIONS.map((handle) => handle.replace(":", "__")),
  );

  assert(
    routerSet.size === MUTATION_TOOL_NAMES.size,
    "same number of mutating tools",
    `router=${routerSet.size} pending=${MUTATION_TOOL_NAMES.size}`,
  );

  for (const name of routerSet) {
    assert(
      MUTATION_TOOL_NAMES.has(name as never),
      `pending-mutation knows about ${name}`,
    );
  }

  for (const name of MUTATION_TOOL_NAMES) {
    assert(
      routerSet.has(name),
      `${name} is also flagged isMutation in the MCP manifest`,
    );
  }

  // Double-check at the source — every name in our set really does
  // correspond to a tool with isMutation: true. If someone removes
  // isMutation without removing the name, this catches that too.
  for (const name of MUTATION_TOOL_NAMES) {
    const [server, tool] = name.split("__");
    const def = TOOLS.find((t) => t.server === server && t.name === tool);
    assert(def !== undefined, `tool ${name} exists in TOOLS`);
    assert(def?.isMutation === true, `tool ${name} has isMutation: true`);
  }
}

// =========================================================================
//  2. isMutationTool predicate
// =========================================================================

group("2. isMutationTool predicate");

{
  assert(isMutationTool("dineout__book_table"), "dineout__book_table → mutation");
  assert(isMutationTool("im__checkout"), "im__checkout → mutation");
  assert(isMutationTool("food__place_food_order"), "food__place_food_order → mutation");

  // im__update_cart is deliberately NOT gated — it's reversible (you
  // can call again with quantity:0 to undo). The verbal-confirm rule
  // in the system prompt handles that one instead. See the docs on
  // MutationToolName in lib/agent/manifest.ts for the rationale.
  assert(!isMutationTool("im__update_cart"), "im__update_cart → NOT gated (reversible)");

  assert(!isMutationTool("dineout__search_restaurants"), "search → not mutation");
  assert(!isMutationTool("im__search_products"), "im search → not mutation");
  assert(!isMutationTool("food__get_food_orders"), "list orders → not mutation");
  assert(!isMutationTool(""), "empty string → not mutation");
  assert(!isMutationTool("garbage__nonexistent_tool"), "garbage handle → not mutation");
}

// =========================================================================
//  3. Time / date formatting helpers
// =========================================================================

group("3. formatTimeSpoken (24h HH:MM → 12h)");

{
  assert(__test.formatTimeSpoken("19:30") === "7:30 PM", "19:30 → 7:30 PM");
  assert(__test.formatTimeSpoken("07:00") === "7:00 AM", "07:00 → 7:00 AM");
  assert(__test.formatTimeSpoken("12:00") === "12:00 PM", "12:00 → 12:00 PM (noon)");
  assert(__test.formatTimeSpoken("00:00") === "12:00 AM", "00:00 → 12:00 AM (midnight)");
  assert(__test.formatTimeSpoken("23:45") === "11:45 PM", "23:45 → 11:45 PM");

  // Defensive: malformed inputs return unchanged rather than throwing.
  assert(__test.formatTimeSpoken("garbage") === "garbage", "garbage passes through");
  assert(__test.formatTimeSpoken("25:00") === "25:00", "out-of-range hour passes through");
  assert(__test.formatTimeSpoken("") === "", "empty string passes through");
}

group("4. formatDateFriendly (ISO → 'Today' / 'Tomorrow' / 'Sat, Jun 7')");

{
  const today = new Date("2026-06-04T10:00:00");

  assert(
    __test.formatDateFriendly("2026-06-04", today) === "Today",
    "same day → Today",
  );
  assert(
    __test.formatDateFriendly("2026-06-05", today) === "Tomorrow",
    "next day → Tomorrow",
  );
  assert(
    __test.formatDateFriendly("2026-06-03", today) === "Yesterday",
    "previous day → Yesterday",
  );

  // 3 days out — should render the weekday + month/day.
  const formatted = __test.formatDateFriendly("2026-06-07", today);
  assert(
    formatted === "Sun, Jun 7",
    "2026-06-07 → Sun, Jun 7",
    `got: ${formatted}`,
  );

  // Defensive: malformed → returns input.
  assert(
    __test.formatDateFriendly("not-a-date", today) === "not-a-date",
    "garbage passes through",
  );
}

// =========================================================================
//  5. buildPendingMutation — dineout__book_table
// =========================================================================

group("5. buildPendingMutation — dineout__book_table");

{
  const manifest: AgentManifest = {
    ...IDLE_MANIFEST,
    intent: "dine",
    negotiator: {
      headline: "Toscano · DINNER",
      dateLabel: "Tonight",
      slots: [],
      focusedSlotIndex: 0,
      state: "choosing",
    },
  };

  const preview = buildPendingMutation(
    {
      name: "dineout__book_table",
      call_id: "call_001",
      arguments: JSON.stringify({
        restaurantId: "r_toscano",
        slotId: "slot_x",
        guestCount: 4,
        date: "2026-06-04",
        time: "19:30",
        // No specialRequests.
      }),
    },
    manifest,
  );

  assert(preview !== null, "produces a preview");
  assert(preview?.callId === "call_001", "round-trips call_id");
  assert(preview?.toolName === "dineout__book_table", "toolName tag");
  assert(preview?.title === "Confirm Booking", "title is 'Confirm Booking'");
  assert(preview?.subtitle === "Toscano", "restaurant name extracted from Negotiator headline");
  assert(preview?.primaryLabel === "Book Table", "primary button label");

  // Rows: should have one with date+time, one with party size.
  // No specialRequests passed → no notes row.
  const rows = preview?.rows ?? [];
  assert(rows.length === 2, "exactly 2 rows (when+party size)", `got ${rows.length}: ${JSON.stringify(rows)}`);
  // Date label depends on today's date so we can't assert exact, but it should
  // be present and the time should be in 12h form.
  assert(rows[0].includes("7:30 PM"), "first row formats time in 12h (7:30 PM)", `got: ${rows[0]}`);
  assert(rows[1] === "Table for 4", "second row is party size");
}

// With specialRequests.
{
  const preview = buildPendingMutation(
    {
      name: "dineout__book_table",
      call_id: "c2",
      arguments: JSON.stringify({
        restaurantId: "r_toscano",
        slotId: "s",
        guestCount: 2,
        date: "2026-06-04",
        time: "20:00",
        specialRequests: "Window seat please",
      }),
    },
    IDLE_MANIFEST,
  );

  const rows = preview?.rows ?? [];
  assert(
    rows.some((r) => r === "Note: Window seat please"),
    "specialRequests → notes row",
    `rows: ${JSON.stringify(rows)}`,
  );
  // Without Negotiator context, subtitle falls back to a generic.
  assert(
    preview?.subtitle === "Selected restaurant",
    "no Negotiator context → generic subtitle",
    `got: ${preview?.subtitle}`,
  );
}

// =========================================================================
//  6. update_cart is NOT gated (reversible mutation)
// =========================================================================
//
// The sheet should NEVER appear for cart updates — they're handled by
// the verbal-confirm pattern in system prompt rule #6 instead, because
// a sheet on every "+ milk" / "+ eggs" would make shopping feel like
// an interrogation. Lock that in so a future refactor doesn't quietly
// re-add update_cart to the gated set.

group("6. update_cart is NOT gated (reversible)");

{
  const preview = buildPendingMutation(
    {
      name: "im__update_cart",
      call_id: "c1",
      arguments: JSON.stringify({
        addressId: "addr",
        items: [{ spinId: "spin_milk", quantity: 1 }],
      }),
    },
    IDLE_MANIFEST,
  );
  assert(preview === null, "update_cart → null preview (falls through to normal execute)");
}

// =========================================================================
//  7. buildPendingMutation — im__checkout
// =========================================================================

group("7. buildPendingMutation — im__checkout");

{
  const manifest: AgentManifest = {
    ...IDLE_MANIFEST,
    cards: [
      {
        kind: "instamart",
        id: "spin_milk",
        name: "Amul Milk",
        reason: "x",
        pack: "1L",
        price: 60,
        state: "added",
      },
      {
        kind: "instamart",
        id: "spin_eggs",
        name: "Farm Eggs",
        reason: "x",
        pack: "12pc",
        price: 90,
        state: "added",
      },
      // This one isn't added — should NOT appear in the checkout sheet.
      {
        kind: "instamart",
        id: "spin_bread",
        name: "Bread",
        reason: "x",
        pack: "400g",
        price: 40,
      },
    ],
  };

  const preview = buildPendingMutation(
    { name: "im__checkout", call_id: "c1", arguments: "{}" },
    manifest,
  );

  assert(preview?.title === "Place Order", "title is 'Place Order'");
  assert(preview?.subtitle?.includes("Cash on Delivery"), "subtitle mentions COD");
  assert(preview?.cautionary !== undefined, "destructive op → cautionary copy present");
  assert(
    preview?.cautionary?.toLowerCase().includes("cannot be undone") ?? false,
    "cautionary copy warns about irreversibility",
  );

  const rows = preview?.rows ?? [];
  assert(
    rows.some((r) => r.includes("Amul Milk") && r.includes("₹60")),
    "milk row with price",
    `rows: ${JSON.stringify(rows)}`,
  );
  assert(
    rows.some((r) => r.includes("Farm Eggs") && r.includes("₹90")),
    "eggs row with price",
  );
  assert(
    !rows.some((r) => r.includes("Bread")),
    "non-added Bread is NOT in the checkout sheet (only added items count)",
  );
  assert(
    rows.some((r) => r.includes("Total ₹150")),
    "total = 60 + 90 = 150",
    `rows: ${JSON.stringify(rows)}`,
  );
}

// Empty cart fallback.
{
  const preview = buildPendingMutation(
    { name: "im__checkout", call_id: "c2", arguments: "{}" },
    IDLE_MANIFEST,
  );

  assert(preview !== null, "still produces a preview for empty cart");
  assert(
    preview?.rows.some((r) => /Place.*cart/i.test(r)) ?? false,
    "empty cart shows generic fallback row",
    `rows: ${JSON.stringify(preview?.rows)}`,
  );
}

// =========================================================================
//  8. buildPendingMutation — food__place_food_order
// =========================================================================

group("8. buildPendingMutation — food__place_food_order");

{
  const manifest: AgentManifest = {
    ...IDLE_MANIFEST,
    intent: "order",
    cards: [
      {
        kind: "restaurant",
        id: "r_truffles",
        name: "Truffles",
        cuisine: "Continental",
        rating: 4.5,
        etaMinutes: 32,
        price: 350,
        agentPick: { item: "Paneer Sizzler", price: 380 },
        state: "ordered",
      },
      // Two more restaurants — should be ignored since one is "ordered".
      {
        kind: "restaurant",
        id: "r_meghana",
        name: "Meghana Foods",
        cuisine: "Biryani",
        rating: 4.3,
        etaMinutes: 28,
        price: 250,
      },
    ],
  };

  const preview = buildPendingMutation(
    {
      name: "food__place_food_order",
      call_id: "c1",
      arguments: JSON.stringify({ addressId: "addr_home" }),
    },
    manifest,
  );

  assert(preview?.title === "Place Order", "title is 'Place Order'");
  assert(
    preview?.subtitle === "Truffles",
    "subtitle is the 'ordered'-state restaurant (not the first card)",
    `got: ${preview?.subtitle}`,
  );
  assert(preview?.cautionary !== undefined, "destructive op → cautionary copy");

  const rows = preview?.rows ?? [];
  assert(
    rows.some((r) => r.includes("Paneer Sizzler") && r.includes("₹380")),
    "agentPick row with price",
    `rows: ${JSON.stringify(rows)}`,
  );
  assert(
    rows.some((r) => /Total ₹380/.test(r)),
    "total mirrors agentPick price",
  );
  assert(
    rows.some((r) => /ETA/i.test(r)),
    "ETA row present",
  );
}

// No selected restaurant — falls back to first card.
{
  const manifest: AgentManifest = {
    ...IDLE_MANIFEST,
    cards: [
      {
        kind: "restaurant",
        id: "r_meghana",
        name: "Meghana Foods",
        cuisine: "Biryani",
        rating: 4.3,
        etaMinutes: 28,
        price: 250,
      },
    ],
  };

  const preview = buildPendingMutation(
    {
      name: "food__place_food_order",
      call_id: "c2",
      arguments: JSON.stringify({ addressId: "addr" }),
    },
    manifest,
  );

  assert(preview?.subtitle === "Meghana Foods", "first restaurant card used as fallback");
}

// Nothing on screen at all — still produces a (generic) preview.
{
  const preview = buildPendingMutation(
    {
      name: "food__place_food_order",
      call_id: "c3",
      arguments: JSON.stringify({ addressId: "addr" }),
    },
    IDLE_MANIFEST,
  );

  assert(preview !== null, "still produces a preview without any cards");
  assert(preview?.subtitle === undefined, "no subtitle when no restaurant context");
}

// =========================================================================
//  9. Defensive behaviour — non-mutation, malformed JSON, missing args
// =========================================================================

group("9. defensive behaviour");

{
  // Non-mutation tool returns null (caller should fall through to normal execute).
  const preview = buildPendingMutation(
    {
      name: "im__search_products",
      call_id: "x",
      arguments: JSON.stringify({ addressId: "a", query: "milk" }),
    },
    IDLE_MANIFEST,
  );
  assert(preview === null, "non-mutation tool → null");
}

{
  // Malformed JSON args don't crash — preview still renders.
  const preview = buildPendingMutation(
    {
      name: "dineout__book_table",
      call_id: "c1",
      arguments: "{not valid json",
    },
    IDLE_MANIFEST,
  );
  assert(preview !== null, "malformed JSON args → preview still rendered (no crash)");
  assert(
    preview?.title === "Confirm Booking",
    "title still set with malformed args",
  );
}

{
  // Empty args ({}). Should not crash, but preview will have minimal info.
  // Use dineout__book_table — a tool that's still gated AND benefits
  // from defensive handling of missing args.
  const preview = buildPendingMutation(
    { name: "dineout__book_table", call_id: "c1", arguments: "{}" },
    IDLE_MANIFEST,
  );
  assert(preview !== null, "empty args → preview produced");
  assert(
    preview?.title === "Confirm Booking",
    "empty args still produces the right title",
  );
}

{
  // Args is an array instead of an object (model bug). Should not crash.
  const preview = buildPendingMutation(
    {
      name: "dineout__book_table",
      call_id: "c1",
      arguments: JSON.stringify([1, 2, 3]),
    },
    IDLE_MANIFEST,
  );
  assert(preview !== null, "array-shaped args → preview produced (no crash)");
}

// =========================================================================
//  Summary
// =========================================================================

console.log(`\n${passed} passed${failed > 0 ? `, ${R}${failed} failed${X}` : ""}\n`);
if (failed > 0) {
  console.log(`Failures:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
