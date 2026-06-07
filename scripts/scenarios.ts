#!/usr/bin/env tsx
// PRD-aligned scenario tests.
//
// These exercise the mock layer the same way the real voice agent will: with
// chained, stateful tool calls that match the user journeys described in the
// PRD §3.1-§3.4 (Intent Gateway / Scout / Auditor / Negotiator) plus the
// hard rails from the Builders Club docs.
//
// Goal: prove the mock data is *agent-shaped*, not just envelope-correct.
//
// Run with: `npm run test:scenarios`

import {
  type SwiggyResponse,
  callMockTool,
  store,
} from "../lib/mock";

import type {
  Address,
  Booking,
  DineoutRestaurant,
  DineoutSlot,
  FoodCart,
  FoodCoupon,
  FoodRestaurant,
  GoToItem,
  InstamartCart,
  Order,
  Product,
  RestaurantMenu,
} from "../lib/mock/types";

// ---- minimal assert framework -------------------------------------------

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

function unwrap<T>(r: SwiggyResponse<T>, label: string): T {
  if (!r.success) {
    failed++;
    failures.push(`${label} unwrap`);
    console.log(`  ${R}\u2717${X} ${label} unwrap ${D}\u2014 ${r.error.message}${X}`);
    throw new Error(`Unwrap failed: ${label}: ${r.error.message}`);
  }
  return r.data;
}

function section(title: string): void {
  console.log(`\n${Y}${title}${X}`);
}

// ---- helpers -------------------------------------------------------------

const HOME = "addr_01HXHM";

async function call<T>(server: "food" | "im" | "dineout", tool: string, args: object): Promise<SwiggyResponse<T>> {
  return (await callMockTool(server, tool, args)) as SwiggyResponse<T>;
}

function resetForFreshRun(): void {
  store.resetAll();
}

// ---- Scenario A: Scout — order biryani end-to-end ------------------------

async function scoutOrderBiryani() {
  section("Scenario A — Scout: order biryani end-to-end (PRD §3.2)");
  resetForFreshRun();

  // 1. Resolve address
  const addresses = unwrap(await call<Address[]>("food", "get_addresses", {}), "get_addresses");
  assert(addresses.length >= 2, "user has 2+ saved addresses");
  assert(
    addresses.some((a) => a.label === "Home"),
    "default 'Home' address present (voice contract default)",
  );

  // 2. Search "biryani"
  const search = unwrap(
    await call<{ restaurants: FoodRestaurant[] }>("food", "search_restaurants", {
      addressId: HOME,
      query: "biryani",
    }),
    "search_restaurants(biryani)",
  );
  assert(search.restaurants.length >= 3, "≥3 biryani restaurants returned", `${search.restaurants.length} found`);
  assert(
    search.restaurants.every((r) => "distanceKm" in r),
    "all restaurants carry distanceKm (for >5km disclosure rule)",
  );
  assert(
    search.restaurants.every((r) => "deliveryTimeSpoken" in r),
    "all restaurants carry deliveryTimeSpoken (voice-friendly)",
  );
  const openFirst = search.restaurants[0]?.availabilityStatus === "OPEN";
  assert(openFirst, "results are ranked with OPEN first (docs guidance)");

  // 3. Pick top restaurant, get its menu
  const top = search.restaurants[0];
  const menu = unwrap(
    await call<RestaurantMenu>("food", "get_restaurant_menu", { restaurantId: top.id }),
    "get_restaurant_menu",
  );
  assert(menu.categories.length >= 1, "menu has at least one category");
  const allItems = menu.categories.flatMap((c) => c.items);
  assert(
    allItems.some((i) => i.variants && i.variants.length > 0),
    "at least one menu item has variants (for variant picking)",
  );
  assert(
    allItems.some((i) => i.addOns && i.addOns.length > 0),
    "at least one menu item has add-ons (for verbal readback)",
  );

  // 4. Add an item with a variant + add-on
  const itemWithExtras = allItems.find((i) => i.variants && i.addOns);
  if (!itemWithExtras) throw new Error("test data missing variant+addon item");

  const cart1 = unwrap(
    await call<FoodCart>("food", "update_food_cart", {
      restaurantId: top.id,
      items: [
        {
          itemId: itemWithExtras.id,
          quantity: 1,
          variantId: itemWithExtras.variants![0].id,
          addOnIds: [itemWithExtras.addOns![0].id],
        },
      ],
    }),
    "update_food_cart",
  );
  assert(cart1.items.length === 1, "cart has 1 line");
  assert(
    cart1.items[0].variantName !== undefined,
    "cart item exposes variantName (for verbal readback)",
    cart1.items[0].variantName,
  );
  assert(
    Array.isArray(cart1.items[0].addOnNames) && cart1.items[0].addOnNames.length === 1,
    "cart item exposes addOnNames (for verbal readback)",
    cart1.items[0].addOnNames?.[0],
  );
  assert(cart1.subtotal > 0 && cart1.total > cart1.subtotal, "fees & taxes computed");

  // 5. Fetch coupons — filter for COD-eligible (v1 constraint)
  const coupons = unwrap(await call<FoodCoupon[]>("food", "fetch_food_coupons", {}), "fetch_food_coupons");
  const codCoupons = coupons.filter((c) => !c.requiresOnlinePayment);
  assert(codCoupons.length >= 1, "at least one COD-eligible coupon exists");
  assert(
    coupons.some((c) => c.requiresOnlinePayment),
    "test fixture includes an online-only coupon (so filter has work to do)",
  );

  // 6. Apply COD coupon
  const eligibleCoupon = codCoupons.find((c) => cart1.subtotal >= c.minOrder);
  if (eligibleCoupon) {
    const cart2 = unwrap(
      await call<FoodCart>("food", "apply_food_coupon", { code: eligibleCoupon.code }),
      "apply_food_coupon",
    );
    assert(cart2.discount > 0, "discount applied", `₹${cart2.discount}`);
    assert(cart2.total < cart1.total, "cart total reduced after coupon");
  }

  // 7. Place order
  const order = unwrap(
    await call<Order>("food", "place_food_order", { addressId: HOME }),
    "place_food_order",
  );
  assert(order.status === "PLACED", "order initial status is PLACED");
  assert(order.paymentMethod === "COD", "payment is COD (v1 constraint)");
  assert(order.etaMinutes > 0, "order has an ETA");

  // 8. Track — verify status progresses on poll
  const t1 = unwrap(
    await call<{ status: string; etaSpoken: string }>("food", "track_food_order", { orderId: order.orderId }),
    "track_food_order #1",
  );
  assert(t1.status === "ACCEPTED", "polling advances PLACED → ACCEPTED");
  assert(t1.etaSpoken.length > 0, "tracker returns voice-friendly etaSpoken", t1.etaSpoken);

  const t2 = unwrap(
    await call<{ status: string }>("food", "track_food_order", { orderId: order.orderId }),
    "track_food_order #2",
  );
  assert(t2.status === "PREPARING", "polling advances ACCEPTED → PREPARING");
}

// ---- Scenario B: Scout — "find spicy wings under ₹400" -------------------

async function scoutMenuFiltering() {
  section("Scenario B — Scout: 'find spicy wings under ₹400' (PRD §3.2 deep menu parsing)");
  resetForFreshRun();

  // Approach 1: search_restaurants should now find restaurants that serve wings
  const byRestSearch = unwrap(
    await call<{ restaurants: FoodRestaurant[] }>("food", "search_restaurants", {
      addressId: HOME,
      query: "wings",
    }),
    "search_restaurants(wings)",
  );
  assert(
    byRestSearch.restaurants.some((r) => r.name === "Truffles"),
    "search_restaurants matches Truffles via its menu item 'Spicy Wings' (deep menu parse)",
  );

  // Approach 2: search_menu cross-restaurant
  const byMenuSearch = unwrap(
    await call<{ results: Array<{ name: string; price: number; restaurantName: string }> }>(
      "food",
      "search_menu",
      { query: "wings" },
    ),
    "search_menu(wings)",
  );
  assert(byMenuSearch.results.length >= 1, "search_menu finds wings");
  const under400 = byMenuSearch.results.filter((r) => r.price < 400);
  assert(under400.length >= 1, "at least one wings item is under ₹400 (agent can apply price filter)");
}

// ---- Scenario C: Scout — multi-cart switch warning ------------------------

async function scoutMultiCartSwitch() {
  section("Scenario C — Scout: multi-restaurant cart switch (PRD §3.2 cart consolidation)");
  resetForFreshRun();

  // Add biryani to cart
  await call<FoodCart>("food", "update_food_cart", {
    restaurantId: "res_001",
    items: [{ itemId: "item_001", quantity: 1, variantId: "var_001a" }],
  });

  // Agent checks cart first (the "warn before flush" pattern from docs)
  const beforeSwitch = unwrap(await call<FoodCart>("food", "get_food_cart", {}), "get_food_cart");
  assert(beforeSwitch.restaurantId === "res_001", "cart bound to res_001 before switch");
  assert(beforeSwitch.items.length === 1, "1 item in cart");

  // Agent now knows: switching restaurant will flush. It should WARN user.
  // Mock-side: simulate user confirming the switch.
  const afterSwitch = unwrap(
    await call<FoodCart>("food", "update_food_cart", {
      restaurantId: "res_003",
      items: [{ itemId: "item_t001", quantity: 1 }],
    }),
    "update_food_cart(switch to res_003)",
  );
  assert(afterSwitch.restaurantId === "res_003", "cart now bound to res_003");
  assert(
    afterSwitch.items.length === 1 && afterSwitch.items[0].itemId === "item_t001",
    "previous cart flushed, only new item remains (docs: 'cart flushes automatically')",
  );
}

// ---- Scenario D: Scout — ₹1000 cap enforcement ---------------------------

async function scoutCartCap() {
  section("Scenario D — Scout: ₹1000 cart cap enforcement (Builders Club v1)");
  resetForFreshRun();

  // Push cart over ₹1000 (Family Pack chicken biryani = ₹549, x2 = ₹1098)
  const over = unwrap(
    await call<FoodCart>("food", "update_food_cart", {
      restaurantId: "res_001",
      items: [{ itemId: "item_001", quantity: 2, variantId: "var_001b" }],
    }),
    "update_food_cart(over cap)",
  );
  assert(over.total > 1000, "cart total exceeds ₹1000", `₹${over.total}`);
  assert(over.capExceeded, "capExceeded flag is true");

  // place_food_order should reject
  const rejected = await call<Order>("food", "place_food_order", { addressId: HOME });
  assert(!rejected.success, "place_food_order rejects when cap exceeded");
  if (!rejected.success) {
    assert(
      rejected.error.code === "CART_CAP_EXCEEDED",
      "rejection uses CART_CAP_EXCEEDED code",
      rejected.error.code,
    );
  }
}

// ---- Scenario E: Auditor — recipe gap + MVQ ------------------------------

async function auditorRecipeGap() {
  section("Scenario E — Auditor: butter chicken recipe (PRD §3.3 gap analysis + MVQ)");
  resetForFreshRun();

  // Agent's mental model: butter chicken needs chicken, onion, tomato, butter,
  // cream, ginger, garlic, cilantro, yogurt.
  const recipe: { ingredient: string; needSpoken: string }[] = [
    { ingredient: "chicken", needSpoken: "chicken curry cut" },
    { ingredient: "onion", needSpoken: "2 onions" },
    { ingredient: "tomato", needSpoken: "3 tomatoes" },
    { ingredient: "butter", needSpoken: "a stick of butter" },
    { ingredient: "cream", needSpoken: "fresh cream" },
    { ingredient: "ginger", needSpoken: "ginger" },
    { ingredient: "garlic", needSpoken: "garlic" },
    { ingredient: "cilantro", needSpoken: "cilantro" },
  ];

  type MVQSelection = { spinId: string; productName: string; variantName: string; price: number };
  const cartLines: MVQSelection[] = [];

  for (const r of recipe) {
    const res = unwrap(
      await call<{ products: Product[] }>("im", "search_products", {
        addressId: HOME,
        query: r.ingredient,
      }),
      `search_products(${r.ingredient})`,
    );
    assert(res.products.length >= 1, `${r.ingredient}: at least one match`);
    if (!res.products.length) continue;
    const product = res.products[0];

    // MVQ: pick smallest available variant by absolute quantity-in-grams-equivalent.
    const toGramsEquiv = (q: { value: number; unit: string }) => {
      switch (q.unit) {
        case "kg": return q.value * 1000;
        case "l": return q.value * 1000;
        case "g":
        case "ml":
        case "piece":
        default: return q.value;
      }
    };
    const smallest = [...product.variants]
      .filter((v) => v.inStock)
      .sort((a, b) => toGramsEquiv(a.quantity) - toGramsEquiv(b.quantity))[0];

    cartLines.push({
      spinId: smallest.spinId,
      productName: product.name,
      variantName: smallest.name,
      price: smallest.price,
    });
  }

  // Specific MVQ assertions
  const onionLine = cartLines.find((c) => c.productName === "Onion");
  assert(
    onionLine?.variantName === "500g pack",
    "MVQ: 'onion' picked 500g pack (smallest), not 1kg",
    onionLine?.variantName,
  );
  const milkInRecipe = await call<{ products: Product[] }>("im", "search_products", {
    addressId: HOME,
    query: "milk",
  });
  if (milkInRecipe.success) {
    const milkProduct = milkInRecipe.data.products[0];
    assert(milkProduct.variants.length >= 2, "milk product has multiple variants (so MVQ has a choice)");
  }

  // Push into cart
  const cart = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: cartLines.map((l) => ({ spinId: l.spinId, quantity: 1 })),
    }),
    "update_cart(recipe ingredients)",
  );
  assert(cart.items.length === cartLines.length, "all ingredients added");
  assert(cart.minOrderMet, "₹99 minimum met by recipe");

  // Compose verbal readback (PRD §3.3): "I've added 500g onions and 1L milk. Total is ₹X. Proceed?"
  const readback =
    "I've added " +
    cart.items
      .slice(0, 3)
      .map((i) => `${i.variantName} ${i.productName.toLowerCase()}`)
      .join(", ") +
    (cart.items.length > 3 ? `, and ${cart.items.length - 3} more items` : "") +
    `. Total is ₹${cart.total}. Proceed?`;
  console.log(`  ${D}readback:${X} "${readback}"`);
  assert(
    !/\baddr_|spin_|prod_|item_|res_|var_/.test(readback),
    "readback has no raw IDs (voice contract — never read IDs aloud)",
  );
  assert(readback.length <= 250, "readback is concise enough for TTS");
}

// ---- Scenario F: Auditor — ₹99 minimum gate ------------------------------

async function auditorMinOrderGate() {
  section("Scenario F — Auditor: ₹99 minimum order enforcement");
  resetForFreshRun();

  // Add one ₹15 item (cilantro)
  const tiny = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: [{ spinId: "spin_cilantro_100g", quantity: 1 }],
    }),
    "update_cart(under min)",
  );
  assert(tiny.subtotal < 99, "subtotal under ₹99", `₹${tiny.subtotal}`);
  assert(!tiny.minOrderMet, "minOrderMet=false");

  // checkout should fail
  const failed = await call<Order>("im", "checkout", {});
  assert(!failed.success, "checkout blocked when under min");
  if (!failed.success) {
    assert(failed.error.code === "MIN_ORDER_NOT_MET", "rejection code is MIN_ORDER_NOT_MET");
  }

  // Bump up
  await call<InstamartCart>("im", "update_cart", {
    addressId: HOME,
    items: [
      { spinId: "spin_milk_1l", quantity: 2 },
      { spinId: "spin_butter_100g", quantity: 1 },
    ],
  });
  const ok = unwrap(await call<Order>("im", "checkout", {}), "checkout(over min)");
  assert(ok.status === "PLACED", "checkout succeeds once over min");
}

// ---- Scenario G: Auditor — your_go_to_items one-tap reorder --------------

async function auditorGoToReorder() {
  section("Scenario G — Auditor: your_go_to_items one-tap reorder");
  resetForFreshRun();

  const items = unwrap(
    await call<{ items: GoToItem[] }>("im", "your_go_to_items", { addressId: HOME }),
    "your_go_to_items",
  );
  assert(items.items.length >= 1, "user has go-to items");
  assert(
    items.items.every((i) => "orderCount" in i),
    "items expose orderCount (so agent can say 'your usual milk, ordered 23 times')",
  );
  const top = [...items.items].sort((a, b) => b.orderCount - a.orderCount)[0];
  assert(top.orderCount >= 10, "top go-to has meaningful order history");

  // One-tap reorder
  const cart = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: items.items.map((i) => ({ spinId: i.spinId, quantity: 1 })),
    }),
    "update_cart(reorder go-tos)",
  );
  assert(cart.items.length === items.items.length, "all go-tos added");
}

// ---- Scenario H: Negotiator — ±30 min slot flex --------------------------

async function negotiator30MinFlex() {
  section("Scenario H — Negotiator: ±30 min slot flex (PRD §3.4 slot negotiation)");
  resetForFreshRun();

  // User wants Toscano on Friday 8pm for 4
  const slots = unwrap(
    await call<{ slots: DineoutSlot[] }>("dineout", "get_available_slots", {
      restaurantId: "din_001",
      date: "2026-05-15",
      guestCount: 4,
    }),
    "get_available_slots",
  );
  assert(slots.slots.length >= 40, "slot grid spans 7 days × ~22 slots/day", `${slots.slots.length} slots`);

  // Find slots at the requested date
  const requestedDate = slots.slots.filter((s) => s.date === "2026-05-15");
  // 8 lunch slots (12:00–15:30) + 10 dinner slots (18:00–22:30) = 18.
  // Restaurants are closed 16:00–17:30 (the dead zone between services),
  // so no slots there — see lib/mock/dineout.ts generateSlots.
  assert(requestedDate.length === 18, "requested date has both lunch + dinner grids (8 + 10 = 18)");

  // Look for 20:00 on requested date
  const at8pm = requestedDate.find((s) => s.time === "20:00");
  assert(at8pm !== undefined, "20:00 slot exists in the grid");

  // ±30 min flex: agent computes alternative slots
  const within30 = requestedDate.filter((s) => {
    if (!s.available) return false;
    const [hh, mm] = s.time.split(":").map(Number);
    const minutes = hh * 60 + mm;
    return Math.abs(minutes - 20 * 60) <= 30;
  });
  assert(within30.length >= 1, "≥1 available slot within ±30 minutes of 20:00", `found: ${within30.map((s) => s.time).join(", ")}`);

  // Also some unavailable ones (so the negotiator has work to do)
  const unavailableOnDay = requestedDate.filter((s) => !s.available);
  assert(
    unavailableOnDay.length >= 1,
    "≥1 unavailable slot on day (mock realism)",
    `${unavailableOnDay.length} blocked`,
  );
}

// ---- Scenario I: Negotiator — similar-vibes fallback ---------------------

async function negotiatorSimilarVibes() {
  section("Scenario I — Negotiator: FULLY_BOOKED restaurant similar-vibes fallback");
  resetForFreshRun();

  // Try Toit Brewpub (FULLY_BOOKED in fixtures)
  const toit = unwrap(
    await call<DineoutRestaurant>("dineout", "get_restaurant_details", { restaurantId: "din_005" }),
    "get_restaurant_details(Toit)",
  );
  assert(toit.availability === "FULLY_BOOKED", "Toit is fully booked in fixtures");

  // get_available_slots should reject for fully-booked
  const slotsAttempt = await call<{ slots: DineoutSlot[] }>("dineout", "get_available_slots", {
    restaurantId: "din_005",
    date: "2026-05-15",
    guestCount: 4,
  });
  assert(!slotsAttempt.success, "get_available_slots rejects fully-booked restaurant");
  if (!slotsAttempt.success) {
    assert(slotsAttempt.error.code === "RESTAURANT_NOT_BOOKABLE", "uses RESTAURANT_NOT_BOOKABLE code");
  }

  // Agent's fallback: search same area for similar vibes
  const area = toit.area; // "Indiranagar"
  const similar = unwrap(
    await call<{ restaurants: DineoutRestaurant[] }>("dineout", "search_restaurants_dineout", {
      lat: 12.97,
      lng: 77.64,
      query: area,
    }),
    `search_restaurants_dineout(${area})`,
  );
  const otherIndiranagar = similar.restaurants.filter(
    (r) => r.id !== "din_005" && r.availability === "AVAILABLE",
  );
  assert(
    otherIndiranagar.length >= 1,
    "≥1 AVAILABLE alternative in same area",
    otherIndiranagar.map((r) => r.name).join(", "),
  );
}

// ---- Scenario J: Negotiator — non-idempotent book_table check-then-retry --

async function negotiatorIdempotency() {
  section("Scenario J — Negotiator: non-idempotent book_table (check-then-retry pattern)");
  resetForFreshRun();

  const booking = unwrap(
    await call<Booking>("dineout", "book_table", {
      restaurantId: "din_001",
      slotId: "slot_TEST",
      guestCount: 4,
      date: "2026-05-15",
      // 12:30 is deterministic-available for din_001 / 2026-05-15
      // under the generateSlots RNG seed. Kept in lockstep with the
      // pin in scripts/test-mocks.ts and scripts/test-router.ts.
      time: "12:30",
    }),
    "book_table",
  );
  assert(booking.status === "CONFIRMED", "booking confirmed");

  // Simulate 5xx: agent should call get_booking_status before retrying.
  const lookupByIds = unwrap(
    await call<Booking>("dineout", "get_booking_status", {
      restaurantId: "din_001",
      slotId: "slot_TEST",
    }),
    "get_booking_status(by ids)",
  );
  assert(
    lookupByIds && lookupByIds.bookingId === booking.bookingId,
    "get_booking_status(restaurantId+slotId) finds the original booking",
  );
}

// ---- Scenario K: Voice contract data hygiene -----------------------------

async function voiceContractHygiene() {
  section("Scenario K — Voice contract data hygiene (cross-cutting)");
  resetForFreshRun();

  // All IDs should be structurally `prefix_*` so a generic regex can strip
  // them from anything we feed into TTS. Real Swiggy IDs are opaque strings —
  // we don't constrain casing, only the shape.
  const idLike = /\b(addr|res|item|spin|prod|var|addon|ord|bk|slot|loc|din|dcart|rep)_[\w-]+\b/;

  const restaurants = unwrap(
    await call<{ restaurants: FoodRestaurant[] }>("food", "search_restaurants", {
      addressId: HOME,
      query: "biryani",
    }),
    "search_restaurants",
  );
  assert(restaurants.restaurants.every((r) => idLike.test(r.id)), "all food restaurant IDs are prefix_HEX");

  // deliveryTimeSpoken should not contain digits (it's the voice form)
  assert(
    restaurants.restaurants.every((r) => !/\d/.test(r.deliveryTimeSpoken)),
    "deliveryTimeSpoken is digit-free (e.g. 'about thirty minutes')",
    restaurants.restaurants.map((r) => r.deliveryTimeSpoken).join(" | "),
  );

  // Prices are whole rupees (integers)
  assert(
    restaurants.restaurants.every((r) => Number.isInteger(r.priceForTwo)),
    "priceForTwo values are integer rupees",
  );

  // Products
  const products = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "milk",
    }),
    "search_products",
  );
  assert(products.products.every((p) => idLike.test(p.id)), "all product IDs are prefix_HEX");
  assert(
    products.products.every((p) => p.variants.every((v) => idLike.test(v.spinId))),
    "all spinIds are prefix_HEX",
  );
}

// ---- Scenario L: Combined "plan my evening" (PRD demo flow) --------------

async function combinedPlanMyEvening() {
  section("Scenario L — Combined: 'plan my evening' end-to-end (PRD demo §6)");
  resetForFreshRun();

  // (a) Reservation: Italian, Indiranagar, Friday 8pm, 4 people
  const dineSearch = unwrap(
    await call<{ restaurants: DineoutRestaurant[] }>("dineout", "search_restaurants_dineout", {
      lat: 12.97,
      lng: 77.64,
      query: "italian",
    }),
    "dineout search 'italian'",
  );
  assert(dineSearch.restaurants.length >= 1, "found at least one Italian dineout option");
  const targetDine = dineSearch.restaurants.find((r) => r.availability === "AVAILABLE");
  if (!targetDine) throw new Error("no available Italian option in fixtures");

  const dineSlots = unwrap(
    await call<{ slots: DineoutSlot[] }>("dineout", "get_available_slots", {
      restaurantId: targetDine.id,
      date: "2026-05-15",
      guestCount: 4,
    }),
    "dine slots",
  );
  const dinePick = dineSlots.slots.find((s) => s.available && s.date === "2026-05-15" && s.time === "20:00") ??
    dineSlots.slots.find((s) => s.available);
  if (!dinePick) throw new Error("no available slot at all — fixture problem");
  const booking = unwrap(
    await call<Booking>("dineout", "book_table", {
      restaurantId: targetDine.id,
      slotId: dinePick.slotId,
      guestCount: 4,
      date: dinePick.date,
      time: dinePick.time,
    }),
    "book_table",
  );
  assert(booking.status === "CONFIRMED", `booked ${targetDine.name} at ${dinePick.time}`);

  // (b) Food order: Gelato Italia (dessert delivery)
  const foodSearch = unwrap(
    await call<{ restaurants: FoodRestaurant[] }>("food", "search_restaurants", {
      addressId: HOME,
      query: "gelato",
    }),
    "food search 'gelato'",
  );
  assert(
    foodSearch.restaurants.some((r) => r.name === "Gelato Italia"),
    "found Gelato Italia",
  );
  const gelatoId = foodSearch.restaurants.find((r) => r.name === "Gelato Italia")!.id;

  await call<FoodCart>("food", "update_food_cart", {
    restaurantId: gelatoId,
    items: [{ itemId: "item_g001", quantity: 2, variantId: "var_g001a" }],
  });
  const gelOrder = unwrap(
    await call<Order>("food", "place_food_order", { addressId: HOME }),
    "place gelato order",
  );
  assert(gelOrder.status === "PLACED", "gelato order placed");

  // We should have both order + booking visible to downstream "my evening" queries
  assert(store.orders.length >= 1, "store has the food order");
  assert(store.bookings.length >= 1, "store has the dineout booking");
}

// ---- search quality regressions ------------------------------------------
//
// Specific bug the user reported: searching for "milk" surfaced
// "Milky Mist Paneer" because the search did naïve substring matching
// on the brand field ("Milky Mist" contains the string "milk"). The
// new tokenized search must NOT return paneer for "milk".
async function searchQualityRegressions() {
  console.log(`\n${Y}== Search quality regressions ==${X}`);
  const milk = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "milk",
    }),
    "search_products(milk)",
  );
  const milkNames = milk.products.map((p) => p.name);
  assert(milkNames.includes("Milk"), "‘milk’ search returns the Milk product");
  assert(
    !milkNames.includes("Paneer"),
    "‘milk’ search does NOT return Paneer (brand 'Milky Mist' bug)",
    `got: ${milkNames.join(", ")}`,
  );

  // The companion direction: searching for "paneer" finds Paneer.
  const paneer = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "paneer",
    }),
    "search_products(paneer)",
  );
  assert(
    paneer.products.some((p) => p.name === "Paneer"),
    "‘paneer’ search finds the Paneer product (name hit)",
  );

  // Searching the brand explicitly should still work.
  const milky = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "milky",
    }),
    "search_products(milky)",
  );
  assert(
    milky.products.some((p) => p.brand === "Milky Mist"),
    "‘milky’ (exact brand token) finds Milky Mist products",
  );

  // Plural insensitivity: "onions" finds Onion (and not unrelated stuff).
  const onions = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "onions",
    }),
    "search_products(onions)",
  );
  assert(
    onions.products.some((p) => p.name === "Onion"),
    "‘onions’ (plural) finds singular ‘Onion’",
  );

  // Category search still works.
  const dairy = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "dairy",
    }),
    "search_products(dairy)",
  );
  assert(
    dairy.products.length >= 2,
    "‘dairy’ category search returns multiple dairy products",
  );

  // Unknown ingredient → empty array (don't pretend).
  const unknown = unwrap(
    await call<{ products: Product[] }>("im", "search_products", {
      addressId: HOME,
      query: "kebab",
    }),
    "search_products(kebab)",
  );
  assert(
    unknown.products.length === 0,
    "‘kebab’ (no such product) returns empty array (no false positives)",
    `got ${unknown.products.length} matches`,
  );
}

// ---- cart merge regression ----------------------------------------------
//
// Lock-in for the bug the user hit in the alfredo flow: agent adds
// butter, cream, garlic, then later calls `update_cart` for milk only.
// Previously this WIPED the basket (subtotal collapsed to ~₹62 and the
// minimum-order check started failing). update_cart now MERGES.

async function cartMergeRegression() {
  console.log(`\n${Y}== cart merge: update_cart only adjusts what you pass ==${X}`);
  resetForFreshRun();

  const milk = unwrap(
    await call<{ products: Product[] }>("im", "search_products", { addressId: HOME, query: "milk" }),
    "search_products(milk)",
  );
  const butter = unwrap(
    await call<{ products: Product[] }>("im", "search_products", { addressId: HOME, query: "butter" }),
    "search_products(butter)",
  );
  const cream = unwrap(
    await call<{ products: Product[] }>("im", "search_products", { addressId: HOME, query: "cream" }),
    "search_products(cream)",
  );
  const garlic = unwrap(
    await call<{ products: Product[] }>("im", "search_products", { addressId: HOME, query: "garlic" }),
    "search_products(garlic)",
  );

  assert(butter.products.length > 0, "butter is available");
  assert(cream.products.length > 0, "cream is available");
  assert(garlic.products.length > 0, "garlic is available");
  assert(milk.products.length > 0, "milk is available");
  if (!butter.products.length || !cream.products.length || !garlic.products.length || !milk.products.length) return;

  const butterSpin = butter.products[0].variants.find((v) => v.inStock)!.spinId;
  const creamSpin = cream.products[0].variants.find((v) => v.inStock)!.spinId;
  const garlicSpin = garlic.products[0].variants.find((v) => v.inStock)!.spinId;
  // Pick a 1L milk variant if available, else any in-stock.
  const milkVariant =
    milk.products[0].variants.find((v) => v.inStock && /1\s?l/i.test(v.name)) ??
    milk.products[0].variants.find((v) => v.inStock)!;
  const milkSpin = milkVariant.spinId;

  // Initial batch: butter + cream + garlic.
  const cart1 = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: [
        { spinId: butterSpin, quantity: 1 },
        { spinId: creamSpin, quantity: 1 },
        { spinId: garlicSpin, quantity: 1 },
      ],
    }),
    "update_cart([butter, cream, garlic])",
  );
  assert(cart1.items.length === 3, "first call: 3 items in cart");
  const subtotalAfterBatch = cart1.subtotal;

  // The bug-reproducer: add milk alone, the OLD code wipes the cart.
  const cart2 = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: [{ spinId: milkSpin, quantity: 1 }],
    }),
    "update_cart([milk]) preserves prior items",
  );

  const spinsAfter = cart2.items.map((i) => i.spinId);
  assert(spinsAfter.includes(butterSpin), "butter survives the milk add");
  assert(spinsAfter.includes(creamSpin), "cream survives the milk add");
  assert(spinsAfter.includes(garlicSpin), "garlic survives the milk add");
  assert(spinsAfter.includes(milkSpin), "milk is now in the cart");
  assert(cart2.items.length === 4, "cart has 4 items, not 1");
  assert(
    cart2.subtotal === subtotalAfterBatch + milkVariant.price,
    "subtotal = batch + milk (no items vanished)",
    `${cart2.subtotal} vs expected ${subtotalAfterBatch + milkVariant.price}`,
  );

  // Quantity update on an existing line: SET to new value.
  const cart3 = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: [{ spinId: milkSpin, quantity: 2 }],
    }),
    "update_cart([milk x2]) sets quantity",
  );
  const milkLine = cart3.items.find((i) => i.spinId === milkSpin)!;
  assert(milkLine.quantity === 2, "milk quantity is now 2");
  assert(cart3.items.length === 4, "still 4 distinct items (no duplicates)");

  // Remove an item by passing quantity = 0.
  const cart4 = unwrap(
    await call<InstamartCart>("im", "update_cart", {
      addressId: HOME,
      items: [{ spinId: garlicSpin, quantity: 0 }],
    }),
    "update_cart([garlic q0]) removes",
  );
  assert(
    !cart4.items.some((i) => i.spinId === garlicSpin),
    "garlic removed by quantity=0",
  );
  assert(cart4.items.length === 3, "3 items remain after removal");

  // productId is populated so the UI can dedupe cards.
  assert(
    cart4.items.every((i) => typeof i.productId === "string" && i.productId.length > 0),
    "every cart item carries its productId",
  );
}

// ---- runner --------------------------------------------------------------

async function main() {
  console.log("\nKitchen Copilot mock-layer scenario tests");
  console.log(`${D}validates PRD §3.1-§3.4 flows against the seed data${X}`);

  await scoutOrderBiryani();
  await scoutMenuFiltering();
  await scoutMultiCartSwitch();
  await scoutCartCap();
  await auditorRecipeGap();
  await auditorMinOrderGate();
  await auditorGoToReorder();
  await negotiator30MinFlex();
  await negotiatorSimilarVibes();
  await negotiatorIdempotency();
  await voiceContractHygiene();
  await combinedPlanMyEvening();
  await searchQualityRegressions();
  await cartMergeRegression();

  console.log("");
  if (failed === 0) {
    console.log(`${G}\u2713 ${passed} assertions across 13 PRD scenarios all green.${X}\n`);
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
