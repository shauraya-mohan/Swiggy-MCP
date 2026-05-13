// Single entrypoint for the mock layer.
//
// `callMockTool(server, tool, args)` is the only thing the tool router needs to
// know about. Each mock tool returns `{ success, data, message? }` shaped
// exactly like the real Swiggy MCP envelope, so swapping mock ↔ real later is
// a one-line change in the router.

import * as food from "./food";
import * as instamart from "./instamart";
import * as dineout from "./dineout";
import { err } from "./helpers";
import type { SwiggyResponse } from "./types";

export type SwiggyServer = "food" | "im" | "dineout";

type ToolFn = (args: unknown) => Promise<SwiggyResponse<unknown>>;

const REGISTRY: Record<SwiggyServer, Record<string, ToolFn>> = {
  food: {
    get_addresses: food.get_addresses as ToolFn,
    search_restaurants: food.search_restaurants as ToolFn,
    search_menu: food.search_menu as ToolFn,
    get_restaurant_menu: food.get_restaurant_menu as ToolFn,
    update_food_cart: food.update_food_cart as ToolFn,
    get_food_cart: food.get_food_cart as ToolFn,
    flush_food_cart: food.flush_food_cart as ToolFn,
    fetch_food_coupons: food.fetch_food_coupons as ToolFn,
    apply_food_coupon: food.apply_food_coupon as ToolFn,
    place_food_order: food.place_food_order as ToolFn,
    get_food_orders: food.get_food_orders as ToolFn,
    get_food_order_details: food.get_food_order_details as ToolFn,
    track_food_order: food.track_food_order as ToolFn,
    report_error: food.report_error as ToolFn,
  },
  im: {
    get_addresses: instamart.get_addresses as ToolFn,
    create_address: instamart.create_address as ToolFn,
    delete_address: instamart.delete_address as ToolFn,
    search_products: instamart.search_products as ToolFn,
    your_go_to_items: instamart.your_go_to_items as ToolFn,
    update_cart: instamart.update_cart as ToolFn,
    get_cart: instamart.get_cart as ToolFn,
    clear_cart: instamart.clear_cart as ToolFn,
    checkout: instamart.checkout as ToolFn,
    get_orders: instamart.get_orders as ToolFn,
    get_order_details: instamart.get_order_details as ToolFn,
    track_order: instamart.track_order as ToolFn,
    report_error: instamart.report_error as ToolFn,
  },
  dineout: {
    get_saved_locations: dineout.get_saved_locations as ToolFn,
    search_restaurants_dineout: dineout.search_restaurants_dineout as ToolFn,
    get_restaurant_details: dineout.get_restaurant_details as ToolFn,
    get_available_slots: dineout.get_available_slots as ToolFn,
    create_cart: dineout.create_cart as ToolFn,
    book_table: dineout.book_table as ToolFn,
    get_booking_status: dineout.get_booking_status as ToolFn,
    report_error: dineout.report_error as ToolFn,
  },
};

export const MOCK_TOOL_NAMES = {
  food: Object.keys(REGISTRY.food),
  im: Object.keys(REGISTRY.im),
  dineout: Object.keys(REGISTRY.dineout),
} as const;

export async function callMockTool(
  server: SwiggyServer,
  tool: string,
  args: unknown,
): Promise<SwiggyResponse<unknown>> {
  const serverTools = REGISTRY[server];
  if (!serverTools) {
    return err(`Unknown MCP server: ${server}`, "UNKNOWN_SERVER");
  }
  const fn = serverTools[tool];
  if (!fn) {
    return err(`Tool "${tool}" not found on server "${server}"`, "UNKNOWN_TOOL");
  }
  try {
    return await fn(args);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown internal error";
    return err(message, "INTERNAL_ERROR");
  }
}

// Re-export for ergonomics in tests / dev tools.
export { store } from "./store";
export type { SwiggyResponse } from "./types";
