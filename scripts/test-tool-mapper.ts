#!/usr/bin/env tsx
// Offline tests for lib/agent/tool-card-mapper.
//
// Validates the seam between mock data envelopes and AgentManifest
// card patches. No fetching, no real MCP, no browser.
//
// Run: `npm run test:tool-mapper`

import {
  cardFromToolResult,
  parseEtaMinutes,
  hueFromId,
  smallestInStockVariant,
  variantPackLabel,
  stageFromOrderStatus,
  progressFromOrderStatus,
  statusLine,
  slotBandLabel,
  syncCartCards,
  upsertCards,
  mapAvailableSlots,
} from "../lib/agent/tool-card-mapper";
import type {
  DineoutSlot,
  FoodRestaurant,
  GoToItem,
  Order,
  Product,
  ProductVariant,
  SwiggyResponse,
} from "../lib/mock/types";
import type {
  CardData,
  DeliveryCardData,
  InstamartCardData,
  RestaurantCardData,
} from "../lib/agent/manifest";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

// `cond` accepts `boolean | undefined` so optional-chained probes like
// `patch?.confirm?.title.includes("cart")` (which the compiler widens to
// `boolean | undefined`) can be passed directly. `undefined` is falsy →
// fails the assertion, which is exactly what we want.
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

function ok<T>(data: T): SwiggyResponse<T> {
  return { success: true, data };
}

function fail(message: string, code = "GENERIC"): SwiggyResponse<never> {
  return { success: false, error: { message, code } };
}

// =========================================================================
//  1. Helpers
// =========================================================================

group("1. parseEtaMinutes");

assert(parseEtaMinutes("25-35 MIN") === 30, "midpoint of 25-35 → 30");
assert(parseEtaMinutes("20-30 min") === 25, "lowercase 20-30 min → 25");
assert(parseEtaMinutes("45") === 45, "single value 45 → 45");
assert(parseEtaMinutes("") === 30, "empty fallback → 30");
assert(parseEtaMinutes(undefined) === 30, "undefined fallback → 30");
assert(parseEtaMinutes("about thirty minutes") === 30, "garbage with one number → that number");

group("2. hueFromId");

{
  const a = hueFromId("res_001");
  const b = hueFromId("res_001");
  const c = hueFromId("res_002");
  assert(a === b, "deterministic across calls");
  assert(a !== c, "differs across ids");
  assert(a >= 0 && a < 360, "always in 0..359");
}

group("3. smallestInStockVariant");

{
  const variants: ProductVariant[] = [
    { spinId: "v1kg", name: "1kg", quantity: { value: 1, unit: "kg" }, price: 100, mrp: 120, inStock: true },
    { spinId: "v500g", name: "500g", quantity: { value: 500, unit: "g" }, price: 60, mrp: 70, inStock: true },
    { spinId: "v200g", name: "200g", quantity: { value: 200, unit: "g" }, price: 30, mrp: 35, inStock: true },
  ];
  const pick = smallestInStockVariant(variants);
  assert(pick?.spinId === "v200g", "picks smallest variant (200g)");
}
{
  const variants: ProductVariant[] = [
    { spinId: "v200g", name: "200g", quantity: { value: 200, unit: "g" }, price: 30, mrp: 35, inStock: false },
    { spinId: "v500g", name: "500g", quantity: { value: 500, unit: "g" }, price: 60, mrp: 70, inStock: true },
  ];
  const pick = smallestInStockVariant(variants);
  assert(pick?.spinId === "v500g", "skips out-of-stock 200g, picks 500g");
}
{
  const variants: ProductVariant[] = [
    { spinId: "vd", name: "Dozen", quantity: { value: 12, unit: "piece" }, price: 60, mrp: 70, inStock: false },
    { spinId: "v6", name: "6 pieces", quantity: { value: 6, unit: "piece" }, price: 32, mrp: 40, inStock: false },
  ];
  const pick = smallestInStockVariant(variants);
  assert(pick?.spinId === "v6", "all OOS → fallback to absolute smallest");
}
{
  assert(smallestInStockVariant([]) === null, "empty variants → null");
}
{
  const mixed: ProductVariant[] = [
    { spinId: "vL", name: "1L", quantity: { value: 1, unit: "l" }, price: 60, mrp: 70, inStock: true },
    { spinId: "v500ml", name: "500ml", quantity: { value: 500, unit: "ml" }, price: 32, mrp: 35, inStock: true },
  ];
  const pick = smallestInStockVariant(mixed);
  assert(pick?.spinId === "v500ml", "unit normalisation: 500ml < 1L");
}

group("4. variantPackLabel");

assert(
  variantPackLabel({
    spinId: "v",
    name: "500g pack",
    quantity: { value: 500, unit: "g" },
    price: 30,
    mrp: 35,
    inStock: true,
  }) === "500g pack",
  "uses voice-ready name when present",
);

group("5. order status → DeliveryCard fields");

assert(stageFromOrderStatus("PLACED") === "prep", "PLACED → prep");
assert(stageFromOrderStatus("PREPARING") === "prep", "PREPARING → prep");
assert(stageFromOrderStatus("OUT_FOR_DELIVERY") === "route", "OUT → route");
assert(stageFromOrderStatus("DELIVERED") === "arriving", "DELIVERED → arriving");

assert(progressFromOrderStatus("PLACED") === 0.1, "PLACED progress");
assert(progressFromOrderStatus("DELIVERED") === 1, "DELIVERED progress");
assert(
  progressFromOrderStatus("OUT_FOR_DELIVERY") > progressFromOrderStatus("PREPARING"),
  "monotonic: OUT > PREPARING",
);

{
  const order = {
    orderId: "ord_1",
    type: "FOOD",
    restaurantName: "Biryani House",
    status: "PREPARING",
  } as Order;
  assert(statusLine(order) === "Biryani House · preparing your order", "human status line");
}

group("6. slotBandLabel");

assert(slotBandLabel("LUNCH") === "LUNCH", "passes through known bands");
assert(slotBandLabel("DINNER") === "DINNER", "DINNER");

// =========================================================================
//  Per-tool mappings
// =========================================================================

group("7. cardFromToolResult — error / unknown / null cases");

{
  // Errored envelope → null no matter the tool.
  const r = cardFromToolResult(
    { server: "food", tool: "search_restaurants" },
    fail("Internal error"),
  );
  assert(r === null, "errored envelope → null");
}
{
  // Tool with no visual surface.
  const r = cardFromToolResult({ server: "food", tool: "get_addresses" }, ok([]));
  assert(r === null, "get_addresses → null (no visual)");
}
{
  // Unknown tool.
  const r = cardFromToolResult({ server: "food", tool: "garbage_xyz" }, ok({}));
  assert(r === null, "unknown tool → null");
}
{
  // Right tool, wrong shape → null (graceful, no crash).
  const r = cardFromToolResult(
    { server: "food", tool: "search_restaurants" },
    ok({ restaurants: "not an array" }),
  );
  assert(r === null, "bad shape → null (defensive)");
}

group("8. food__search_restaurants → RestaurantCard[]");

{
  const restaurants: FoodRestaurant[] = [
    {
      id: "res_001",
      name: "Biryani House",
      cuisines: ["Hyderabadi", "Biryani"],
      rating: 4.5,
      distanceKm: 2.1,
      deliveryTimeRange: "25-35 MIN",
      deliveryTimeSpoken: "about thirty minutes",
      availabilityStatus: "OPEN",
      priceForTwo: 400,
      imageUrl: "",
    },
    {
      id: "res_002",
      name: "Paradise",
      cuisines: ["Hyderabadi", "Biryani"],
      rating: 4.3,
      distanceKm: 3.8,
      deliveryTimeRange: "35-45 MIN",
      deliveryTimeSpoken: "about forty minutes",
      availabilityStatus: "OPEN",
      priceForTwo: 500,
      imageUrl: "",
    },
    {
      id: "res_007",
      name: "Meghana",
      cuisines: ["Andhra", "Biryani"],
      rating: 4.5,
      distanceKm: 6.2,
      deliveryTimeRange: "50-60 MIN",
      deliveryTimeSpoken: "about fifty-five minutes",
      availabilityStatus: "OPEN",
      priceForTwo: 550,
      imageUrl: "",
    },
    {
      id: "res_x",
      name: "Lowly Joint",
      cuisines: ["?"],
      rating: 3.0,
      distanceKm: 1,
      deliveryTimeRange: "30-40 MIN",
      deliveryTimeSpoken: "",
      availabilityStatus: "OPEN",
      priceForTwo: 200,
      imageUrl: "",
    },
  ];
  const patch = cardFromToolResult(
    { server: "food", tool: "search_restaurants" },
    ok({ restaurants, nextOffset: null }),
  );
  assert(patch !== null, "patch returned");
  assert(patch?.cards !== undefined, "patch.cards set");
  assert(patch?.cards?.length === 3, "trimmed to top 3");
  assert(patch?.cardsMode === "replace", "restaurant search uses replace mode");
  const ids = patch?.cards?.map((c) => (c as RestaurantCardData).id);
  assert(!ids?.includes("res_x"), "low-rating restaurant dropped");
  const first = patch?.cards?.[0] as RestaurantCardData;
  assert(first.kind === "restaurant", "card kind");
  assert(first.name === "Biryani House" || first.name === "Meghana", "rating-sorted (both at 4.5)");
  assert(typeof first.imageHue === "number", "imageHue derived");
  assert(first.etaMinutes === 30, "ETA midpoint extracted");
}

{
  // Empty restaurant search → null (don't wipe context).
  const patch = cardFromToolResult(
    { server: "food", tool: "search_restaurants" },
    ok({ restaurants: [], nextOffset: null }),
  );
  assert(patch === null, "empty restaurant search → null (no clear)");
}

group("9. im__search_products → InstamartCard[] (MVQ)");

{
  const products: Product[] = [
    {
      id: "prod_onion",
      name: "Onion",
      category: "Vegetables",
      rating: 4.3,
      variants: [
        { spinId: "spin_onion_500g", name: "500g pack", quantity: { value: 500, unit: "g" }, price: 30, mrp: 40, inStock: true },
        { spinId: "spin_onion_1kg", name: "1kg pack", quantity: { value: 1, unit: "kg" }, price: 55, mrp: 70, inStock: true },
      ],
    },
    {
      id: "prod_milk",
      name: "Milk",
      brand: "Amul Gold",
      category: "Dairy",
      rating: 4.6,
      variants: [
        { spinId: "spin_milk_500ml", name: "500ml pack", quantity: { value: 500, unit: "ml" }, price: 32, mrp: 35, inStock: true },
        { spinId: "spin_milk_1l", name: "1L pack", quantity: { value: 1, unit: "l" }, price: 62, mrp: 70, inStock: true },
      ],
    },
  ];
  const patch = cardFromToolResult(
    { server: "im", tool: "search_products" },
    ok({ products, nextOffset: null }),
  );
  assert(patch?.cards !== undefined, "patch.cards set");
  assert(patch?.cards?.length === 2, "two products → two cards");
  assert(patch?.cardsMode === "upsert", "instamart search uses upsert mode");
  const onion = patch?.cards?.find((c) => c.kind === "instamart" && c.id === "prod_onion") as InstamartCardData;
  assert(onion !== undefined, "onion card present");
  assert(onion.pack === "500g pack", "MVQ picked smallest variant (500g)");
  assert(onion.price === 30, "MVQ price reflects 500g variant");
  const milk = patch?.cards?.find((c) => c.kind === "instamart" && c.id === "prod_milk") as InstamartCardData;
  assert(milk.name === "Amul Gold Milk", "brand prefixed to name");
}

{
  // Empty Instamart search → null (no clear). Critical: the agent
  // searches one ingredient at a time; "no tomato" mustn't wipe the
  // garlic/onion already on screen.
  const patch = cardFromToolResult(
    { server: "im", tool: "search_products" },
    ok({ products: [], nextOffset: null }),
  );
  assert(patch === null, "empty Instamart search → null (preserves basket)");
}

{
  // All products OOS with no variants → also null (avoids a useless
  // empty replace and preserves whatever the panel was showing).
  const products: Product[] = [
    { id: "prod_x", name: "Mystery", category: "?", rating: 4, variants: [] },
  ];
  const patch = cardFromToolResult(
    { server: "im", tool: "search_products" },
    ok({ products, nextOffset: null }),
  );
  assert(patch === null, "all variants empty → null (no cards to show)");
}

group("10. im__your_go_to_items → InstamartCard[]");

{
  const items: GoToItem[] = [
    { spinId: "spin_milk_500ml", productName: "Milk", variantName: "500ml pack", price: 32, orderCount: 12 },
    { spinId: "spin_eggs_6", productName: "Eggs", variantName: "6 pieces", price: 48, orderCount: 7 },
  ];
  const patch = cardFromToolResult({ server: "im", tool: "your_go_to_items" }, ok({ items }));
  assert(patch?.cards?.length === 2, "two go-to items → two cards");
  assert(patch?.cardsMode === "upsert", "go-to items use upsert mode");
  const milk = patch?.cards?.[0] as InstamartCardData;
  assert(milk.reason.includes("12"), "reason cites order count");
}

{
  const patch = cardFromToolResult({ server: "im", tool: "your_go_to_items" }, ok({ items: [] }));
  assert(patch === null, "empty go-to list → null (no clear)");
}

group("11. food__track_food_order / im__track_order → DeliveryCard");

{
  const order: Order = {
    orderId: "ord_1",
    type: "FOOD",
    restaurantId: "res_001",
    restaurantName: "Biryani House",
    addressId: "addr_01HXHM",
    status: "PREPARING",
    items: [{ name: "Chicken Biryani", quantity: 1, unitPrice: 349, lineTotal: 349 }],
    subtotal: 349,
    deliveryFee: 30,
    taxes: 18,
    discount: 0,
    total: 397,
    paymentMethod: "COD",
    placedAt: new Date().toISOString(),
    etaMinutes: 28,
  };
  const patch = cardFromToolResult({ server: "food", tool: "track_food_order" }, ok(order));
  assert(patch?.cards?.length === 1, "one delivery card");
  const card = patch?.cards?.[0] as DeliveryCardData;
  assert(card.kind === "delivery", "kind delivery");
  assert(card.etaMinutes === 28, "eta passed through");
  assert(card.stage === "prep", "PREPARING → prep stage");
  assert(card.progress > 0 && card.progress < 1, "progress in (0,1)");
  assert(card.status.includes("Biryani House"), "status line includes restaurant");
}

{
  const order: Order = {
    orderId: "ord_im_1",
    type: "INSTAMART",
    addressId: "addr_01HXHM",
    status: "OUT_FOR_DELIVERY",
    items: [],
    subtotal: 250,
    deliveryFee: 20,
    taxes: 10,
    discount: 0,
    total: 280,
    paymentMethod: "COD",
    placedAt: new Date().toISOString(),
    etaMinutes: 12,
  };
  const patch = cardFromToolResult({ server: "im", tool: "track_order" }, ok(order));
  const card = patch?.cards?.[0] as DeliveryCardData;
  assert(card.stage === "route", "OUT_FOR_DELIVERY → route stage");
  assert(card.status.includes("Instamart"), "INSTAMART order labelled 'Instamart'");
}

group("12. dineout__get_available_slots → Negotiator");

{
  const slots: DineoutSlot[] = [
    { slotId: "s1", date: "2026-05-13", time: "8:00 PM", band: "DINNER", available: false, isFree: false },
    { slotId: "s2", date: "2026-05-13", time: "7:30 PM", band: "DINNER", available: true, isFree: true },
    { slotId: "s3", date: "2026-05-13", time: "8:30 PM", band: "DINNER", available: true, isFree: true },
    { slotId: "s4", date: "2026-05-13", time: "9:00 PM", band: "DINNER", available: true, isFree: false },
  ];
  const patch = cardFromToolResult(
    { server: "dineout", tool: "get_available_slots" },
    ok({ slots }),
  );
  assert(patch?.negotiator !== undefined, "negotiator returned");
  assert(patch?.negotiator?.slots.length === 4, "4 slots in negotiator");
  // Available slots float to the top.
  assert(patch?.negotiator?.slots[0].available === true, "first slot is available");
  assert(patch?.negotiator?.state === "choosing", "starts in choosing state");
  assert(patch?.negotiator?.headline !== undefined, "has a headline");
}

{
  // Empty slots → null (don't wipe the previous negotiator panel).
  const patch = cardFromToolResult(
    { server: "dineout", tool: "get_available_slots" },
    ok({ slots: [] }),
  );
  assert(patch === null, "empty slots → null (no clear)");
}

group("13. mutations / context tools → null");

{
  // Mutations: never visualised here (Step 9 territory).
  for (const handle of [
    { server: "food" as const, tool: "place_food_order" },
    { server: "food" as const, tool: "update_food_cart" },
    { server: "im" as const, tool: "checkout" },
    { server: "im" as const, tool: "update_cart" },
    { server: "dineout" as const, tool: "book_table" },
  ]) {
    const r = cardFromToolResult(handle, ok({ ok: true }));
    assert(r === null, `${handle.server}__${handle.tool} → null`);
  }
}

group("14. upsertCards — merging basket-style card lists");

{
  // Append to empty.
  const out = upsertCards(undefined, [
    { kind: "instamart", id: "p_garlic", name: "Garlic", reason: "", pack: "100g", price: 30 },
  ]);
  assert(out.length === 1, "undefined prev + 1 next → 1 card");
}

{
  // Append new ids.
  const prev: CardData[] = [
    { kind: "instamart", id: "p_garlic", name: "Garlic", reason: "", pack: "100g", price: 30 },
  ];
  const out = upsertCards(prev, [
    { kind: "instamart", id: "p_milk", name: "Milk", reason: "", pack: "1L", price: 60 },
  ]);
  assert(out.length === 2, "garlic + milk → 2 cards");
  assert((out[0] as InstamartCardData).id === "p_garlic", "garlic kept at top (oldest)");
  assert((out[1] as InstamartCardData).id === "p_milk", "milk appended at bottom (newest)");
}

{
  // Refresh existing id in place.
  const prev: CardData[] = [
    { kind: "instamart", id: "p_garlic", name: "Garlic", reason: "old", pack: "100g", price: 30 },
    { kind: "instamart", id: "p_milk", name: "Milk", reason: "", pack: "1L", price: 60 },
  ];
  const out = upsertCards(prev, [
    { kind: "instamart", id: "p_garlic", name: "Garlic", reason: "REFRESHED", pack: "100g", price: 28 },
  ]);
  assert(out.length === 2, "refresh doesn't add a row");
  assert((out[0] as InstamartCardData).id === "p_garlic", "garlic stays in slot 0");
  assert((out[0] as InstamartCardData).reason === "REFRESHED", "garlic data updated");
  assert((out[0] as InstamartCardData).price === 28, "garlic price updated");
  assert((out[1] as InstamartCardData).id === "p_milk", "milk untouched in slot 1");
}

{
  // Mixed kinds upsert (restaurant + instamart by id).
  const prev: CardData[] = [
    { kind: "restaurant", id: "res_001", name: "Biryani House", cuisine: "B", rating: 4.5, etaMinutes: 30, price: 400 },
  ];
  const out = upsertCards(prev, [
    { kind: "instamart", id: "p_milk", name: "Milk", reason: "", pack: "1L", price: 60 },
  ]);
  assert(out.length === 2, "different kinds coexist by id");
}

{
  // Cards with no id (delivery) get appended verbatim, never deduped.
  const prev: CardData[] = [
    { kind: "delivery", etaMinutes: 20, status: "...", progress: 0.5, stage: "route" },
  ];
  const out = upsertCards(prev, [
    { kind: "delivery", etaMinutes: 15, status: "...", progress: 0.7, stage: "route" },
  ]);
  assert(out.length === 2, "delivery cards (no id) append, don't dedupe");
}

// =========================================================================
//  Scenario tests — replay the exact user-reported bug end-to-end
// =========================================================================

group("15. SCENARIO — pasta flow (the bug the user reported)");

{
  // The user's reported flow, replayed against the mapper + upsert
  // helper. Goal: the panel must keep garlic and milk visible across
  // multiple searches and a mutation.

  // Stand-in for the live-provider's "apply a tool patch to cards" step.
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  // Step 1: user says "I'm cooking pasta tonight" → agent searches first
  // ingredient (garlic). Only garlic comes back.
  const garlic: Product = {
    id: "prod_garlic",
    name: "Garlic",
    category: "Vegetables",
    rating: 4.2,
    variants: [
      { spinId: "spin_garlic_100g", name: "100g pack", quantity: { value: 100, unit: "g" }, price: 30, mrp: 35, inStock: true },
    ],
  };
  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: [garlic] }));
  assert(cards?.length === 1, "after garlic search: 1 card");
  assert((cards?.[0] as InstamartCardData).id === "prod_garlic", "garlic on screen");

  // Step 2: agent searches the OTHER ingredients but each returns empty.
  // With the old logic these would WIPE garlic. With the fix they must
  // be no-ops.
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: [] }));
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: [] }));
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: [] }));
  assert(cards?.length === 1, "empty searches DON'T erase garlic");
  assert((cards?.[0] as InstamartCardData).id === "prod_garlic", "garlic still on screen after 3 empty searches");

  // Step 3: user says "yes, add garlic" → agent calls im__update_cart
  // (a mutation). Mutations return null from the mapper; cards stay.
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok({ ok: true }));
  assert(cards?.length === 1, "mutation does not touch cards");
  assert((cards?.[0] as InstamartCardData).id === "prod_garlic", "garlic survives the cart mutation");

  // Step 4: agent realises cart is below ₹99 minimum and searches milk.
  // Two milk products come back. EXPECTED: garlic + 2 milks (3 cards).
  // OLD BUG: only 2 milks (garlic erased).
  const milks: Product[] = [
    {
      id: "prod_amul_milk",
      name: "Milk",
      brand: "Amul Gold",
      category: "Dairy",
      rating: 4.6,
      variants: [
        { spinId: "spin_milk_amul_1l", name: "1L pack", quantity: { value: 1, unit: "l" }, price: 62, mrp: 70, inStock: true },
      ],
    },
    {
      id: "prod_nandini_milk",
      name: "Milk",
      brand: "Nandini",
      category: "Dairy",
      rating: 4.4,
      variants: [
        { spinId: "spin_milk_nandini_500ml", name: "500ml pack", quantity: { value: 500, unit: "ml" }, price: 32, mrp: 35, inStock: true },
      ],
    },
  ];
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: milks }));
  assert(cards?.length === 3, "GARLIC + 2 MILKS = 3 cards (the bug fix)");
  const idsStep4 = cards?.map((c) => (c as InstamartCardData | RestaurantCardData).id) ?? [];
  assert(idsStep4.includes("prod_garlic"), "garlic STILL visible after milk search");
  assert(idsStep4.includes("prod_amul_milk"), "amul milk appeared");
  assert(idsStep4.includes("prod_nandini_milk"), "nandini milk appeared");
  // Order check: garlic at top (oldest), milks at bottom (newest).
  assert((cards?.[0] as InstamartCardData).id === "prod_garlic", "garlic stays at top of panel");

  // Step 5: user says "yes, add the Amul one" → agent calls update_cart
  // again. Cards must remain.
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok({ ok: true }));
  assert(cards?.length === 3, "second mutation also preserves all 3 cards");

  // Step 6: user says "actually double the milk" → another update_cart.
  // Cards must STILL be there (the bug had them vanish on this step).
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok({ ok: true }));
  assert(cards?.length === 3, "doubling quantity preserves all 3 cards (final step of the bug)");
  assert((cards?.[0] as InstamartCardData).id === "prod_garlic", "garlic still at top after 'double the milk'");
}

group("16. SCENARIO — restaurant pivot (food search uses replace, not upsert)");

{
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  // User: "order biryani" → 3 biryani restaurants.
  const biryani: FoodRestaurant[] = [
    { id: "res_bir1", name: "Biryani House", cuisines: ["Biryani"], rating: 4.5, distanceKm: 2, deliveryTimeRange: "25-35 MIN", deliveryTimeSpoken: "", availabilityStatus: "OPEN", priceForTwo: 400, imageUrl: "" },
    { id: "res_bir2", name: "Paradise", cuisines: ["Biryani"], rating: 4.3, distanceKm: 3, deliveryTimeRange: "30-40 MIN", deliveryTimeSpoken: "", availabilityStatus: "OPEN", priceForTwo: 500, imageUrl: "" },
  ];
  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "food", tool: "search_restaurants" }, ok({ restaurants: biryani, nextOffset: null }));
  assert(cards?.length === 2, "2 biryani restaurants on screen");

  // User: "actually pizza" → 1 pizza place. Should REPLACE biryani,
  // not stack on top — restaurants are a "choose one" mental model.
  const pizza: FoodRestaurant[] = [
    { id: "res_piz1", name: "Pizza Plaza", cuisines: ["Pizza"], rating: 4.4, distanceKm: 2.5, deliveryTimeRange: "20-30 MIN", deliveryTimeSpoken: "", availabilityStatus: "OPEN", priceForTwo: 450, imageUrl: "" },
  ];
  cards = applyPatch(cards, { server: "food", tool: "search_restaurants" }, ok({ restaurants: pizza, nextOffset: null }));
  assert(cards?.length === 1, "pizza replaces biryani (1 card)");
  assert((cards?.[0] as RestaurantCardData).id === "res_piz1", "pizza is the only one visible");
}

group("17. SCENARIO — empty pizza search must NOT wipe the biryani panel");

{
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  const biryani: FoodRestaurant[] = [
    { id: "res_bir1", name: "Biryani House", cuisines: ["Biryani"], rating: 4.5, distanceKm: 2, deliveryTimeRange: "25-35 MIN", deliveryTimeSpoken: "", availabilityStatus: "OPEN", priceForTwo: 400, imageUrl: "" },
  ];
  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "food", tool: "search_restaurants" }, ok({ restaurants: biryani, nextOffset: null }));
  // Empty pizza search → mapper returns null → cards unchanged.
  cards = applyPatch(cards, { server: "food", tool: "search_restaurants" }, ok({ restaurants: [], nextOffset: null }));
  assert(cards?.length === 1, "biryani still on screen after empty pizza search");
  assert((cards?.[0] as RestaurantCardData).id === "res_bir1", "no clobber by empty result");
}

group("18. im__update_cart → InstamartCard[] with state='added'");

{
  // The agent has just added milk; the cart response surfaces back
  // as cards so the user SEES what's in their basket — even if the
  // agent skipped a fresh search_products call.
  const cart = {
    addressId: "addr_home",
    items: [
      {
        spinId: "spin_milk_amul_1l",
        productId: "prod_amul_milk",
        productName: "Amul Gold Milk",
        variantName: "1L pack",
        quantity: 1,
        unitPrice: 62,
        lineTotal: 62,
      },
      {
        spinId: "spin_butter_100g",
        productId: "prod_amul_butter",
        productName: "Amul Butter",
        variantName: "100g pack",
        quantity: 2,
        unitPrice: 60,
        lineTotal: 120,
      },
    ],
    subtotal: 182,
    deliveryFee: 25,
    taxes: 9,
    total: 216,
    minOrderMet: true,
  };

  const patch = cardFromToolResult({ server: "im", tool: "update_cart" }, ok(cart));
  assert(patch !== null, "update_cart with items → patch (not null)");
  assert(patch?.cardsMode === "sync-cart", "cardsMode is 'sync-cart' so removals propagate");
  assert(patch?.confirm !== undefined, "update_cart also emits a ConfirmData receipt");
  assert(patch?.confirm?.title.toLowerCase().includes("cart"), "confirm title mentions cart");
  assert(patch?.cards?.length === 2, "2 cart items → 2 cards");
  const milkCard = patch?.cards?.find((c) => (c as InstamartCardData).id === "prod_amul_milk") as
    | InstamartCardData
    | undefined;
  assert(milkCard !== undefined, "milk card present, keyed by productId");
  assert(milkCard?.state === "added", "milk card state='added'");
  assert(milkCard?.pack === "1L pack", "milk card pack is variant name");
  assert(milkCard?.price === 62, "milk card price is unit price");
  assert(milkCard?.reason === "Added to cart", "qty=1 → 'Added to cart'");

  const butterCard = patch?.cards?.find(
    (c) => (c as InstamartCardData).id === "prod_amul_butter",
  ) as InstamartCardData | undefined;
  assert(butterCard?.reason === "Added · ×2", "qty=2 → 'Added · ×2'");
}

group("19. im__get_cart maps the same way as update_cart");

{
  const cart = {
    addressId: null,
    items: [
      {
        spinId: "spin_garlic_100g",
        productId: "prod_garlic",
        productName: "Garlic",
        variantName: "100g pack",
        quantity: 1,
        unitPrice: 30,
        lineTotal: 30,
      },
    ],
    subtotal: 30,
    deliveryFee: 25,
    taxes: 1,
    total: 56,
    minOrderMet: false,
  };

  const patch = cardFromToolResult({ server: "im", tool: "get_cart" }, ok(cart));
  assert(patch?.cards?.length === 1, "get_cart with 1 item → 1 card");
  assert(
    (patch?.cards?.[0] as InstamartCardData).state === "added",
    "get_cart cards also render as 'added'",
  );
}

group("20. empty cart from update_cart → sync-cart patch with 0 cards (drops stale)");

{
  // Empty cart now returns a non-null patch so syncCartCards can DROP
  // existing "added" cards. The user might have removed the last item;
  // the panel must reflect that, not keep stale green cards.
  const emptyCart = {
    addressId: "addr_home",
    items: [],
    subtotal: 0,
    deliveryFee: 0,
    taxes: 0,
    total: 0,
    minOrderMet: false,
  };
  const patch = cardFromToolResult({ server: "im", tool: "update_cart" }, ok(emptyCart));
  assert(patch !== null, "empty cart returns a patch so removals propagate");
  assert(patch?.cardsMode === "sync-cart", "mode is sync-cart");
  assert(patch?.cards?.length === 0, "0 cards in the patch (cart is empty)");
}

group("21. SCENARIO — alfredo flow: search milk, add milk, milk card appears");

{
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  // User: "make alfredo" → agent surfaces butter + cream + garlic.
  const ingredients: Product[] = [
    {
      id: "prod_amul_butter",
      name: "Butter",
      brand: "Amul",
      category: "Dairy",
      rating: 4.6,
      variants: [
        { spinId: "spin_butter_100g", name: "100g pack", quantity: { value: 100, unit: "g" }, price: 60, mrp: 65, inStock: true },
      ],
    },
    {
      id: "prod_amul_cream",
      name: "Fresh Cream",
      brand: "Amul",
      category: "Dairy",
      rating: 4.5,
      variants: [
        { spinId: "spin_cream_200ml", name: "200ml pack", quantity: { value: 200, unit: "ml" }, price: 75, mrp: 80, inStock: true },
      ],
    },
    {
      id: "prod_garlic",
      name: "Garlic",
      brand: "Local",
      category: "Veg",
      rating: 4.2,
      variants: [
        { spinId: "spin_garlic_100g", name: "100g pack", quantity: { value: 100, unit: "g" }, price: 30, mrp: 35, inStock: true },
      ],
    },
  ];

  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: ingredients }));
  assert(cards?.length === 3, "3 ingredient cards on screen");

  // User confirms → agent calls update_cart for the batch. Cards should
  // refresh in place to 'added' state — same ids, just now green.
  const cartAfterBatch = {
    addressId: "addr_home",
    items: ingredients.map((p) => ({
      spinId: p.variants[0].spinId,
      productId: p.id,
      productName: p.name,
      variantName: p.variants[0].name,
      quantity: 1,
      unitPrice: p.variants[0].price,
      lineTotal: p.variants[0].price,
    })),
    subtotal: 165,
    deliveryFee: 25,
    taxes: 8,
    total: 198,
    minOrderMet: true,
  };
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(cartAfterBatch));
  assert(cards?.length === 3, "still 3 cards (sync-cart refreshed, no duplicates)");
  const allAdded = cards?.every((c) => (c as InstamartCardData).state === "added") ?? false;
  assert(allAdded, "all three search cards now show 'added'");

  // User: "actually add milk too" → agent goes STRAIGHT to update_cart
  // (it remembers the spin from an earlier ask-which-pack exchange).
  // The milk card must APPEAR even though there was no search_products
  // call between user-says-yes and update_cart.
  const cartWithMilk = {
    ...cartAfterBatch,
    items: [
      ...cartAfterBatch.items,
      {
        spinId: "spin_milk_amul_1l",
        productId: "prod_amul_milk",
        productName: "Amul Gold Milk",
        variantName: "1L pack",
        quantity: 1,
        unitPrice: 62,
        lineTotal: 62,
      },
    ],
    subtotal: 227,
    total: 263,
  };
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(cartWithMilk));
  assert(cards?.length === 4, "4 cards now (butter, cream, garlic, milk)");
  const milkOnScreen = cards?.some((c) => (c as InstamartCardData).id === "prod_amul_milk") ?? false;
  assert(milkOnScreen, "milk card appears even though there was no fresh search_products");
  const milkOnScreenCard = cards?.find((c) => (c as InstamartCardData).id === "prod_amul_milk") as
    | InstamartCardData
    | undefined;
  assert(milkOnScreenCard?.pack === "1L pack", "milk card shows 1L (the chosen variant)");
  assert(milkOnScreenCard?.state === "added", "milk card is in 'added' state");
}

group("22. SCENARIO — remove garlic mid-flow: garlic card disappears");

{
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  // Start with a cart of 3 items.
  const cartFull = {
    addressId: "addr_home",
    items: [
      { spinId: "spin_butter_100g", productId: "prod_amul_butter", productName: "Butter", variantName: "100g block", quantity: 1, unitPrice: 60, lineTotal: 60 },
      { spinId: "spin_cream_200ml", productId: "prod_amul_cream", productName: "Fresh Cream", variantName: "200ml pack", quantity: 1, unitPrice: 75, lineTotal: 75 },
      { spinId: "spin_garlic_100g", productId: "prod_garlic", productName: "Garlic", variantName: "100g pack", quantity: 1, unitPrice: 30, lineTotal: 30 },
    ],
    subtotal: 165,
    deliveryFee: 25,
    taxes: 8,
    total: 198,
    minOrderMet: true,
  };
  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(cartFull));
  assert(cards?.length === 3, "3 cards initially");
  const allAdded = cards?.every((c) => (c as InstamartCardData).state === "added") ?? false;
  assert(allAdded, "all 3 are 'added'");

  // User: "remove the garlic" → agent issues update_cart with garlic
  // omitted from items (or quantity=0). The mock now returns a cart
  // without garlic. The mapper produces 2 cards (butter, cream) with
  // sync-cart mode. The garlic card must vanish.
  const cartAfterRemove = {
    ...cartFull,
    items: cartFull.items.filter((i) => i.productId !== "prod_garlic"),
    subtotal: 135,
    total: 167,
  };
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(cartAfterRemove));
  assert(cards?.length === 2, "garlic vanishes — 2 cards remain");
  assert(
    !cards?.some((c) => (c as InstamartCardData).id === "prod_garlic"),
    "garlic id is gone from the panel",
  );
  assert(
    cards?.some((c) => (c as InstamartCardData).id === "prod_amul_butter") &&
      cards?.some((c) => (c as InstamartCardData).id === "prod_amul_cream"),
    "butter and cream are still there",
  );

  // Remove everything → empty cart → all cards drop.
  const emptyCart = { ...cartFull, items: [], subtotal: 0, taxes: 0, deliveryFee: 0, total: 0, minOrderMet: false };
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(emptyCart));
  assert(cards?.length === 0, "empty cart → 0 cards on panel");
}

group("23. SCENARIO — search-result cards survive cart sync (still browsing)");

{
  // The user searched for milk but hasn't added it. A separate cart
  // update for OTHER items must not drop the milk search card —
  // the user is still considering it.
  const applyPatch = (
    prev: CardData[] | undefined,
    handle: { server: "food" | "im" | "dineout"; tool: string },
    body: SwiggyResponse<unknown>,
  ): CardData[] | undefined => {
    const patch = cardFromToolResult(handle, body);
    if (!patch || patch.cards === undefined) return prev;
    const mode = patch.cardsMode ?? "replace";
    if (mode === "sync-cart") return syncCartCards(prev, patch.cards);
    if (mode === "upsert") return upsertCards(prev, patch.cards);
    return patch.cards;
  };

  // 1. Search milk → search card (state default).
  const milks: Product[] = [
    {
      id: "prod_milk",
      name: "Milk",
      brand: "Amul",
      category: "Dairy",
      rating: 4.6,
      variants: [
        { spinId: "spin_milk_1l", name: "1L pack", quantity: { value: 1, unit: "l" }, price: 62, mrp: 70, inStock: true },
      ],
    },
  ];
  let cards: CardData[] | undefined = undefined;
  cards = applyPatch(cards, { server: "im", tool: "search_products" }, ok({ products: milks }));
  assert(cards?.length === 1, "milk search card on screen");
  const initialMilk = cards?.[0] as InstamartCardData;
  assert(initialMilk.state !== "added", "milk starts as default (not added)");

  // 2. Cart is updated with butter only (NOT milk).
  const cart = {
    addressId: "addr_home",
    items: [
      { spinId: "spin_butter_100g", productId: "prod_amul_butter", productName: "Butter", variantName: "100g block", quantity: 1, unitPrice: 60, lineTotal: 60 },
    ],
    subtotal: 60,
    deliveryFee: 25,
    taxes: 3,
    total: 88,
    minOrderMet: false,
  };
  cards = applyPatch(cards, { server: "im", tool: "update_cart" }, ok(cart));
  assert(cards?.length === 2, "milk search card SURVIVES; butter added card appears");
  const stillMilk = cards?.find((c) => (c as InstamartCardData).id === "prod_milk") as
    | InstamartCardData
    | undefined;
  assert(stillMilk !== undefined, "milk search card still there");
  assert(stillMilk?.state !== "added", "milk still in default state (not in cart)");
}

group("24. SCENARIO — two variants of same product collapse into one card");

{
  // Real bug-source: if user adds BOTH 500ml and 1L of the same milk
  // product, two cart items with the same productId would generate
  // two React children with the same key, causing one to flicker
  // out or React to warn. The mapper groups by productId.
  const cart = {
    addressId: "addr_home",
    items: [
      { spinId: "spin_milk_500ml", productId: "prod_milk", productName: "Milk", variantName: "500ml pack", quantity: 1, unitPrice: 32, lineTotal: 32 },
      { spinId: "spin_milk_1l", productId: "prod_milk", productName: "Milk", variantName: "1L pack", quantity: 1, unitPrice: 62, lineTotal: 62 },
    ],
    subtotal: 94,
    deliveryFee: 25,
    taxes: 5,
    total: 124,
    minOrderMet: false,
  };
  const patch = cardFromToolResult({ server: "im", tool: "update_cart" }, ok(cart));
  assert(patch?.cards?.length === 1, "both milk variants collapse into ONE card");
  const card = patch?.cards?.[0] as InstamartCardData;
  assert(card.id === "prod_milk", "single card keyed by productId");
  assert(card.pack === "2 packs", "label hints multiple packs");
  assert(card.reason.includes("500ml") && card.reason.includes("1L"), "reason names both variants");
  assert(card.price === 94, "card price = sum of both line totals");
}

group("24b. Negotiator slots — dedupe + slotId + 12h time");

{
  // Mock returns 7 days × 22 slots = 154 slots, many with the same
  // (time, band) on different dates. Without dedupe, the top 5
  // collapses to "12:00 LUNCH" × 5 → duplicate React keys, identical
  // visual cells. The mapper now picks distinct (date, time) pairs.
  const slots: DineoutSlot[] = [
    { slotId: "s1", date: "2026-05-13", time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "s2", date: "2026-05-14", time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "s3", date: "2026-05-15", time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "s4", date: "2026-05-13", time: "12:30", band: "LUNCH", available: true, isFree: true },
    { slotId: "s5", date: "2026-05-14", time: "12:30", band: "LUNCH", available: true, isFree: true },
    { slotId: "s6", date: "2026-05-13", time: "20:00", band: "DINNER", available: true, isFree: true },
  ];
  const patch = cardFromToolResult({ server: "dineout", tool: "get_available_slots" }, ok({ slots }));
  const negSlots = patch?.negotiator?.slots ?? [];
  // Source: 6 raw slots → 3 distinct (time, band) pairs after dedupe.
  // Cap of 5 is just a ceiling; dedup can leave fewer.
  assert(
    negSlots.length === 3 && negSlots.length <= 5,
    "dedup collapses (time, band) duplicates → 3 distinct slots out of 6 raw",
    `got ${negSlots.length}`,
  );
  // No duplicate React keys: every slot has a unique id.
  const ids = new Set(negSlots.map((s) => s.id));
  assert(ids.size === negSlots.length, "all 5 negotiator slots carry distinct ids");
  // 24h time → 12h.
  assert(
    negSlots.every((s) => /\b(AM|PM)\b/.test(s.time)),
    "all times rendered in 12-hour format (e.g. '12:00 PM')",
    negSlots.map((s) => s.time).join(", "),
  );
  // Distinct (time, label) pairs — no "12:00 LUNCH" doubles.
  const pairs = negSlots.map((s) => `${s.time}-${s.label}`);
  const uniquePairs = new Set(pairs);
  assert(
    uniquePairs.size === pairs.length,
    "no duplicate (time, label) pairs across slots",
    pairs.join(", "),
  );
}

group("24c. Negotiator headline reflects actual slot times");

{
  // Dinner-only on today → "Available tonight"
  const today = new Date().toISOString().slice(0, 10);
  const dinnerToday: DineoutSlot[] = [
    { slotId: "d1", date: today, time: "20:00", band: "DINNER", available: true, isFree: true },
    { slotId: "d2", date: today, time: "20:30", band: "DINNER", available: true, isFree: true },
  ];
  let patch = cardFromToolResult({ server: "dineout", tool: "get_available_slots" }, ok({ slots: dinnerToday }));
  assert(
    patch?.negotiator?.headline === "Available tonight",
    "dinner-only today → 'Available tonight'",
    patch?.negotiator?.headline,
  );

  // Lunch-only on today → "Available today · lunch"
  const lunchToday: DineoutSlot[] = [
    { slotId: "l1", date: today, time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "l2", date: today, time: "12:30", band: "LUNCH", available: true, isFree: true },
  ];
  patch = cardFromToolResult({ server: "dineout", tool: "get_available_slots" }, ok({ slots: lunchToday }));
  assert(
    patch?.negotiator?.headline.toLowerCase().includes("lunch"),
    "lunch-only today → headline mentions lunch",
    patch?.negotiator?.headline,
  );
}

group("25. ConfirmData — emitted by every mutation (visual receipts)");

{
  // im__update_cart — already covered in section 18, double-check
  // the empty-cart 'cleared' wording.
  const emptyCart = {
    addressId: "addr_home",
    items: [],
    subtotal: 0,
    deliveryFee: 0,
    taxes: 0,
    total: 0,
    minOrderMet: false,
  };
  const updatePatch = cardFromToolResult({ server: "im", tool: "update_cart" }, ok(emptyCart));
  assert(updatePatch?.confirm?.title.toLowerCase().includes("clear"), "empty cart → 'Cart cleared' confirm");

  // im__checkout — order placed.
  const order = {
    orderId: "ord_abc",
    type: "INSTAMART" as const,
    addressId: "addr_home",
    status: "PLACED" as const,
    items: [{ name: "Garlic 100g", quantity: 1, unitPrice: 30, lineTotal: 30 }],
    subtotal: 30,
    deliveryFee: 25,
    taxes: 2,
    discount: 0,
    total: 57,
    paymentMethod: "COD" as const,
    placedAt: new Date().toISOString(),
    etaMinutes: 12,
    deliveryPartner: { name: "Priya M.", phone: "+91 9000000000" },
  };
  const checkoutPatch = cardFromToolResult({ server: "im", tool: "checkout" }, ok(order));
  assert(checkoutPatch?.confirm !== undefined, "checkout emits a confirm");
  assert(checkoutPatch?.confirm?.title.toLowerCase().includes("placed"), "title mentions 'placed'");
  assert(checkoutPatch?.confirm?.subtitle.toLowerCase().includes("eta"), "subtitle has ETA");
  assert(
    checkoutPatch?.cards?.[0]?.kind === "delivery",
    "checkout also surfaces a delivery card",
  );

  // food__place_food_order — same shape.
  const foodOrder = { ...order, type: "FOOD" as const };
  const foodPatch = cardFromToolResult({ server: "food", tool: "place_food_order" }, ok(foodOrder));
  assert(foodPatch?.confirm?.title.toLowerCase().includes("food"), "food order: 'Food order placed'");

  // food__update_food_cart — receipt only (no cards from this side).
  const foodCart = {
    restaurantId: "res_001",
    restaurantName: "Biryani House",
    items: [{ itemId: "item_001", name: "Chicken Biryani", quantity: 1, unitPrice: 280, lineTotal: 280 }],
    subtotal: 280,
    deliveryFee: 39,
    taxes: 14,
    discount: 0,
    total: 333,
    appliedCoupon: null,
    capExceeded: false,
  };
  const foodCartPatch = cardFromToolResult({ server: "food", tool: "update_food_cart" }, ok(foodCart));
  assert(foodCartPatch?.confirm !== undefined, "food cart update emits a confirm");
  assert(
    foodCartPatch?.confirm?.subtitle.includes("Biryani House"),
    "subtitle names the restaurant",
  );
  assert(foodCartPatch?.cards === undefined, "food cart update does NOT touch the cards slot");

  // dineout__book_table — booking receipt.
  const booking = {
    bookingId: "bk_xyz",
    restaurantId: "res_d001",
    restaurantName: "Toscano",
    slotId: "sl_2000",
    date: "2026-05-15",
    time: "8:00 PM",
    guestCount: 4,
    status: "CONFIRMED" as const,
    bookedAt: new Date().toISOString(),
  };
  const bookingPatch = cardFromToolResult({ server: "dineout", tool: "book_table" }, ok(booking));
  assert(bookingPatch?.confirm !== undefined, "book_table emits a confirm");
  assert(bookingPatch?.confirm?.title.toLowerCase().includes("8:00 pm"), "title carries the time");
  assert(bookingPatch?.confirm?.subtitle.includes("Toscano"), "subtitle names the restaurant");
  assert(bookingPatch?.confirm?.subtitle.includes("4 guests"), "subtitle has party size");
}

group("26. ConfirmData NOT emitted by read-only tools (no false receipts)");

{
  // get_cart is a state read — same payload as update_cart but should
  // NOT flash a confirm. Otherwise every periodic poll would spam
  // receipts.
  const cart = {
    addressId: "addr_home",
    items: [
      { spinId: "spin_butter_100g", productId: "prod_butter", productName: "Butter", variantName: "100g block", quantity: 1, unitPrice: 60, lineTotal: 60 },
    ],
    subtotal: 60,
    deliveryFee: 25,
    taxes: 3,
    total: 88,
    minOrderMet: false,
  };
  const patch = cardFromToolResult({ server: "im", tool: "get_cart" }, ok(cart));
  assert(patch?.cards?.length === 1, "get_cart still syncs the panel");
  assert(patch?.confirm === undefined, "get_cart does NOT flash a confirm receipt");

  // Search tools never flash confirms either.
  const products: Product[] = [
    {
      id: "prod_garlic", name: "Garlic", brand: "Local", category: "Veg", rating: 4.2,
      variants: [{ spinId: "spin_garlic_100g", name: "100g pack", quantity: { value: 100, unit: "g" }, price: 30, mrp: 35, inStock: true }],
    },
  ];
  const searchPatch = cardFromToolResult({ server: "im", tool: "search_products" }, ok({ products }));
  assert(searchPatch?.confirm === undefined, "search_products: no confirm");

  // Tracking is read-only.
  const order = {
    orderId: "ord_abc", type: "INSTAMART" as const, addressId: "addr_home", status: "PREPARING" as const,
    items: [], subtotal: 0, deliveryFee: 0, taxes: 0, discount: 0, total: 0, paymentMethod: "COD" as const,
    placedAt: new Date().toISOString(), etaMinutes: 10,
  };
  const trackPatch = cardFromToolResult({ server: "im", tool: "track_order" }, ok(order));
  assert(trackPatch?.confirm === undefined, "track_order: no confirm (just status)");
}

group("26. Negotiator regression — dinner bias + past-slot filter + date label");

{
  // Repro: user asked for "tonight" at 1:54 PM. Mock returns 7 days
  // × 22 slots starting from today, including 12:00–14:00 LUNCH on
  // today. Old mapper sorted by time ascending and showed lunch
  // slots on a "tonight" request. The fix has three teeth:
  //   1. Filter past-or-imminent slots (12:00 dropped when it's 1 PM).
  //   2. Bias dinner first when asking about today + past 1 PM.
  //   3. Surface the requested date so the user can verify.
  const today = "2026-05-29";
  const tomorrow = "2026-05-30";
  // Pin "now" to 1:54 PM IST that day so the filter is deterministic.
  // Using local-time fields here matches what dropPastSlots constructs.
  const now = new Date(2026, 4, 29, 13, 54, 0);

  const mixedSlots: DineoutSlot[] = [
    // Past lunch (should be dropped)
    { slotId: "s_l1", date: today, time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "s_l2", date: today, time: "12:30", band: "LUNCH", available: true, isFree: true },
    { slotId: "s_l3", date: today, time: "13:00", band: "LUNCH", available: true, isFree: true },
    // Borderline — within 30 min cutoff
    { slotId: "s_l4", date: today, time: "14:00", band: "LUNCH", available: true, isFree: true },
    // Dinner today (the user actually wants these)
    { slotId: "s_d1", date: today, time: "18:00", band: "DINNER", available: true, isFree: true },
    { slotId: "s_d2", date: today, time: "18:30", band: "DINNER", available: false, isFree: false },
    { slotId: "s_d3", date: today, time: "19:00", band: "DINNER", available: true, isFree: true },
    { slotId: "s_d4", date: today, time: "19:30", band: "DINNER", available: true, isFree: true },
    { slotId: "s_d5", date: today, time: "20:00", band: "DINNER", available: true, isFree: true },
    // Tomorrow — should not surface ahead of today
    { slotId: "s_t1", date: tomorrow, time: "12:00", band: "LUNCH", available: true, isFree: true },
  ];

  const patch = mapAvailableSlots(mixedSlots, today, now);
  const negSlots = patch?.negotiator?.slots ?? [];

  // (1) Past lunch slots are gone.
  const surfacedTimes = negSlots.map((s) => s.time);
  assert(
    !surfacedTimes.includes("12:00 PM") && !surfacedTimes.includes("12:30 PM"),
    "past lunch slots filtered out (12:00/12:30 dropped at 1:54 PM)",
    surfacedTimes.join(", "),
  );
  assert(
    !surfacedTimes.includes("1:00 PM"),
    "1:00 PM (already past) filtered out",
    surfacedTimes.join(", "),
  );

  // (2) Dinner slots surface first. The 5-slot cap should be all
  // DINNER slots since there are 5 future dinner slots today.
  const dinnerCount = negSlots.filter((s) => s.label === "DINNER").length;
  assert(
    dinnerCount >= 4,
    "with today + past 1 PM, dinner slots dominate the panel (≥ 4 of 5)",
    `dinner=${dinnerCount}, slots=${surfacedTimes.join(", ")}`,
  );

  // (3) Headline says "tonight", not lunch.
  assert(
    patch?.negotiator?.headline === "Available tonight",
    "headline reads 'Available tonight' when dinner-biased panel surfaces only dinner",
    patch?.negotiator?.headline,
  );

  // (4) Date label set to "today".
  assert(
    patch?.negotiator?.dateLabel === "today",
    "dateLabel resolves requestedDate=today → 'today'",
    patch?.negotiator?.dateLabel,
  );
}

{
  // Asking at 10 AM — no dinner bias (it's still morning). Lunch slots
  // should naturally surface because they're the earliest future
  // bookable times.
  const today = "2026-05-29";
  const now = new Date(2026, 4, 29, 10, 0, 0); // 10 AM
  const slots: DineoutSlot[] = [
    { slotId: "l1", date: today, time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "l2", date: today, time: "12:30", band: "LUNCH", available: true, isFree: true },
    { slotId: "l3", date: today, time: "13:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "d1", date: today, time: "19:00", band: "DINNER", available: true, isFree: true },
    { slotId: "d2", date: today, time: "19:30", band: "DINNER", available: true, isFree: true },
  ];
  const patch = mapAvailableSlots(slots, today, now);
  const first = patch?.negotiator?.slots[0];
  assert(
    first?.label === "LUNCH",
    "before 1 PM, dinner bias OFF — lunch slots surface first",
    `first slot label=${first?.label}, time=${first?.time}`,
  );
}

{
  // Date label resolution: tomorrow, 3 days out.
  const now = new Date(2026, 4, 29, 13, 54, 0);
  const tomorrow = "2026-05-30";
  const inThreeDays = "2026-06-01";
  const slots: DineoutSlot[] = [
    { slotId: "x", date: tomorrow, time: "19:00", band: "DINNER", available: true, isFree: true },
  ];
  let patch = mapAvailableSlots(slots, tomorrow, now);
  assert(
    patch?.negotiator?.dateLabel === "tomorrow",
    "dateLabel resolves requestedDate=tomorrow → 'tomorrow'",
    patch?.negotiator?.dateLabel,
  );

  const futureSlots: DineoutSlot[] = [
    { slotId: "y", date: inThreeDays, time: "19:00", band: "DINNER", available: true, isFree: true },
  ];
  patch = mapAvailableSlots(futureSlots, inThreeDays, now);
  assert(
    typeof patch?.negotiator?.dateLabel === "string" && /Mon/.test(patch.negotiator.dateLabel),
    "dateLabel for 3-day-out date includes weekday abbreviation",
    patch?.negotiator?.dateLabel,
  );
}

{
  // Edge case: every slot is in the past. Don't blow up — fall back
  // to the original list so the user sees something rather than an
  // empty panel.
  const yesterday = "2026-05-28";
  const now = new Date(2026, 4, 29, 13, 54, 0);
  const slots: DineoutSlot[] = [
    { slotId: "p1", date: yesterday, time: "12:00", band: "LUNCH", available: true, isFree: true },
    { slotId: "p2", date: yesterday, time: "13:00", band: "LUNCH", available: true, isFree: true },
  ];
  const patch = mapAvailableSlots(slots, yesterday, now);
  assert(
    (patch?.negotiator?.slots.length ?? 0) > 0,
    "all-past-slots → fallback keeps original slots rather than emptying the panel",
  );
}

group("26b. Mapper renders chronologically + focuses requested time");

{
  // Repro of the user-reported bug: agent says "8 PM is full,
  // 7:30/8:30 available" but the panel hides 8 PM entirely. With
  // the chronological render + centerTime focus, the panel shows
  // the requested time (even when unavailable) and the CONFIRM
  // button points to the closest available slot, not the full one.
  const tomorrow = "2026-05-30";
  const now = new Date(2026, 4, 29, 15, 0, 0); // 3 PM today
  const slots: DineoutSlot[] = [
    { slotId: "d1", date: tomorrow, time: "19:00", band: "DINNER", available: true,  isFree: true  },
    { slotId: "d2", date: tomorrow, time: "19:30", band: "DINNER", available: true,  isFree: true  },
    { slotId: "d3", date: tomorrow, time: "20:00", band: "DINNER", available: false, isFree: false }, // 8 PM FULL
    { slotId: "d4", date: tomorrow, time: "20:30", band: "DINNER", available: true,  isFree: true  },
    { slotId: "d5", date: tomorrow, time: "21:00", band: "DINNER", available: true,  isFree: true  },
  ];

  const patch = mapAvailableSlots(slots, tomorrow, now, "20:00");
  const negSlots = patch?.negotiator?.slots ?? [];

  // (1) All 5 slots are rendered (no available-first hiding).
  assert(negSlots.length === 5, "all 5 slots rendered", `got ${negSlots.length}`);

  // (2) Chronological order — 7 PM, 7:30 PM, 8 PM, 8:30 PM, 9 PM.
  assert(
    negSlots.map((s) => s.time).join(",") === "7:00 PM,7:30 PM,8:00 PM,8:30 PM,9:00 PM",
    "slots appear in chronological order",
    negSlots.map((s) => s.time).join(", "),
  );

  // (3) 8 PM IS in the panel, marked unavailable.
  const eight = negSlots.find((s) => s.time === "8:00 PM");
  assert(eight !== undefined, "8 PM slot is rendered (not silently hidden)");
  assert(eight?.available === false, "8 PM slot is marked unavailable so the UI can dim it");

  // (4) Focused slot is NOT the full 8 PM — it's the closest
  //     available slot (7:30 PM or 8:30 PM, both equidistant; the
  //     algorithm picks the first one it finds while sorting by
  //     distance, which is 7:30 PM because of array order).
  const focused = negSlots[patch?.negotiator?.focusedSlotIndex ?? -1];
  assert(focused !== undefined, "focusedSlotIndex points to a real slot");
  assert(
    focused?.available === true,
    "focusedSlotIndex never points to an unavailable slot — CONFIRM button shouldn't target a full slot",
    `focused=${focused?.time}, available=${focused?.available}`,
  );
}

{
  // When the requested time IS available, focus exactly on it.
  const tomorrow = "2026-05-30";
  const now = new Date(2026, 4, 29, 15, 0, 0);
  const slots: DineoutSlot[] = [
    { slotId: "d1", date: tomorrow, time: "19:00", band: "DINNER", available: true, isFree: true },
    { slotId: "d2", date: tomorrow, time: "19:30", band: "DINNER", available: true, isFree: true },
    { slotId: "d3", date: tomorrow, time: "20:00", band: "DINNER", available: true, isFree: true },
    { slotId: "d4", date: tomorrow, time: "20:30", band: "DINNER", available: true, isFree: true },
    { slotId: "d5", date: tomorrow, time: "21:00", band: "DINNER", available: true, isFree: true },
  ];

  const patch = mapAvailableSlots(slots, tomorrow, now, "20:00");
  const focused = patch?.negotiator?.slots[patch.negotiator.focusedSlotIndex];
  assert(
    focused?.time === "8:00 PM",
    "centerTime available → focus the matching slot directly",
    `focused=${focused?.time}`,
  );
}

{
  // No centerTime, no manipulation — focus the first AVAILABLE slot
  // rather than index 0 (which might be unavailable).
  const tomorrow = "2026-05-30";
  const now = new Date(2026, 4, 29, 15, 0, 0);
  const slots: DineoutSlot[] = [
    { slotId: "d1", date: tomorrow, time: "19:00", band: "DINNER", available: false, isFree: false },
    { slotId: "d2", date: tomorrow, time: "19:30", band: "DINNER", available: true,  isFree: true  },
    { slotId: "d3", date: tomorrow, time: "20:00", band: "DINNER", available: true,  isFree: true  },
  ];

  const patch = mapAvailableSlots(slots, tomorrow, now);
  const focused = patch?.negotiator?.slots[patch.negotiator.focusedSlotIndex];
  assert(
    focused?.time === "7:30 PM",
    "no centerTime → focus the first AVAILABLE slot, never a full one",
    `focused=${focused?.time}, available=${focused?.available}`,
  );
}

// =========================================================================
//  Async test groups — wrapped in an IIFE because tsx compiles these
//  scripts as CJS (no top-level await). The summary print is moved
//  inside .then() so it runs after these tests finish.
// =========================================================================

import("../lib/mock/dineout")
  .then(async ({ get_available_slots }) => {
    group("27. Mock dineout — band arg filters slots");

    const today = "2026-05-29";

    const dinner = await get_available_slots({
      restaurantId: "din_002",
      date: today,
      guestCount: 2,
      band: "DINNER",
    });
    if (!dinner.success) throw new Error("dinner call failed: " + dinner.error.message);
    const dinnerSlots = dinner.data.slots;
    assert(
      dinnerSlots.length > 0 && dinnerSlots.every((s) => s.band === "DINNER"),
      "band=DINNER → every returned slot has band=DINNER",
      `${dinnerSlots.length} slots, bands: ${[...new Set(dinnerSlots.map((s) => s.band))].join(",")}`,
    );
    assert(dinner.data.band === "DINNER", "mock echoes back the requested band");

    const lunch = await get_available_slots({
      restaurantId: "din_002",
      date: today,
      guestCount: 2,
      band: "LUNCH",
    });
    if (!lunch.success) throw new Error("lunch call failed");
    const lunchSlots = lunch.data.slots;
    assert(
      lunchSlots.length > 0 && lunchSlots.every((s) => s.band === "LUNCH"),
      "band=LUNCH → every returned slot has band=LUNCH",
    );

    const both = await get_available_slots({
      restaurantId: "din_002",
      date: today,
      guestCount: 2,
    });
    if (!both.success) throw new Error("no-band call failed");
    const bothSlots = both.data.slots;
    const bands = new Set(bothSlots.map((s) => s.band));
    assert(
      bands.has("LUNCH") && bands.has("DINNER"),
      "no band arg → mock returns both bands (backwards compatible)",
      `bands seen: ${[...bands].join(",")}`,
    );
    assert(both.data.band === undefined, "no band arg → response omits the band field");

    const bad = await get_available_slots({
      restaurantId: "din_002",
      date: today,
      guestCount: 2,
      band: "BREAKFAST" as unknown as "LUNCH",
    });
    assert(!bad.success, "invalid band → returns an error");

    group("28. Mock dineout — time arg centers a 5-slot window");

    // The user reported: agent says "8 PM is full, 7:30/8:30 available"
    // but the panel showed 6, 6:30, 7, 7:30, 8:30 (no 8 PM card at
    // all). The fix: agent passes `time: "20:00"`, mock narrows to
    // a 5-slot window centered on 20:00 — INCLUDING 20:00 itself
    // even when unavailable.
    const tomorrow = "2026-05-30";
    const centered = await get_available_slots({
      restaurantId: "din_002",
      date: tomorrow,
      guestCount: 2,
      band: "DINNER",
      time: "20:00",
    });
    if (!centered.success) throw new Error("centered call failed: " + centered.error.message);
    const cs = centered.data.slots;
    assert(cs.length === 5, "time arg → exactly 5 slots returned", `got ${cs.length}`);
    assert(cs.every((s) => s.date === tomorrow), "all 5 slots are on the requested date");
    assert(cs.some((s) => s.time === "20:00"), "the requested time (20:00) IS in the window — even if unavailable");
    assert(
      cs.some((s) => s.time === "19:30") && cs.some((s) => s.time === "20:30"),
      "±30 min flex slots (19:30 and 20:30) are also in the window",
    );
    assert(centered.data.centerTime === "20:00", "response echoes back the centerTime");

    // Edge: late time pushes the window left-padded to fit.
    const late = await get_available_slots({
      restaurantId: "din_002",
      date: tomorrow,
      guestCount: 2,
      band: "DINNER",
      time: "22:30", // last dinner slot
    });
    if (!late.success) throw new Error("late call failed");
    assert(late.data.slots.length === 5, "edge time (last slot) → still 5 slots, padded left");
    assert(
      late.data.slots[late.data.slots.length - 1].time === "22:30",
      "last slot of the window IS the requested time",
    );

    const earlyEdge = await get_available_slots({
      restaurantId: "din_002",
      date: tomorrow,
      guestCount: 2,
      band: "DINNER",
      time: "18:00", // first dinner slot
    });
    if (!earlyEdge.success) throw new Error("earlyEdge call failed");
    assert(earlyEdge.data.slots.length === 5, "edge time (first slot) → still 5 slots, padded right");
    assert(earlyEdge.data.slots[0].time === "18:00", "first slot of the window IS the requested time");

    // Bad time format → error
    const badTime = await get_available_slots({
      restaurantId: "din_002",
      date: tomorrow,
      guestCount: 2,
      time: "8 PM" as string,
    });
    assert(!badTime.success, "non-HH:MM time format → returns an error");
  })
  .catch((e) => {
    failed++;
    failures.push(`async test 27 threw: ${e?.message ?? e}`);
  })
  .finally(() => {
    // ===================================================================
    //  Summary (runs after all sync + async tests resolve)
    // ===================================================================
    console.log(`\n${passed} passed${failed > 0 ? `, ${R}${failed} failed${X}` : ""}\n`);
    if (failed > 0) {
      console.log(`Failures:`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  });
