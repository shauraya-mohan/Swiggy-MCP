// Mock implementations for the 8 Swiggy Dineout MCP tools.
// Shapes mirror docs at https://mcp.swiggy.com/builders/docs/reference/dineout/

import { seed } from "./data";
import { err, genId, jitterDelay, lowerIncludes, nowIso, ok } from "./helpers";
import { store } from "./store";
import type {
  Booking,
  DineoutLocation,
  DineoutRestaurant,
  DineoutRestaurantDetails,
  DineoutSlot,
  DineoutSlotBand,
  SwiggyResponse,
} from "./types";

const DAYS_FORWARD = 7;

// Deterministic-but-realistic slot generator: every 30 min from noon to 11pm,
// minus a sprinkling of unavailable slots so the negotiator module has something
// to negotiate over.
function generateSlots(restaurantId: string, dateStr: string): DineoutSlot[] {
  const slots: DineoutSlot[] = [];
  // Seed pseudo-randomness off restaurantId + date so the unavailable set
  // is stable per call.
  const seedNum = [...restaurantId + dateStr].reduce(
    (acc, c) => acc + c.charCodeAt(0),
    0,
  );
  let r = seedNum;
  const rng = () => {
    r = (r * 9301 + 49297) % 233280;
    return r / 233280;
  };

  // Restaurants run two services with a dead zone in between:
  //   LUNCH   12:00 – 15:30
  //   (closed 16:00 – 17:30 — staff break, no slots generated)
  //   DINNER  18:00 – 22:30
  //
  // The previous "everything 12:00–16:00 is LUNCH, after that DINNER"
  // split made the Negotiator panel surface 4:30 PM as "DINNER", which
  // the user (correctly) flagged as wrong — 4:30 PM is tea time, not
  // dinner. Skipping the dead zone means the agent and the panel can
  // only ever speak about realistic service times, and "DINNER" slots
  // actually mean what people mean when they say dinner.
  const lunchStart = 12;
  const lunchEnd = 15; // last lunch hour (12, 12:30, … 15, 15:30)
  const dinnerStart = 18;
  const dinnerEnd = 22; // last dinner hour (18, 18:30, … 22, 22:30)

  for (let hour = lunchStart; hour <= dinnerEnd; hour++) {
    const inLunch = hour >= lunchStart && hour <= lunchEnd;
    const inDinner = hour >= dinnerStart && hour <= dinnerEnd;
    if (!inLunch && !inDinner) continue; // skip the dead zone

    for (const min of [0, 30]) {
      const time = `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
      const band: DineoutSlotBand = inLunch ? "LUNCH" : "DINNER";
      // 20% of slots unavailable on the requested date for variety.
      const available = rng() > 0.2;
      slots.push({
        slotId: genId("slot"),
        date: dateStr,
        time,
        band,
        available,
        isFree: true,
      });
    }
  }
  return slots;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// --- 1. get_saved_locations -----------------------------------------------

export async function get_saved_locations(_args: object = {}): Promise<SwiggyResponse<DineoutLocation[]>> {
  await jitterDelay();
  return ok(seed.savedLocations);
}

// --- 2. search_restaurants_dineout ----------------------------------------

export interface SearchRestaurantsDineoutArgs {
  lat: number;
  lng: number;
  query?: string;
  offset?: number;
}

export async function search_restaurants_dineout(args: SearchRestaurantsDineoutArgs): Promise<SwiggyResponse<{
  restaurants: DineoutRestaurant[];
  nextOffset: number | null;
}>> {
  await jitterDelay();
  if (typeof args.lat !== "number" || typeof args.lng !== "number") {
    return err("lat and lng are required");
  }
  const q = args.query?.toLowerCase() ?? "";
  const matches = seed.dineoutRestaurants.filter((r) => {
    if (!q) return true;
    return (
      lowerIncludes(r.name, q) ||
      r.cuisines.some((c) => lowerIncludes(c, q)) ||
      lowerIncludes(r.area, q)
    );
  });

  // Strip the detail-only fields when returning a search result.
  const restaurants: DineoutRestaurant[] = matches.map(
    ({ address: _a, timings: _t, about: _ab, exclusiveDeals: _e, menuImages: _m, ...rest }) =>
      rest,
  );

  return ok({ restaurants, nextOffset: null });
}

// --- 3. get_restaurant_details --------------------------------------------

export interface GetRestaurantDetailsArgs {
  restaurantId: string;
}

export async function get_restaurant_details(args: GetRestaurantDetailsArgs): Promise<SwiggyResponse<DineoutRestaurantDetails>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");
  const restaurant = seed.dineoutRestaurants.find((r) => r.id === args.restaurantId);
  if (!restaurant) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");
  return ok(restaurant);
}

// --- 4. get_available_slots -----------------------------------------------

export interface GetAvailableSlotsArgs {
  restaurantId: string;
  date: string;
  guestCount: number;
  /**
   * Optional time-of-day filter. When the user says "table tonight"
   * or "for dinner", the agent should pass `band: "DINNER"` so the
   * panel surfaces evening slots only. Same for `"LUNCH"`. When
   * absent the mock returns both bands and the mapper's heuristic
   * takes over (which is good for "table tomorrow" without a
   * time-of-day word — the agent should ask first, but if it
   * doesn't, we degrade gracefully).
   */
  band?: DineoutSlotBand;
  /**
   * User's preferred clock time as 24-hour "HH:MM" (e.g., "20:00"
   * for 8 PM). When passed, the response is narrowed to a 5-slot
   * window CENTERED on that time, so the Negotiator panel and the
   * agent's voice agree on which slots are being discussed —
   * including unavailable ones the agent might mention as "full".
   *
   * Without this, the mock returns the whole band and the mapper
   * picks the 5 earliest available, which silently hides any
   * specific time the user actually asked about. The user has
   * already gotten burned by this once: agent said "8 PM is full,
   * 7:30 or 8:30 available", but the panel showed 6/6:30/7/7:30/8:30
   * — no 8 PM card at all.
   */
  time?: string;
}

export async function get_available_slots(args: GetAvailableSlotsArgs): Promise<SwiggyResponse<{
  slots: DineoutSlot[];
  date: string;
  forwardDays: number;
  /** Echoed back so the UI mapper knows which band the agent asked for. */
  band?: DineoutSlotBand;
  /** Echoed back so the mapper can highlight the user's requested time. */
  centerTime?: string;
}>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");
  if (!args.date) return err("date is required (YYYY-MM-DD)");
  if (!args.guestCount || args.guestCount < 1) return err("guestCount is required");
  if (args.band && args.band !== "LUNCH" && args.band !== "DINNER") {
    return err("band must be either 'LUNCH' or 'DINNER' if provided");
  }
  if (args.time && !/^\d{1,2}:\d{2}$/.test(args.time)) {
    return err("time must be 24-hour 'HH:MM' if provided");
  }

  const restaurant = seed.dineoutRestaurants.find((r) => r.id === args.restaurantId);
  if (!restaurant) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");
  if (restaurant.availability === "FULLY_BOOKED") {
    return err(`${restaurant.name} is fully booked.`, "RESTAURANT_NOT_BOOKABLE");
  }

  const allSlots: DineoutSlot[] = [];
  for (let d = 0; d < DAYS_FORWARD; d++) {
    const dateStr = addDays(args.date, d);
    allSlots.push(...generateSlots(args.restaurantId, dateStr));
  }

  // Band filter narrows the panel to the user's intent. Without this
  // the panel happily surfaces 12 PM lunch when the user said "tonight"
  // because the mock returns every slot for 7 days. The agent is now
  // expected to pass `band` whenever the user mentioned a time-of-day
  // word (see Negotiator rules in agent/prompts/system.md).
  let filtered = args.band ? allSlots.filter((s) => s.band === args.band) : allSlots;

  // When the user said a specific time, narrow the response to a
  // 5-slot window centered on the closest match. This solves the
  // "agent talks about 8 PM but panel doesn't show 8 PM" mismatch:
  // both sides now see the same 5 slots — including the unavailable
  // ones the agent might call out by name.
  if (args.time) {
    filtered = centerWindowOnTime(filtered, args.date, args.time);
  }

  return {
    success: true,
    data: {
      slots: filtered,
      date: args.date,
      forwardDays: DAYS_FORWARD,
      ...(args.band ? { band: args.band } : {}),
      ...(args.time ? { centerTime: args.time } : {}),
    },
  };
}

/**
 * Narrow a slot pool to ±2 slots around the user's requested time on
 * the requested date. Returns 5 contiguous slots from the same day
 * (or fewer if the day doesn't have that many slots).
 *
 * Why "on the requested date" matters: the mock generates 7 days of
 * slots, but the user said "table tomorrow at 8 PM" — they don't
 * care about the day after that. Locking the window to the requested
 * date keeps the panel coherent with the user's mental model.
 */
function centerWindowOnTime(
  slots: DineoutSlot[],
  requestedDate: string,
  requestedTime: string,
): DineoutSlot[] {
  // Only the requested date counts; the other days are bonus context
  // the agent doesn't need for ±30 min flex.
  const day = slots.filter((s) => s.date === requestedDate);
  if (day.length === 0) return slots; // defensive: don't return empty
  // Sort chronologically so "before / after" semantics are honoured.
  day.sort((a, b) => a.time.localeCompare(b.time));

  // Convert HH:MM to minutes-since-midnight for distance comparison.
  const toMinutes = (t: string): number => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };
  const target = toMinutes(requestedTime);
  // Find the slot index in `day` that's closest to the requested time.
  let closestIdx = 0;
  let closestDist = Number.POSITIVE_INFINITY;
  day.forEach((s, i) => {
    const d = Math.abs(toMinutes(s.time) - target);
    if (d < closestDist) {
      closestDist = d;
      closestIdx = i;
    }
  });

  // Take a window of 5 around the closest match. Clamp to array bounds
  // (if the user said "10 PM" and 10 PM is the last slot, we still
  // want 5 slots — pad to the left).
  const WINDOW = 5;
  const half = Math.floor(WINDOW / 2); // 2 slots on each side, target in middle
  let start = closestIdx - half;
  let end = start + WINDOW;
  if (start < 0) {
    end -= start; // shift right by abs(start)
    start = 0;
  }
  if (end > day.length) {
    start -= end - day.length;
    end = day.length;
    if (start < 0) start = 0;
  }
  return day.slice(start, end);
}

// --- 5. create_cart -------------------------------------------------------

export interface CreateCartArgs {
  restaurantId: string;
  slotId: string;
  guestCount: number;
  // For now we only support DEAL_TICKET_PURCHASE (booking, isFree=true).
  type?: "DEAL_TICKET_PURCHASE";
}

export async function create_cart(args: CreateCartArgs): Promise<SwiggyResponse<{
  cartId: string;
  restaurantId: string;
  slotId: string;
  guestCount: number;
}>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");
  if (!args.slotId) return err("slotId is required");
  if (!args.guestCount) return err("guestCount is required");
  return ok({
    cartId: genId("dcart"),
    restaurantId: args.restaurantId,
    slotId: args.slotId,
    guestCount: args.guestCount,
  });
}

// --- 6. book_table --------------------------------------------------------

export interface BookTableArgs {
  restaurantId: string;
  /**
   * Optional. If the agent already called `get_available_slots` it can
   * pass the slotId from the panel for traceability. The mock doesn't
   * require it — time + date + restaurantId is enough to resolve the
   * slot deterministically (same RNG seed as get_available_slots).
   * This is what enables the "direct book without listing first" flow
   * when the user named a specific time.
   */
  slotId?: string;
  guestCount: number;
  date?: string;
  time?: string;
}

export async function book_table(args: BookTableArgs): Promise<SwiggyResponse<Booking>> {
  await jitterDelay(150, 300);
  if (!args.restaurantId) return err("restaurantId is required");
  if (!args.guestCount) return err("guestCount is required");

  const restaurant = seed.dineoutRestaurants.find((r) => r.id === args.restaurantId);
  if (!restaurant) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");

  if (restaurant.availability === "FULLY_BOOKED") {
    return err(`${restaurant.name} is fully booked at this time.`, "SLOT_UNAVAILABLE");
  }

  // ---- Specific-slot availability check ----
  //
  // When the agent goes "direct book" (user named a specific time, no
  // get_available_slots panel first), we still need to honour the
  // restaurant's actual schedule. Regenerate the slot list from the
  // same seed (restaurantId+date) and look up by time — that gives a
  // deterministic answer to "is 7 PM free?" without requiring the
  // agent to call get_available_slots first.
  //
  // If the slot is taken, return SLOT_UNAVAILABLE with the rationale
  // the agent can read back ("7 PM isn't free — here are nearby
  // times"). The prompt tells the agent to then fall back to
  // get_available_slots and show the user alternates.
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  if (args.time) {
    const slotsForDay = generateSlots(restaurant.id, date);
    const slot = slotsForDay.find((s) => s.time === args.time);
    if (!slot) {
      // Time outside service hours (e.g. 4 PM dead zone, or 11 PM).
      return err(
        `${restaurant.name} doesn't serve at ${args.time}. Lunch is 12:00–15:30, dinner is 18:00–22:30.`,
        "SLOT_UNAVAILABLE",
      );
    }
    if (!slot.available) {
      return err(
        `The ${args.time} slot at ${restaurant.name} is taken.`,
        "SLOT_UNAVAILABLE",
      );
    }
  }
  // Else: agent didn't pass time. Treat as a legacy slotId-only call;
  // we'll trust the slotId implicitly (can't reverse-lookup time from
  // a fresh-per-call slotId anyway).

  const booking: Booking = {
    bookingId: genId("bk"),
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    slotId: args.slotId ?? genId("slot"),
    date,
    time: args.time ?? "20:00",
    guestCount: args.guestCount,
    status: "CONFIRMED",
    bookedAt: nowIso(),
  };
  store.bookings.unshift(booking);
  return ok(booking, "Table booked.");
}

// --- 7. get_booking_status ------------------------------------------------

export interface GetBookingStatusArgs {
  bookingId?: string;
  restaurantId?: string;
  slotId?: string;
}

export async function get_booking_status(args: GetBookingStatusArgs): Promise<SwiggyResponse<Booking | null>> {
  await jitterDelay();
  let booking: Booking | undefined;
  if (args.bookingId) {
    booking = store.bookings.find((b) => b.bookingId === args.bookingId);
  } else if (args.restaurantId && args.slotId) {
    booking = store.bookings.find(
      (b) => b.restaurantId === args.restaurantId && b.slotId === args.slotId,
    );
  } else {
    return err("Pass either bookingId or (restaurantId + slotId).");
  }
  if (!booking) return ok(null, "No booking matches that identifier.");
  return ok(booking);
}

// --- 8. report_error ------------------------------------------------------

export interface ReportErrorArgs {
  tool: string;
  errorMessage: string;
  toolContext?: Record<string, unknown>;
}

export async function report_error(args: ReportErrorArgs): Promise<SwiggyResponse<{
  reportId: string;
  mailtoUrl: string;
  summary: string;
}>> {
  await jitterDelay();
  const reportId = genId("rep");
  const subject = encodeURIComponent(`MCP error report — Dineout — ${args.tool}`);
  const body = encodeURIComponent(
    `Report ID: ${reportId}\nTool: ${args.tool}\nError: ${args.errorMessage}\nContext: ${JSON.stringify(args.toolContext ?? {}, null, 2)}`,
  );
  return ok({
    reportId,
    mailtoUrl: `mailto:builders@swiggy.in?subject=${subject}&body=${body}`,
    summary: `Logged error report ${reportId} for ${args.tool}.`,
  });
}
