// Tool result → AgentManifest visual patch.
//
// Every time the live-provider receives a SwiggyResponse from
// executeToolCall, it asks this module whether the result should light
// up any cards / the negotiator panel / a confirm sheet. Pure function,
// fully unit-testable, zero React, zero networking.
//
// Skipped on purpose (returns null):
//   - read-only context tools (get_addresses, get_food_cart,
//     fetch_food_coupons, get_saved_locations, get_restaurant_details,
//     get_food_orders / get_orders, get_food_order_details /
//     get_order_details, get_booking_status) — the agent narrates these,
//     they're not visual.
//   - food-side mutations (update_food_cart, apply_coupon,
//     place_food_order, book_table) — for v0.1 we let the agent's
//     spoken readback cover these. Step 9 may add ConfirmCard gating.
//   - errored envelopes (success === false) — we don't visualize errors;
//     the agent speaks them.
//
// Wired (returns cards):
//   - search_*, track_*, get_available_slots — see per-tool mappers.
//   - im__update_cart and im__get_cart — render basket items as
//     "✓ added" InstamartCards. Crucial for the shopping flow: the
//     user sees what they just added, even when the agent went straight
//     to update_cart without a fresh search_products call.

import type {
  CardData,
  ConfirmData,
  DeliveryCardData,
  DeliveryStage,
  InstamartCardData,
  NegotiatorData,
  NegotiatorSlot,
  RestaurantCardData,
} from "@/lib/agent/manifest";
import type { ToolServer } from "@/lib/mcp/manifest";
import type {
  Booking,
  DineoutSlot,
  DineoutSlotBand,
  FoodCart,
  FoodRestaurant,
  GoToItem,
  InstamartCart,
  InstamartCartItem,
  Order,
  OrderStatus,
  Product,
  ProductVariant,
  SwiggyResponse,
} from "@/lib/mock/types";

export interface ToolHandle {
  server: ToolServer;
  tool: string;
}

/**
 * What a single tool call adds to the manifest visually.
 * Each field is independent — a tool might add only cards
 * (search_restaurants), only a negotiator (get_available_slots), or
 * neither (status polls).
 */
export interface ToolCardPatch {
  /**
   * Cards to surface in the panel. Combined with `cardsMode` to decide
   * whether to wholesale replace what's there or merge with the existing
   * stack by id.
   */
  cards?: CardData[];
  /**
   * How `cards` should combine with what's already in the manifest.
   *
   *   "replace" (default) — the freshest tool result wins. Right for
   *     restaurant search ("choose one") and delivery tracking ("one
   *     order being tracked"), where the previous set is stale.
   *
   *   "upsert" — merge into the existing stack keyed by `card.id`. Right
   *     for Instamart shopping flows where the user builds a basket
   *     across multiple searches: searching for milk after adding
   *     garlic must keep the garlic card visible, not replace it. New
   *     ids append to the bottom of the panel; existing ids refresh
   *     in-place. See `upsertCards` for the precise semantics.
   *
   *   "sync-cart" — the cards represent the AUTHORITATIVE current cart
   *     state. Existing cards marked `state: "added"` whose id is NOT
   *     in the new set get DROPPED (the user removed them). Existing
   *     "default" (search-result) cards are kept as-is unless their id
   *     matches one of the new added cards, in which case they refresh.
   *     New added cards append to the bottom. Used by update_cart /
   *     get_cart so cart removals propagate to the panel.
   */
  cardsMode?: "replace" | "upsert" | "sync-cart";
  negotiator?: NegotiatorData;
  confirm?: ConfirmData;
}

/**
 * Merge a fresh tool's cards into the existing panel by id.
 *
 * Why:
 *   When a user is shopping on Instamart, the agent searches one
 *   ingredient at a time. Each search returns its own products. If we
 *   wholesale replace cards on each call, the basket-in-progress
 *   disappears — only the latest search is visible. Upserting by `id`
 *   keeps everything the user has seen so far while refreshing repeats
 *   (e.g., a second search for milk that re-finds the same SPIN
 *   updates the same card rather than duplicating it).
 *
 * Ordering:
 *   Existing cards stay in their slots (oldest at top). Genuinely-new
 *   ids append to the bottom — so the most recently mentioned product
 *   is the most visible one in the panel (the bottom is the focal
 *   point; the top fades into the mask).
 *
 * Cards with no stable `id` field (delivery) can't be deduped, so
 * they're appended verbatim. In practice the delivery code path uses
 * `cardsMode: "replace"` and never reaches this function.
 */
export function upsertCards(
  prev: CardData[] | undefined,
  next: CardData[],
): CardData[] {
  const result: CardData[] = [];
  const indexById = new Map<string, number>();

  const keyOf = (c: CardData): string | null => {
    if (c.kind === "restaurant" || c.kind === "instamart") return c.id;
    return null;
  };

  for (const c of prev ?? []) {
    const k = keyOf(c);
    if (k !== null) indexById.set(k, result.length);
    result.push(c);
  }
  for (const c of next) {
    const k = keyOf(c);
    if (k !== null && indexById.has(k)) {
      result[indexById.get(k)!] = c;
    } else {
      if (k !== null) indexById.set(k, result.length);
      result.push(c);
    }
  }
  return result;
}

/**
 * Sync the panel against an authoritative cart state.
 *
 * Difference from upsertCards: this one DROPS existing `state: "added"`
 * cards whose id is no longer in the new cart set. So when the agent
 * calls update_cart with quantity=0 for garlic, the garlic card vanishes
 * from the panel instead of lingering as a stale green card forever.
 *
 * What stays:
 *   - search-result cards (no state, or state="default") whose id is
 *     not in the new cart — the user might still be browsing.
 *   - non-instamart cards (restaurant, delivery) — those have their own
 *     lifecycle, this sync only owns the cart slice.
 *
 * What changes:
 *   - existing card matching a new cart card by id → replaced (refreshes
 *     to "added" state with current pack/qty info).
 *   - existing card with state="added" not in new cart → DROPPED.
 *   - new cart card whose id isn't on screen yet → appended.
 */
export function syncCartCards(
  prev: CardData[] | undefined,
  nextCart: CardData[],
): CardData[] {
  const cartIds = new Set<string>();
  for (const c of nextCart) {
    if (c.kind === "instamart") cartIds.add(c.id);
  }

  // Step 1 — keep non-instamart and non-stale instamart cards.
  const kept: CardData[] = [];
  for (const c of prev ?? []) {
    if (c.kind !== "instamart") {
      kept.push(c);
      continue;
    }
    if (c.state === "added" && !cartIds.has(c.id)) {
      // Was added, no longer in cart → drop it.
      continue;
    }
    kept.push(c);
  }

  // Step 2 — upsert the new cart cards onto the kept set.
  return upsertCards(kept, nextCart);
}

// =========================================================================
//  Helpers
// =========================================================================

/**
 * Parse a "25-35 MIN" / "20-30 min" Swiggy delivery range into a single
 * representative integer (midpoint). Defaults to 30 if parsing fails so
 * the card still renders something believable.
 */
export function parseEtaMinutes(range: string | undefined): number {
  if (!range) return 30;
  const matches = range.match(/(\d+)\s*-\s*(\d+)/);
  if (!matches) {
    const single = range.match(/(\d+)/);
    return single ? parseInt(single[1], 10) : 30;
  }
  const lo = parseInt(matches[1], 10);
  const hi = parseInt(matches[2], 10);
  return Math.round((lo + hi) / 2);
}

/**
 * Deterministic 0..360 hue from an id string — gives each card a stable
 * tint across re-renders without needing a server-side palette.
 * Cheap djb2-style hash; we don't need cryptographic distribution, just
 * something that looks varied across the 5–10 cards a user might see.
 */
export function hueFromId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/**
 * Minimum Viable Quantity rule (PRD §3.3 / system prompt §Auditor):
 * pick the smallest in-stock variant. If nothing's in stock, fall back
 * to the smallest overall so the card still shows something the agent
 * can comment on ("out of stock, here's the alternative").
 */
export function smallestInStockVariant(variants: ProductVariant[]): ProductVariant | null {
  if (variants.length === 0) return null;
  const inStock = variants.filter((v) => v.inStock);
  const pool = inStock.length > 0 ? inStock : variants;
  // Normalise quantities to a common unit-ish ordering: ml ≈ g, l → ml*1000,
  // kg → g*1000, piece → just count. Crude but adequate for ranking variants
  // of the same product.
  const score = (v: ProductVariant) => {
    const { value, unit } = v.quantity;
    switch (unit) {
      case "kg":
        return value * 1000;
      case "l":
        return value * 1000;
      case "g":
      case "ml":
        return value;
      case "piece":
        return value;
      default:
        return value;
    }
  };
  return [...pool].sort((a, b) => score(a) - score(b))[0];
}

/** A short, voice-friendly variant label: "500g pack" / "1L pack" / "Dozen". */
export function variantPackLabel(v: ProductVariant): string {
  // If the seed data gave us a hand-written name ("500g pack", "Dozen"),
  // prefer that — it's already voice-ready.
  if (v.name && v.name.trim().length > 0) return v.name;
  return `${v.quantity.value}${v.quantity.unit}`;
}

/** Order status → DeliveryCard stage (the orb's "stage" pill). */
export function stageFromOrderStatus(status: OrderStatus): DeliveryStage {
  switch (status) {
    case "PLACED":
    case "ACCEPTED":
    case "PREPARING":
      return "prep";
    case "OUT_FOR_DELIVERY":
      return "route";
    case "DELIVERED":
      return "arriving";
    default:
      return "prep";
  }
}

/** Order status → 0..1 progress. */
export function progressFromOrderStatus(status: OrderStatus): number {
  switch (status) {
    case "PLACED":
      return 0.1;
    case "ACCEPTED":
      return 0.25;
    case "PREPARING":
      return 0.45;
    case "OUT_FOR_DELIVERY":
      return 0.75;
    case "DELIVERED":
      return 1;
    default:
      return 0.1;
  }
}

/** Human-readable status string for the DeliveryCard's `status` line. */
export function statusLine(order: Order): string {
  const venue = order.restaurantName ?? (order.type === "INSTAMART" ? "Instamart" : "Your order");
  switch (order.status) {
    case "PLACED":
      return `${venue} · order placed`;
    case "ACCEPTED":
      return `${venue} · order accepted`;
    case "PREPARING":
      return `${venue} · preparing your order`;
    case "OUT_FOR_DELIVERY":
      return `${venue} · out for delivery`;
    case "DELIVERED":
      return `${venue} · delivered`;
    default:
      return `${venue} · in progress`;
  }
}

/** Slot band → short uppercase label for the NegotiatorSlot. */
export function slotBandLabel(band: DineoutSlotBand): string {
  switch (band) {
    case "BREAKFAST":
      return "BREAKFAST";
    case "LUNCH":
      return "LUNCH";
    case "DINNER":
      return "DINNER";
    default:
      return band;
  }
}

// =========================================================================
//  Per-tool mappers
// =========================================================================

function mapFoodSearchRestaurants(restaurants: FoodRestaurant[]): ToolCardPatch | null {
  // Empty result → no patch. Don't clobber whatever's currently
  // visible just because a follow-up search came up dry. The agent
  // verbally pivots ("nothing matched, want me to widen the search?")
  // while the user still has the previous options on screen.
  if (restaurants.length === 0) return null;
  // Top 3 by rating — matches the voice contract's "max 3 items per
  // spoken list" rule, so the visible cards == what the agent speaks.
  const top3 = [...restaurants].sort((a, b) => b.rating - a.rating).slice(0, 3);
  const cards: RestaurantCardData[] = top3.map((r) => ({
    kind: "restaurant",
    id: r.id,
    name: r.name,
    cuisine: r.cuisines.join(" · "),
    rating: r.rating,
    etaMinutes: parseEtaMinutes(r.deliveryTimeRange),
    price: r.priceForTwo,
    imageHue: hueFromId(r.id),
  }));
  // Replace: a restaurant search is a "choose one" moment — surfacing
  // both the previous query's options and the new one's would confuse
  // the user. The agent always narrates the freshest set.
  return { cards, cardsMode: "replace" };
}

function mapInstamartProducts(products: Product[]): ToolCardPatch | null {
  if (products.length === 0) return null;
  const cards: InstamartCardData[] = products
    .slice(0, 3) // keep the visible card stack manageable
    .map((p): InstamartCardData | null => {
      const v = smallestInStockVariant(p.variants);
      if (!v) return null;
      const displayName = p.brand ? `${p.brand} ${p.name}` : p.name;
      return {
        kind: "instamart",
        id: p.id,
        name: displayName,
        reason: v.inStock ? "Smallest in-stock pack" : "Out of stock — alternate",
        pack: variantPackLabel(v),
        price: v.price,
        imageHue: hueFromId(p.id),
      };
    })
    .filter((c): c is InstamartCardData => c !== null);
  if (cards.length === 0) return null;
  // Upsert: Instamart flows build a basket across multiple searches.
  // Each ingredient the agent searches must accrete on the panel, not
  // erase the previous one.
  return { cards, cardsMode: "upsert" };
}

function mapGoToItems(items: GoToItem[]): ToolCardPatch | null {
  if (items.length === 0) return null;
  const cards: InstamartCardData[] = items.slice(0, 4).map((i) => ({
    kind: "instamart",
    id: i.spinId,
    name: i.productName,
    reason: `Ordered ${i.orderCount}× — your go-to`,
    pack: i.variantName,
    price: i.price,
    imageHue: hueFromId(i.spinId),
  }));
  // Same reasoning as search_products: usuals join the basket without
  // erasing whatever the agent already searched up.
  return { cards, cardsMode: "upsert" };
}

/**
 * Map an Instamart cart (returned by update_cart / get_cart) to a set
 * of "added" InstamartCards. Used to surface basket items on the panel
 * even when the agent skipped a fresh search_products call (e.g., it
 * remembers the SPIN from earlier and goes straight to update_cart).
 *
 * Card id mirrors `InstamartCartItem.productId`, which is the SAME id
 * used by mapInstamartProducts. So sync-cart mode in the live-provider
 * cleanly *refreshes* a previously-shown search card into its "added"
 * state instead of stacking a second card next to it.
 *
 * Uses `cardsMode: "sync-cart"` semantics, not upsert: the cart
 * response is the AUTHORITATIVE basket state, so any existing card
 * marked "added" that is no longer in the cart (item was removed
 * via update_cart with quantity=0) gets dropped from the panel.
 * Plain upsert would leave stale "added" cards on screen forever.
 *
 * Empty cart returns a non-null patch so the sync still fires —
 * critical when the user removes the last item or runs clear_cart.
 */
function mapInstamartCart(cart: InstamartCart): ToolCardPatch {
  // Group cart items by productId. Same product, multiple variants
  // (e.g. milk 1L + milk 500ml both in cart) collapse into one card
  // with combined quantity, so the panel doesn't try to render two
  // cards with the same React key.
  const byProduct = new Map<string, InstamartCartItem[]>();
  for (const i of cart.items) {
    const list = byProduct.get(i.productId) ?? [];
    list.push(i);
    byProduct.set(i.productId, list);
  }

  const cards: InstamartCardData[] = [];
  for (const [productId, lines] of byProduct.entries()) {
    if (lines.length === 1) {
      const i = lines[0];
      cards.push({
        kind: "instamart",
        id: productId,
        name: i.productName,
        reason: i.quantity > 1 ? `Added · ×${i.quantity}` : "Added to cart",
        pack: i.variantName,
        price: i.unitPrice,
        imageHue: hueFromId(productId),
        state: "added",
      });
    } else {
      const totalQty = lines.reduce((a, l) => a + l.quantity, 0);
      const packs = lines.map((l) => `${l.variantName}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`).join(" + ");
      cards.push({
        kind: "instamart",
        id: productId,
        name: lines[0].productName,
        reason: `Added · ${packs}`,
        pack: `${lines.length} packs`,
        price: lines.reduce((a, l) => a + l.lineTotal, 0),
        imageHue: hueFromId(productId),
        state: "added",
      });
    }
  }
  return { cards, cardsMode: "sync-cart" };
}

// =========================================================================
//  Confirm card builders — visual receipts for mutations
// =========================================================================
//
// Every state-changing tool produces a transient ConfirmData so the
// panel briefly mirrors what the agent just did. The live-provider
// auto-dismisses it after ~2.5s (single slot — newest wins).
//
// These are SNAPSHOTS of the response state, not deltas, because the
// mapper is pure: it sees only the response, not the args that
// produced it. "Cart · 4 items · ₹234" is honest about what we know.

const fmtRupees = (n: number): string => `₹${Math.round(n)}`;

function confirmFromInstamartCart(cart: InstamartCart): ConfirmData {
  const n = cart.items.length;
  if (n === 0) {
    return { title: "Cart cleared", subtitle: "Empty basket" };
  }
  const subtitle =
    cart.minOrderMet
      ? `${fmtRupees(cart.total)} all-in · ready to checkout`
      : `${fmtRupees(cart.subtotal)} subtotal · ₹${99 - cart.subtotal} from minimum`;
  return {
    title: n === 1 ? "Cart · 1 item" : `Cart · ${n} items`,
    subtitle,
  };
}

function confirmFromFoodCart(cart: FoodCart): ConfirmData {
  const n = cart.items.length;
  if (n === 0) {
    return { title: "Food cart cleared", subtitle: "Empty basket" };
  }
  const subtitle = cart.restaurantName
    ? `${cart.restaurantName} · ${fmtRupees(cart.total)} all-in`
    : `${fmtRupees(cart.total)} all-in`;
  return {
    title: n === 1 ? "Food cart · 1 item" : `Food cart · ${n} items`,
    subtitle,
  };
}

function confirmFromPlacedOrder(order: Order): ConfirmData {
  const kind = order.type === "INSTAMART" ? "Instamart order placed" : "Food order placed";
  const partner = order.deliveryPartner?.name;
  const subtitle = partner
    ? `${partner} · ETA ${order.etaMinutes} min · ${fmtRupees(order.total)}`
    : `ETA ${order.etaMinutes} min · ${fmtRupees(order.total)}`;
  return { title: kind, subtitle };
}

function confirmFromBooking(booking: Booking): ConfirmData {
  const n = booking.guestCount;
  const subtitle = `${booking.restaurantName} · ${n} ${n === 1 ? "guest" : "guests"}`;
  return { title: `Booked · ${booking.time}`, subtitle };
}

function mapTrackOrder(order: Order): ToolCardPatch {
  const card: DeliveryCardData = {
    kind: "delivery",
    etaMinutes: order.etaMinutes,
    status: statusLine(order),
    progress: progressFromOrderStatus(order.status),
    stage: stageFromOrderStatus(order.status),
  };
  // Replace: one order at a time being tracked. A new track call always
  // supersedes the old delivery card.
  return { cards: [card], cardsMode: "replace" };
}

/**
 * Format a 24-hour HH:MM into a voice-friendly 12-hour clock like
 * "12:00 PM" / "7:30 PM". Used in the Negotiator panel because the
 * design speaks in human times, not machine times.
 */
function format12h(time: string): string {
  // Passthrough if already 12h-formatted (e.g. test fixtures that
  // hand-pass "8:00 PM"). Only transform raw 24h "HH:MM" inputs.
  if (/\b(AM|PM)\b/i.test(time)) return time;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return time;
  const h = Number(m[1]);
  const min = m[2];
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${min} ${ampm}`;
}

/**
 * Convert a YYYY-MM-DD to a human-readable date label relative to the
 * given "today" — "today", "tomorrow", or "Sat, May 30" for further
 * dates. Returns null on parse failure rather than guessing.
 */
function dateLabelFor(dateStr: string | undefined, now: Date): string | null {
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const target = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(target.getTime())) return null;

  // Compare in UTC midnight terms so timezone offsets don't shift
  // "today" by a day around midnight.
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const diffDays = Math.round(
    (target.getTime() - todayUtc.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  if (diffDays > 1 && diffDays < 7) {
    return target.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return target.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Drop slots whose (date, time) is in the past or within 30 min of now. */
function dropPastSlots(slots: DineoutSlot[], now: Date): DineoutSlot[] {
  const cutoff = new Date(now.getTime() + 30 * 60 * 1000);
  return slots.filter((s) => {
    // Build the slot's wall-clock moment. We treat the slot's HH:MM as
    // local time to the user's locale — slot times in the data layer
    // are already in the user's tz (see dineout mock).
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.time);
    if (!m) return true; // unparseable → keep, let the user see it
    const [h, min] = [Number(m[1]), Number(m[2])];
    const slotDate = new Date(`${s.date}T00:00:00`);
    slotDate.setHours(h, min, 0, 0);
    return slotDate.getTime() >= cutoff.getTime();
  });
}

export function mapAvailableSlots(
  slots: DineoutSlot[],
  requestedDate?: string,
  now: Date = new Date(),
  centerTime?: string,
): ToolCardPatch | null {
  // Empty slots → null (preserve whatever the negotiator was showing).
  // The agent will verbally pivot ("nothing tonight, try tomorrow?").
  if (slots.length === 0) return null;

  // 1. Drop slots that have already started (or start in <30 min) —
  //    you can't book a table for a time that's already gone. This
  //    is the single biggest fix for the "12 PM lunch shown at 2 PM"
  //    bug: at 1:54 PM, 12:00–14:00 slots get filtered out and the
  //    panel naturally surfaces afternoon/evening times.
  const future = dropPastSlots(slots, now);

  // If every slot is in the past (e.g. mock data dated yesterday),
  // fall back to the original list so the panel isn't empty — better
  // to show stale times than nothing.
  const pool = future.length > 0 ? future : slots;

  // 2. Decide whether to drop LUNCH slots entirely. The agent doesn't
  //    pass a "lunch vs dinner" hint — but if it's already past 1 PM
  //    and the user is asking about TODAY, "tonight" is almost
  //    certainly what they mean. Without this filter the panel
  //    happily surfaces tomorrow's lunch slot in the 5th position
  //    when today's lunch is filtered as past, which breaks
  //    `allSameDate` and degrades the headline to "Earliest available
  //    slots". Only drop lunch if dinner slots are actually available
  //    in the pool — otherwise something is better than nothing.
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);
  const askingAboutToday = requestedDate === today;
  const pastLunchPeak = now.getHours() >= 13;
  const dinnerSlotsExist = pool.some((s) => s.band === "DINNER");
  const preferDinner = askingAboutToday && pastLunchPeak && dinnerSlotsExist;
  const filteredPool = preferDinner ? pool.filter((s) => s.band === "DINNER") : pool;

  // 3. Dedupe by (time, band). The Negotiator panel only displays time +
  //    label, so multi-day responses must collapse to distinct times of
  //    day — otherwise the user sees "12:00 LUNCH" five times because
  //    the same lunch slot exists across 5 days. When the same (time,
  //    band) pair appears multiple times, prefer the one with the
  //    EARLIEST AVAILABLE date so the panel shows the soonest bookable
  //    option. Falls back to the earliest seen.
  const seen = new Map<string, DineoutSlot>();
  for (const s of filteredPool) {
    const key = `${s.time}__${s.band}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, s);
      continue;
    }
    // Prefer available > unavailable; then earliest date.
    const replaceWithS =
      (!existing.available && s.available) ||
      (existing.available === s.available && s.date < existing.date);
    if (replaceWithS) seen.set(key, s);
  }
  const unique = Array.from(seen.values());

  // 4. Sort chronologically. Earlier versions of this mapper sorted
  //    available-first, which silently HID unavailable slots the
  //    agent talked about by name ("8 PM is full") — the panel just
  //    didn't show 8 PM at all, leaving the user confused about
  //    which slot was full. Now availability lives entirely in the
  //    per-slot `available` flag and the UI dims accordingly; the
  //    chronological order keeps the agent's narrative and the
  //    panel pointing at the same time window.
  const sorted = unique
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return a.time.localeCompare(b.time);
    })
    .slice(0, 5);

  const negotiatorSlots: NegotiatorSlot[] = sorted.map((s) => ({
    id: s.slotId,
    time: format12h(s.time),
    label: slotBandLabel(s.band),
    available: s.available,
  }));

  // Decide which slot to focus. Without a hint we focus the first
  // AVAILABLE slot rather than blindly index 0 — the agent never
  // recommends a full slot, so the orange-highlighted "CONFIRM"
  // button shouldn't point at one either. If `centerTime` was
  // passed (user asked for 8 PM specifically), focus the matching
  // card so the panel lines up with the agent's pick.
  let focusedSlotIndex = sorted.findIndex((s) => s.available);
  if (focusedSlotIndex < 0) focusedSlotIndex = 0;
  if (centerTime) {
    const exactIdx = sorted.findIndex((s) => s.time === centerTime);
    if (exactIdx >= 0 && sorted[exactIdx].available) {
      focusedSlotIndex = exactIdx;
    } else {
      // Center time is unavailable (the "8 PM is full" case). Focus
      // the closest available slot so the CONFIRM button has a
      // valid target without lying about the requested time.
      const toMin = (t: string) => {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      };
      const ct = toMin(centerTime);
      const closestAvailable = sorted
        .map((s, i) => ({ i, dist: Math.abs(toMin(s.time) - ct), avail: s.available }))
        .filter((x) => x.avail)
        .sort((a, b) => a.dist - b.dist)[0];
      if (closestAvailable) focusedSlotIndex = closestAvailable.i;
    }
  }

  // 5. Headline reflects what's actually on the panel + the requested
  //    date. The label below is the user-facing receipt that we dialled
  //    the right day; the headline tells them what band of times we
  //    found.
  const firstDate = sorted[0]?.date;
  const allSameDate = sorted.every((s) => s.date === firstDate);
  const anyDinner = sorted.some((s) => s.band === "DINNER");
  const anyLunch = sorted.some((s) => s.band === "LUNCH");
  // Always derive the date label from what the user asked for. Falls
  // back to the first slot's date if the request didn't include one
  // (defensive — real Swiggy MCP always echoes it back).
  const dateLabel =
    dateLabelFor(requestedDate ?? firstDate, now) ?? undefined;

  let headline: string;
  if (allSameDate && firstDate === today) {
    headline =
      anyDinner && !anyLunch
        ? "Available tonight"
        : anyLunch && !anyDinner
          ? "Available today · lunch"
          : "Available today";
  } else if (allSameDate && firstDate) {
    const dow = new Date(`${firstDate}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      timeZone: "UTC",
    });
    headline =
      anyDinner && !anyLunch
        ? `Dinner · ${dow}`
        : anyLunch && !anyDinner
          ? `Lunch · ${dow}`
          : `Available · ${dow}`;
  } else {
    headline = "Earliest available slots";
  }

  return {
    negotiator: {
      headline,
      dateLabel,
      slots: negotiatorSlots,
      focusedSlotIndex,
      state: "choosing",
    },
  };
}

// =========================================================================
//  Public entry point
// =========================================================================

/**
 * Map a single tool result to a manifest patch.
 *
 * Contract:
 *   - body.success === false      → null (agent narrates the error)
 *   - tool has no visual surface  → null (most read-only context tools)
 *   - body.data shape unexpected  → null + console.warn (don't crash the UI
 *                                   on a slightly-off envelope from the
 *                                   real Swiggy MCP)
 *   - happy path                  → ToolCardPatch with one or more fields
 */
export function cardFromToolResult(
  handle: ToolHandle,
  body: SwiggyResponse<unknown>,
): ToolCardPatch | null {
  if (!body.success) return null;
  const key = `${handle.server}__${handle.tool}`;
  const data = body.data as Record<string, unknown> | unknown;

  switch (key) {
    case "food__search_restaurants": {
      const d = data as { restaurants?: FoodRestaurant[] };
      if (!Array.isArray(d?.restaurants)) return null;
      return mapFoodSearchRestaurants(d.restaurants);
    }

    case "food__track_food_order": {
      const order = data as Order;
      if (!order || typeof order.status !== "string") return null;
      return mapTrackOrder(order);
    }

    case "im__search_products": {
      const d = data as { products?: Product[] };
      if (!Array.isArray(d?.products)) return null;
      return mapInstamartProducts(d.products);
    }

    case "im__your_go_to_items": {
      const d = data as { items?: GoToItem[] };
      if (!Array.isArray(d?.items)) return null;
      return mapGoToItems(d.items);
    }

    case "im__update_cart": {
      const cart = data as InstamartCart;
      if (!cart || !Array.isArray(cart.items)) return null;
      // Sync the panel AND drop a confirm receipt. The receipt
      // auto-dismisses in the live-provider; only the latest one
      // survives in the single ConfirmData slot.
      return { ...mapInstamartCart(cart), confirm: confirmFromInstamartCart(cart) };
    }

    case "im__get_cart": {
      const cart = data as InstamartCart;
      if (!cart || !Array.isArray(cart.items)) return null;
      // Read-only — sync the panel but no confirm flash (nothing
      // actually changed; it's just a state read).
      return mapInstamartCart(cart);
    }

    case "im__checkout": {
      const order = data as Order;
      if (!order || typeof order.status !== "string") return null;
      // Mutation → confirm receipt. Also surface the delivery card
      // so the user has something to watch while it cooks.
      return {
        ...mapTrackOrder(order),
        confirm: confirmFromPlacedOrder(order),
      };
    }

    case "im__track_order": {
      const order = data as Order;
      if (!order || typeof order.status !== "string") return null;
      return mapTrackOrder(order);
    }

    case "food__update_food_cart": {
      const cart = data as FoodCart;
      if (!cart || !Array.isArray(cart.items)) return null;
      // For food, we don't render cart items as cards yet (restaurants
      // win that slot). Just emit the confirm receipt so the user sees
      // their basket grow.
      return { confirm: confirmFromFoodCart(cart) };
    }

    case "food__place_food_order": {
      const order = data as Order;
      if (!order || typeof order.status !== "string") return null;
      return {
        ...mapTrackOrder(order),
        confirm: confirmFromPlacedOrder(order),
      };
    }

    case "dineout__book_table": {
      const booking = data as Booking;
      if (!booking || typeof booking.bookingId !== "string") return null;
      return { confirm: confirmFromBooking(booking) };
    }

    case "dineout__get_available_slots": {
      const d = data as { slots?: DineoutSlot[]; date?: string; centerTime?: string };
      if (!Array.isArray(d?.slots)) return null;
      // Forward the date AND the user's requested time so the panel
      // can focus the matching card and stay in lockstep with the
      // agent's voice (especially when the requested time itself is
      // full — see centerTime handling in mapAvailableSlots).
      return mapAvailableSlots(d.slots, d.date, undefined, d.centerTime);
    }

    default:
      return null;
  }
}
