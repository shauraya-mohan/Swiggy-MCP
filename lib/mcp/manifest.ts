// Tool manifest — the unified surface the agent sees.
//
// Each entry pairs the docs-defined Swiggy MCP tool with the agent-facing
// description that will be passed to OpenAI Realtime as `tools[*].description`.
// The descriptions are intentionally terse and outcome-shaped (what the tool
// produces, not how it works) so the model picks the right tool quickly.
//
// Source of truth: https://mcp.swiggy.com/builders/llms-full.txt
// Names here MUST match what the real Swiggy MCP servers expose — the mock
// layer and the eventual real client both dispatch by string name. The
// router test `npm run test:router` guards this invariant.

export type ToolServer = "food" | "im" | "dineout";

// Minimal JSON-Schema-ish shape — we don't pull a heavy validator.
// Good enough to (a) describe params to OpenAI Realtime and (b) check
// `required` server-side before dispatching.
export interface ToolParameters {
  type: "object";
  properties: Record<string, ToolParamSchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolParamSchema {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  items?: ToolParamSchema;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  enum?: string[];
}

export interface ToolDef {
  server: ToolServer;
  name: string;
  description: string;
  parameters: ToolParameters;
  /** Mutating, non-idempotent tools. Gated by LIVE_MUTATIONS in real mode. */
  isMutation?: boolean;
}

// Reusable parameter fragments
const ADDRESS_ID: ToolParamSchema = {
  type: "string",
  description: "User's saved address id (from get_addresses). Default to Home unless the user picks otherwise.",
};
const RESTAURANT_ID: ToolParamSchema = { type: "string", description: "Food restaurant id." };
const SPIN_ID: ToolParamSchema = { type: "string", description: "Instamart product variant id (SPIN)." };
const QUANTITY: ToolParamSchema = { type: "integer", description: "Item quantity, 0 to remove the line." };
const QUERY: ToolParamSchema = { type: "string", description: "Free-text search query." };
const OFFSET: ToolParamSchema = { type: "integer", description: "Pagination offset; omit for first page." };

const EMPTY: ToolParameters = { type: "object", properties: {} };

// =========================================================================
//  Food — 14 tools
// =========================================================================

const FOOD_TOOLS: ToolDef[] = [
  {
    server: "food",
    name: "get_addresses",
    description: "List the user's saved delivery addresses. Call first to resolve Home before any search/cart/order tool.",
    parameters: EMPTY,
  },
  {
    server: "food",
    name: "search_restaurants",
    description: "Search restaurants near a saved address. Matches name, cuisine, and menu items (use for cravings like 'spicy wings').",
    parameters: {
      type: "object",
      properties: { addressId: ADDRESS_ID, query: QUERY, offset: OFFSET },
      required: ["addressId", "query"],
    },
  },
  {
    server: "food",
    name: "search_menu",
    description: "Cross-restaurant menu item search. Use when the user wants a specific dish without picking a restaurant first.",
    parameters: {
      type: "object",
      properties: { query: QUERY },
      required: ["query"],
    },
  },
  {
    server: "food",
    name: "get_restaurant_menu",
    description: "Fetch the full menu (categories, items, variants, add-ons) for a single restaurant.",
    parameters: {
      type: "object",
      properties: { restaurantId: RESTAURANT_ID },
      required: ["restaurantId"],
    },
  },
  {
    server: "food",
    name: "update_food_cart",
    description: "Set/replace cart lines for a restaurant. Switching restaurants flushes the cart — warn the user first.",
    parameters: {
      type: "object",
      properties: {
        restaurantId: RESTAURANT_ID,
        items: {
          type: "array",
          description: "Cart lines.",
          items: {
            type: "object",
            properties: {
              itemId: { type: "string" },
              quantity: QUANTITY,
              variantId: { type: "string", description: "Required if the item has variants." },
              addOnIds: { type: "array", items: { type: "string" } },
            },
            required: ["itemId", "quantity"],
          },
        },
      },
      required: ["restaurantId", "items"],
    },
  },
  {
    server: "food",
    name: "get_food_cart",
    description: "Read the current food cart. Always call before update_food_cart if a previous restaurant might be bound (multi-cart warning).",
    parameters: EMPTY,
  },
  {
    server: "food",
    name: "flush_food_cart",
    description: "Clear the food cart entirely. Use only after explicit user confirmation.",
    parameters: EMPTY,
  },
  {
    server: "food",
    name: "fetch_food_coupons",
    description: "List applicable coupons for the current cart. Filter requiresOnlinePayment=true since v1 is COD-only.",
    parameters: EMPTY,
  },
  {
    server: "food",
    name: "apply_food_coupon",
    description: "Apply a coupon code to the cart. Returns the updated cart with discount populated.",
    parameters: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    server: "food",
    name: "place_food_order",
    description: "Place the cart as a Cash-on-Delivery order. ALWAYS confirm cart total and delivery time with the user first. Non-idempotent.",
    parameters: {
      type: "object",
      properties: { addressId: ADDRESS_ID },
      required: ["addressId"],
    },
    isMutation: true,
  },
  {
    server: "food",
    name: "get_food_orders",
    description: "List the user's recent food orders. Use to find an order id without asking the user to repeat it.",
    parameters: EMPTY,
  },
  {
    server: "food",
    name: "get_food_order_details",
    description: "Get full details (items, totals, address) of a placed food order.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
  {
    server: "food",
    name: "track_food_order",
    description: "Get live status + ETA for a placed food order. Use etaSpoken for voice readback.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
  {
    server: "food",
    name: "report_error",
    description: "File a complaint against a food order (missing item, wrong dish, late delivery).",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        category: { type: "string", enum: ["MISSING_ITEM", "WRONG_ITEM", "LATE_DELIVERY", "QUALITY", "OTHER"] },
        description: { type: "string" },
      },
      required: ["orderId", "category", "description"],
    },
  },
];

// =========================================================================
//  Instamart — 13 tools
// =========================================================================

const IM_TOOLS: ToolDef[] = [
  {
    server: "im",
    name: "get_addresses",
    description: "List saved delivery addresses for Instamart. Call first to resolve Home.",
    parameters: EMPTY,
  },
  {
    server: "im",
    name: "create_address",
    description: "Save a new delivery address. Capture label, line1, city, pincode, lat, lng.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string" },
        line1: { type: "string" },
        line2: { type: "string" },
        city: { type: "string" },
        pincode: { type: "string" },
        lat: { type: "number" },
        lng: { type: "number" },
      },
      required: ["label", "line1", "city", "pincode", "lat", "lng"],
    },
  },
  {
    server: "im",
    name: "delete_address",
    description: "Remove a saved address by id.",
    parameters: {
      type: "object",
      properties: { addressId: ADDRESS_ID },
      required: ["addressId"],
    },
  },
  {
    server: "im",
    name: "search_products",
    description: "Search the Instamart catalogue. For MVQ pick the smallest in-stock variant; sort by rating for 'best' queries.",
    parameters: {
      type: "object",
      properties: { addressId: ADDRESS_ID, query: QUERY, offset: OFFSET },
      required: ["addressId", "query"],
    },
  },
  {
    server: "im",
    name: "your_go_to_items",
    description: "List the user's frequently ordered Instamart items. Use for fast 'reorder the usuals' flows.",
    parameters: {
      type: "object",
      properties: { addressId: ADDRESS_ID },
      required: ["addressId"],
    },
  },
  {
    server: "im",
    name: "update_cart",
    description: "Add/update/remove Instamart cart lines. Quantity 0 removes a line.",
    parameters: {
      type: "object",
      properties: {
        addressId: ADDRESS_ID,
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { spinId: SPIN_ID, quantity: QUANTITY },
            required: ["spinId", "quantity"],
          },
        },
      },
      required: ["addressId", "items"],
    },
  },
  {
    server: "im",
    name: "get_cart",
    description: "Read the current Instamart cart with subtotal/total/minOrderMet (₹99 minimum).",
    parameters: EMPTY,
  },
  {
    server: "im",
    name: "clear_cart",
    description: "Empty the Instamart cart entirely. Use only after explicit user confirmation.",
    parameters: EMPTY,
  },
  {
    server: "im",
    name: "checkout",
    description: "Place the Instamart cart as a COD order. Confirm contents + total with the user first. Non-idempotent.",
    parameters: EMPTY,
    isMutation: true,
  },
  {
    server: "im",
    name: "get_orders",
    description: "List the user's recent Instamart orders.",
    parameters: EMPTY,
  },
  {
    server: "im",
    name: "get_order_details",
    description: "Get full details of a placed Instamart order.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
  {
    server: "im",
    name: "track_order",
    description: "Get live status + ETA for an Instamart order. Use etaSpoken for voice.",
    parameters: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
  {
    server: "im",
    name: "report_error",
    description: "File a complaint against an Instamart order (missing, damaged, expired).",
    parameters: {
      type: "object",
      properties: {
        orderId: { type: "string" },
        category: { type: "string", enum: ["MISSING_ITEM", "WRONG_ITEM", "DAMAGED", "EXPIRED", "OTHER"] },
        description: { type: "string" },
      },
      required: ["orderId", "category", "description"],
    },
  },
];

// =========================================================================
//  Dineout — 8 tools
// =========================================================================

const DINEOUT_TOOLS: ToolDef[] = [
  {
    server: "dineout",
    name: "get_saved_locations",
    description: "List the user's saved dineout locations (lat/lng anchors for nearby searches).",
    parameters: EMPTY,
  },
  {
    server: "dineout",
    name: "search_restaurants_dineout",
    description: "Search bookable restaurants near lat/lng. Match by cuisine, name, or area. Filter availability=AVAILABLE.",
    parameters: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lng: { type: "number" },
        query: QUERY,
        offset: OFFSET,
      },
      required: ["lat", "lng", "query"],
    },
  },
  {
    server: "dineout",
    name: "get_restaurant_details",
    description: "Get full details for a single dineout restaurant (cuisines, ratings, area, price-for-two).",
    parameters: {
      type: "object",
      properties: { restaurantId: { type: "string" } },
      required: ["restaurantId"],
    },
  },
  {
    server: "dineout",
    name: "get_available_slots",
    description: "Get bookable time slots for a date + party size. Pass `band` when the user said a time-of-day word (tonight, dinner, lunch); pass `time` when the user said a specific hour so the panel and your voice talk about the same 5 slots.",
    parameters: {
      type: "object",
      properties: {
        restaurantId: { type: "string" },
        date: { type: "string", description: "ISO date YYYY-MM-DD." },
        guestCount: { type: "integer" },
        band: {
          type: "string",
          enum: ["LUNCH", "DINNER"],
          description: "Time-of-day filter. Use DINNER for tonight/this evening/dinner; LUNCH for noon/lunch. Omit only if the user gave no time-of-day signal and you've already asked them or are showing them the full day.",
        },
        time: {
          type: "string",
          description: "Preferred clock time in 24-hour 'HH:MM' (e.g., '20:00' for 8 PM). The response narrows to a 5-slot window centered on this time, INCLUDING any unavailable slots — so when you call out 'eight is full', the panel will show the 8 PM card dimmed and the user can see what you're talking about. Always pass this when the user mentioned a specific hour.",
        },
      },
      required: ["restaurantId", "date", "guestCount"],
    },
  },
  {
    server: "dineout",
    name: "create_cart",
    description: "Create an empty booking draft for a restaurant. Optional; book_table works without it.",
    parameters: {
      type: "object",
      properties: { restaurantId: { type: "string" } },
      required: ["restaurantId"],
    },
  },
  {
    server: "dineout",
    name: "book_table",
    description: "Confirm a table reservation. Confirm restaurant + slot + party size with the user first. Non-idempotent.",
    parameters: {
      type: "object",
      properties: {
        restaurantId: { type: "string" },
        slotId: { type: "string" },
        guestCount: { type: "integer" },
        date: { type: "string" },
        time: { type: "string", description: "HH:MM 24h." },
        specialRequests: { type: "string" },
      },
      required: ["restaurantId", "slotId", "guestCount", "date", "time"],
    },
    isMutation: true,
  },
  {
    server: "dineout",
    name: "get_booking_status",
    description: "Look up an existing booking by id, or by restaurantId+slotId (used for check-then-retry after a 5xx).",
    parameters: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        restaurantId: { type: "string" },
        slotId: { type: "string" },
      },
    },
  },
  {
    server: "dineout",
    name: "report_error",
    description: "File a complaint against a dineout booking.",
    parameters: {
      type: "object",
      properties: {
        bookingId: { type: "string" },
        category: { type: "string", enum: ["NO_SHOW_HONORED", "WAIT_TIME", "SERVICE", "BILLING", "OTHER"] },
        description: { type: "string" },
      },
      required: ["bookingId", "category", "description"],
    },
  },
];

// =========================================================================
//  Public manifest
// =========================================================================

export const TOOLS: ToolDef[] = [...FOOD_TOOLS, ...IM_TOOLS, ...DINEOUT_TOOLS];

/** Find a tool def by `{server, name}`. */
export function findTool(server: ToolServer, name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.server === server && t.name === name);
}

/** Tool names a model sees: `food:get_addresses`, `im:search_products`, etc. */
export function toolHandle(t: { server: ToolServer; name: string }): string {
  return `${t.server}:${t.name}`;
}

/** The 3 non-idempotent tools that LIVE_MUTATIONS gates. */
export const MUTATION_TOOLS = TOOLS.filter((t) => t.isMutation).map(toolHandle);
