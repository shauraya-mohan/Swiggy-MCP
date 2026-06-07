#!/usr/bin/env tsx
// Smoke test for the mock layer.
// Calls every one of the 35 tools, verifies the envelope shape, and prints
// a green/red summary. End-to-end demo flows live in scripts/demo-flow.ts (TBD).
//
// Run with: `npm run test:mocks`

import { callMockTool, MOCK_TOOL_NAMES, store } from "../lib/mock";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

interface TestCase {
  server: "food" | "im" | "dineout";
  tool: string;
  args: Record<string, unknown>;
  expectError?: boolean;
}

const HOME_ADDRESS_ID = "addr_01HXHM";

// Carefully scripted to leave a non-empty cart + at least one order + one booking
// behind, so downstream tools (track_*_order, get_booking_status, etc.) have
// something real to look up.

const FOOD_TESTS: TestCase[] = [
  { server: "food", tool: "get_addresses", args: {} },
  { server: "food", tool: "search_restaurants", args: { addressId: HOME_ADDRESS_ID, query: "biryani" } },
  { server: "food", tool: "search_menu", args: { query: "chicken" } },
  { server: "food", tool: "get_restaurant_menu", args: { restaurantId: "res_001" } },
  {
    server: "food",
    tool: "update_food_cart",
    args: {
      restaurantId: "res_001",
      items: [{ itemId: "item_001", quantity: 1, variantId: "var_001a" }],
    },
  },
  { server: "food", tool: "get_food_cart", args: {} },
  { server: "food", tool: "fetch_food_coupons", args: {} },
  { server: "food", tool: "apply_food_coupon", args: { code: "WELCOME50" } },
  { server: "food", tool: "place_food_order", args: { addressId: HOME_ADDRESS_ID } },
  { server: "food", tool: "get_food_orders", args: {} },
  // Note: get_food_order_details and track_food_order need the orderId from
  // place_food_order — we wire that up dynamically below.
  { server: "food", tool: "flush_food_cart", args: {} },
  {
    server: "food",
    tool: "report_error",
    args: { tool: "search_restaurants", errorMessage: "Synthetic test error" },
  },
];

const INSTAMART_TESTS: TestCase[] = [
  { server: "im", tool: "get_addresses", args: {} },
  {
    server: "im",
    tool: "create_address",
    args: {
      label: "Other",
      display: "Test address — Indiranagar",
      lat: 12.97,
      lng: 77.64,
    },
  },
  { server: "im", tool: "search_products", args: { addressId: HOME_ADDRESS_ID, query: "milk" } },
  { server: "im", tool: "your_go_to_items", args: { addressId: HOME_ADDRESS_ID } },
  {
    server: "im",
    tool: "update_cart",
    args: {
      addressId: HOME_ADDRESS_ID,
      items: [
        { spinId: "spin_milk_1l", quantity: 2 },
        { spinId: "spin_butter_100g", quantity: 1 },
      ],
    },
  },
  { server: "im", tool: "get_cart", args: {} },
  { server: "im", tool: "checkout", args: {} },
  { server: "im", tool: "get_orders", args: {} },
  { server: "im", tool: "clear_cart", args: {} },
  {
    server: "im",
    tool: "report_error",
    args: { tool: "checkout", errorMessage: "Synthetic test error" },
  },
];

const DINEOUT_TESTS: TestCase[] = [
  { server: "dineout", tool: "get_saved_locations", args: {} },
  {
    server: "dineout",
    tool: "search_restaurants_dineout",
    args: { lat: 12.97, lng: 77.64, query: "italian" },
  },
  { server: "dineout", tool: "get_restaurant_details", args: { restaurantId: "din_001" } },
  {
    server: "dineout",
    tool: "get_available_slots",
    args: { restaurantId: "din_001", date: "2026-05-15", guestCount: 4 },
  },
  {
    server: "dineout",
    tool: "create_cart",
    args: {
      restaurantId: "din_001",
      slotId: "slot_TEST",
      guestCount: 4,
    },
  },
  {
    server: "dineout",
    tool: "book_table",
    args: {
      restaurantId: "din_001",
      slotId: "slot_TEST",
      guestCount: 4,
      date: "2026-05-15",
      // 12:30 is deterministically available for din_001 on 2026-05-15
      // under the current RNG seed (restaurantId + dateStr). If the
      // seed logic ever changes, this test will start failing — that's
      // the signal to update both this value and the per-time test
      // group in scripts/test-tool-mapper.ts in lockstep.
      time: "12:30",
    },
  },
  // get_booking_status wired dynamically once book_table returns an id.
  {
    server: "dineout",
    tool: "report_error",
    args: { tool: "book_table", errorMessage: "Synthetic test error" },
  },
];

interface Result {
  case: TestCase;
  ok: boolean;
  detail: string;
}

async function runCase(c: TestCase): Promise<Result> {
  const res = await callMockTool(c.server, c.tool, c.args);
  if (c.expectError) {
    if (!res.success) return { case: c, ok: true, detail: `(expected error) ${res.error.message}` };
    return { case: c, ok: false, detail: "Expected error, got success" };
  }
  if (!res.success) return { case: c, ok: false, detail: res.error.message };
  return {
    case: c,
    ok: true,
    detail: typeof res.data === "object"
      ? `${Array.isArray(res.data) ? `${res.data.length} items` : "ok"}`
      : "ok",
  };
}

async function main() {
  console.log("\n[1/3] Food (14 tools)");
  const foodResults: Result[] = [];
  for (const c of FOOD_TESTS) {
    foodResults.push(await runCase(c));
  }
  // Dynamic: fetch the order we placed and track it.
  const lastFoodOrder = store.orders.find((o) => o.type === "FOOD");
  if (lastFoodOrder) {
    foodResults.push(
      await runCase({
        server: "food",
        tool: "get_food_order_details",
        args: { orderId: lastFoodOrder.orderId },
      }),
    );
    foodResults.push(
      await runCase({
        server: "food",
        tool: "track_food_order",
        args: { orderId: lastFoodOrder.orderId },
      }),
    );
  }
  printResults(foodResults);

  console.log("\n[2/3] Instamart (13 tools)");
  const imResults: Result[] = [];
  let createdAddressId: string | null = null;
  for (const c of INSTAMART_TESTS) {
    const r = await runCase(c);
    imResults.push(r);
    if (r.ok && c.tool === "create_address") {
      const res = await callMockTool("im", "get_addresses", {});
      if (res.success) {
        const data = res.data as Array<{ id: string; label: string }>;
        const created = data.find((a) => a.label === "Other");
        createdAddressId = created?.id ?? null;
      }
    }
  }
  if (createdAddressId) {
    imResults.push(
      await runCase({
        server: "im",
        tool: "delete_address",
        args: { addressId: createdAddressId },
      }),
    );
  }
  const lastImOrder = store.orders.find((o) => o.type === "INSTAMART");
  if (lastImOrder) {
    imResults.push(
      await runCase({
        server: "im",
        tool: "get_order_details",
        args: { orderId: lastImOrder.orderId },
      }),
    );
    imResults.push(
      await runCase({
        server: "im",
        tool: "track_order",
        args: { orderId: lastImOrder.orderId },
      }),
    );
  }
  printResults(imResults);

  console.log("\n[3/3] Dineout (8 tools)");
  const dineResults: Result[] = [];
  for (const c of DINEOUT_TESTS) {
    dineResults.push(await runCase(c));
  }
  const lastBooking = store.bookings[0];
  if (lastBooking) {
    dineResults.push(
      await runCase({
        server: "dineout",
        tool: "get_booking_status",
        args: { bookingId: lastBooking.bookingId },
      }),
    );
  }
  printResults(dineResults);

  // ---- Tool name parity check ----
  console.log("\n[parity] Tool registry counts");
  const expected = { food: 14, im: 13, dineout: 8 };
  let parityOk = true;
  for (const server of ["food", "im", "dineout"] as const) {
    const actual = MOCK_TOOL_NAMES[server].length;
    const exp = expected[server];
    const tag = actual === exp ? `${GREEN}OK${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${tag} ${server}: ${actual} / ${exp}`);
    if (actual !== exp) parityOk = false;
  }

  const totalFailed = [...foodResults, ...imResults, ...dineResults].filter(
    (r) => !r.ok,
  ).length;
  const totalRan = foodResults.length + imResults.length + dineResults.length;

  console.log("");
  if (totalFailed === 0 && parityOk) {
    console.log(`${GREEN}\u2713 All ${totalRan} mock tools returned valid envelopes.${RESET}`);
    process.exit(0);
  } else {
    console.log(`${RED}\u2717 ${totalFailed} of ${totalRan} mock tools failed; parity ok=${parityOk}.${RESET}`);
    process.exit(1);
  }
}

function printResults(results: Result[]) {
  for (const r of results) {
    const tag = r.ok ? `${GREEN}\u2713${RESET}` : `${RED}\u2717${RESET}`;
    console.log(
      `  ${tag} ${r.case.server}/${r.case.tool} ${DIM}\u2014 ${r.detail}${RESET}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
