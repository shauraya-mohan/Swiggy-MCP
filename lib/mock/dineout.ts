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

  for (let hour = 12; hour <= 22; hour++) {
    for (const min of [0, 30]) {
      const time = `${hour.toString().padStart(2, "0")}:${min.toString().padStart(2, "0")}`;
      const band: DineoutSlotBand =
        hour < 15 ? "LUNCH" : hour < 18 ? "LUNCH" : "DINNER";
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
}

export async function get_available_slots(args: GetAvailableSlotsArgs): Promise<SwiggyResponse<{
  slots: DineoutSlot[];
  date: string;
  forwardDays: number;
}>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");
  if (!args.date) return err("date is required (YYYY-MM-DD)");
  if (!args.guestCount || args.guestCount < 1) return err("guestCount is required");

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

  return ok({
    slots: allSlots,
    date: args.date,
    forwardDays: DAYS_FORWARD,
  });
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
  slotId: string;
  guestCount: number;
  date?: string;
  time?: string;
}

export async function book_table(args: BookTableArgs): Promise<SwiggyResponse<Booking>> {
  await jitterDelay(150, 300);
  if (!args.restaurantId) return err("restaurantId is required");
  if (!args.slotId) return err("slotId is required");
  if (!args.guestCount) return err("guestCount is required");

  const restaurant = seed.dineoutRestaurants.find((r) => r.id === args.restaurantId);
  if (!restaurant) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");

  if (restaurant.availability === "FULLY_BOOKED") {
    return err(`${restaurant.name} is fully booked at this time.`, "SLOT_UNAVAILABLE");
  }

  const booking: Booking = {
    bookingId: genId("bk"),
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    slotId: args.slotId,
    date: args.date ?? new Date().toISOString().slice(0, 10),
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
