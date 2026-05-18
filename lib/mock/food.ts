// Mock implementations for the 14 Swiggy Food MCP tools.
// Shapes mirror docs at https://mcp.swiggy.com/builders/docs/reference/food/

import { seed } from "./data";
import { err, genId, jitterDelay, lowerIncludes, nowIso, ok } from "./helpers";
import { store } from "./store";
import type {
  FoodCart,
  FoodCartItem,
  FoodCoupon,
  FoodRestaurant,
  MenuItem,
  Order,
  OrderStatus,
  RestaurantMenu,
  SwiggyResponse,
} from "./types";

// Food cart cap from Swiggy docs — Builders Club orders capped at ₹1000.
const FOOD_CART_CAP = 1000;
const DELIVERY_FEE = 39;
const TAX_RATE = 0.05;
const PAGE_SIZE = 10;

function recomputeCart(cart: FoodCart): void {
  cart.subtotal = cart.items.reduce((acc, i) => acc + i.lineTotal, 0);
  cart.deliveryFee = cart.items.length ? DELIVERY_FEE : 0;
  cart.taxes = Math.round(cart.subtotal * TAX_RATE);
  cart.discount = cart.appliedCoupon
    ? cart.subtotal >= cart.appliedCoupon.minOrder
      ? cart.appliedCoupon.discount
      : 0
    : 0;
  cart.total = Math.max(0, cart.subtotal + cart.deliveryFee + cart.taxes - cart.discount);
  cart.capExceeded = cart.total > FOOD_CART_CAP;
}

function findMenuItem(restaurantId: string, itemId: string): MenuItem | null {
  const menu: RestaurantMenu | undefined = seed.menus[restaurantId];
  if (!menu) return null;
  for (const cat of menu.categories) {
    const found = cat.items.find((i) => i.id === itemId);
    if (found) return found;
  }
  return null;
}

// --- 1. get_addresses -----------------------------------------------------

export type GetAddressesArgs = Record<string, never>;

export async function get_addresses(_args: GetAddressesArgs = {}) {
  await jitterDelay();
  return ok(seed.addresses);
}

// --- 2. search_restaurants ------------------------------------------------

export interface SearchRestaurantsArgs {
  addressId: string;
  query: string;
  offset?: number;
}

export async function search_restaurants(args: SearchRestaurantsArgs): Promise<SwiggyResponse<{
  restaurants: FoodRestaurant[];
  nextOffset: number | null;
}>> {
  await jitterDelay();
  if (!args.addressId) return err("addressId is required");
  if (!args.query) return err("query is required");

  const q = args.query.toLowerCase();
  const matches = seed.foodRestaurants.filter((r) => {
    if (lowerIncludes(r.name, q)) return true;
    if (r.cuisines.some((c) => lowerIncludes(c, q))) return true;
    // Match on menu items — PRD §3.2 "find a place with spicy wings"
    const menu = seed.menus[r.id];
    if (!menu) return false;
    return menu.categories.some((cat) =>
      cat.items.some(
        (item) =>
          lowerIncludes(item.name, q) ||
          lowerIncludes(item.description, q) ||
          lowerIncludes(cat.name, q),
      ),
    );
  });

  // Mild ranking: open restaurants first, then by rating desc per docs guidance.
  matches.sort((a, b) => {
    if (a.availabilityStatus !== b.availabilityStatus) {
      return a.availabilityStatus === "OPEN" ? -1 : 1;
    }
    return b.rating - a.rating;
  });

  const offset = args.offset ?? 0;
  const page = matches.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + PAGE_SIZE < matches.length ? offset + PAGE_SIZE : null;

  return ok({ restaurants: page, nextOffset });
}

// --- 3. search_menu -------------------------------------------------------

export interface SearchMenuArgs {
  query: string;
  restaurantId?: string;
  addressId?: string;
}

export async function search_menu(args: SearchMenuArgs): Promise<SwiggyResponse<{
  results: Array<MenuItem & { restaurantId: string; restaurantName: string }>;
}>> {
  await jitterDelay();
  if (!args.query) return err("query is required");

  const q = args.query.toLowerCase();
  const restaurantsToScan = args.restaurantId
    ? [seed.menus[args.restaurantId]].filter(Boolean)
    : Object.values(seed.menus);

  const results: Array<MenuItem & { restaurantId: string; restaurantName: string }> = [];
  for (const menu of restaurantsToScan) {
    if (!menu) continue;
    for (const cat of menu.categories) {
      for (const item of cat.items) {
        if (
          lowerIncludes(item.name, q) ||
          lowerIncludes(item.description, q) ||
          lowerIncludes(cat.name, q)
        ) {
          results.push({
            ...item,
            restaurantId: menu.restaurantId,
            restaurantName: menu.restaurantName,
          });
        }
      }
    }
  }
  return ok({ results });
}

// --- 4. get_restaurant_menu -----------------------------------------------

export interface GetRestaurantMenuArgs {
  restaurantId: string;
}

export async function get_restaurant_menu(args: GetRestaurantMenuArgs): Promise<SwiggyResponse<RestaurantMenu>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");

  const menu = seed.menus[args.restaurantId];
  if (!menu) {
    // Empty menu skeleton for restaurants we haven't seeded — keeps the agent's
    // happy path alive instead of erroring.
    const r = seed.foodRestaurants.find((x) => x.id === args.restaurantId);
    if (!r) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");
    return ok({
      restaurantId: r.id,
      restaurantName: r.name,
      categories: [],
    });
  }
  return ok(menu);
}

// --- 5. update_food_cart --------------------------------------------------

export interface UpdateFoodCartArgs {
  restaurantId: string;
  items: Array<{
    itemId: string;
    quantity: number;
    variantId?: string;
    addOnIds?: string[];
  }>;
}

export async function update_food_cart(args: UpdateFoodCartArgs): Promise<SwiggyResponse<FoodCart>> {
  await jitterDelay();
  if (!args.restaurantId) return err("restaurantId is required");

  const restaurant = seed.foodRestaurants.find((r) => r.id === args.restaurantId);
  if (!restaurant) return err("Restaurant not found", "RESTAURANT_NOT_FOUND");
  if (restaurant.availabilityStatus !== "OPEN") {
    return err(`${restaurant.name} is currently ${restaurant.availabilityStatus.toLowerCase()}.`, "RESTAURANT_NOT_OPEN");
  }

  // Cart binds to a single restaurant — switching flushes per docs.
  if (
    store.foodCart.restaurantId &&
    store.foodCart.restaurantId !== args.restaurantId
  ) {
    store.foodCart.items = [];
    store.foodCart.appliedCoupon = null;
  }

  store.foodCart.restaurantId = restaurant.id;
  store.foodCart.restaurantName = restaurant.name;
  store.foodCart.items = [];

  for (const line of args.items) {
    if (line.quantity <= 0) continue;
    const item = findMenuItem(restaurant.id, line.itemId);
    if (!item) return err(`Item ${line.itemId} not found`, "ITEM_NOT_FOUND");

    const variant = line.variantId
      ? item.variants?.find((v) => v.id === line.variantId)
      : undefined;
    const addOns = (line.addOnIds ?? [])
      .map((id) => item.addOns?.find((a) => a.id === id))
      .filter((a): a is NonNullable<typeof a> => Boolean(a));

    const addOnSum = addOns.reduce((acc, a) => acc + a.price, 0);
    const unitPrice = item.price + (variant?.priceDelta ?? 0) + addOnSum;

    const cartItem: FoodCartItem = {
      itemId: item.id,
      name: item.name,
      variantId: variant?.id,
      variantName: variant?.name,
      addOnIds: line.addOnIds,
      addOnNames: addOns.length ? addOns.map((a) => a.name) : undefined,
      quantity: line.quantity,
      unitPrice,
      lineTotal: unitPrice * line.quantity,
    };
    store.foodCart.items.push(cartItem);
  }

  recomputeCart(store.foodCart);
  return ok(store.foodCart);
}

// --- 6. get_food_cart -----------------------------------------------------

export async function get_food_cart(_args: object = {}): Promise<SwiggyResponse<FoodCart>> {
  await jitterDelay();
  return ok(store.foodCart);
}

// --- 7. flush_food_cart ---------------------------------------------------

export async function flush_food_cart(_args: object = {}): Promise<SwiggyResponse<FoodCart>> {
  await jitterDelay();
  store.foodCart.items = [];
  store.foodCart.restaurantId = null;
  store.foodCart.restaurantName = undefined;
  store.foodCart.appliedCoupon = null;
  recomputeCart(store.foodCart);
  return ok(store.foodCart, "Cart flushed.");
}

// --- 8. fetch_food_coupons ------------------------------------------------

export async function fetch_food_coupons(_args: object = {}): Promise<SwiggyResponse<FoodCoupon[]>> {
  await jitterDelay();
  return ok(seed.coupons);
}

// --- 9. apply_food_coupon -------------------------------------------------

export interface ApplyFoodCouponArgs {
  code: string;
}

export async function apply_food_coupon(args: ApplyFoodCouponArgs): Promise<SwiggyResponse<FoodCart>> {
  await jitterDelay();
  if (!args.code) return err("Coupon code is required");

  const coupon = seed.coupons.find((c) => c.code === args.code);
  if (!coupon) return err("Invalid coupon code", "COUPON_INVALID");

  if (store.foodCart.subtotal < coupon.minOrder) {
    return err(
      `Cart subtotal ₹${store.foodCart.subtotal} is below minimum ₹${coupon.minOrder} for ${coupon.code}.`,
      "COUPON_MIN_NOT_MET",
    );
  }

  // v1 supports COD only — filter coupons that demand online payment.
  if (coupon.requiresOnlinePayment) {
    return err("This coupon requires online payment, but only COD is supported.", "COUPON_PAYMENT_MISMATCH");
  }

  store.foodCart.appliedCoupon = coupon;
  recomputeCart(store.foodCart);
  return ok(store.foodCart, `Applied ${coupon.code}.`);
}

// --- 10. place_food_order -------------------------------------------------

export interface PlaceFoodOrderArgs {
  addressId: string;
  paymentMethod?: "COD";
}

export async function place_food_order(args: PlaceFoodOrderArgs): Promise<SwiggyResponse<Order>> {
  await jitterDelay(120, 280);
  if (!args.addressId) return err("addressId is required");

  if (!store.foodCart.restaurantId || store.foodCart.items.length === 0) {
    return err("Cart is empty.", "CART_EMPTY");
  }
  if (store.foodCart.capExceeded) {
    return err(
      `Cart total ₹${store.foodCart.total} exceeds Builders Club cap of ₹${FOOD_CART_CAP}.`,
      "CART_CAP_EXCEEDED",
    );
  }
  if ((args.paymentMethod ?? "COD") !== "COD") {
    return err("Only COD payment is supported in v1.", "PAYMENT_METHOD_UNSUPPORTED");
  }

  const order: Order = {
    orderId: genId("ord"),
    type: "FOOD",
    restaurantId: store.foodCart.restaurantId,
    restaurantName: store.foodCart.restaurantName,
    addressId: args.addressId,
    status: "PLACED",
    items: store.foodCart.items.map((i) => ({
      name:
        i.variantName !== undefined ? `${i.name} (${i.variantName})` : i.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    })),
    subtotal: store.foodCart.subtotal,
    deliveryFee: store.foodCart.deliveryFee,
    taxes: store.foodCart.taxes,
    discount: store.foodCart.discount,
    total: store.foodCart.total,
    paymentMethod: "COD",
    placedAt: nowIso(),
    etaMinutes: 32,
    deliveryPartner: { name: "Rahul S.", phone: "+91 99XXXXXX23" },
  };
  store.orders.unshift(order);

  // Flush the cart now that order is placed.
  store.foodCart.items = [];
  store.foodCart.restaurantId = null;
  store.foodCart.restaurantName = undefined;
  store.foodCart.appliedCoupon = null;
  recomputeCart(store.foodCart);

  return ok(order, "Order placed.");
}

// --- 11. get_food_orders --------------------------------------------------

export async function get_food_orders(_args: object = {}): Promise<SwiggyResponse<{ orders: Order[] }>> {
  await jitterDelay();
  return ok({ orders: store.orders.filter((o) => o.type === "FOOD") });
}

// --- 12. get_food_order_details -------------------------------------------

export interface GetFoodOrderDetailsArgs {
  orderId: string;
}

export async function get_food_order_details(args: GetFoodOrderDetailsArgs): Promise<SwiggyResponse<Order>> {
  await jitterDelay();
  if (!args.orderId) return err("orderId is required");
  const order = store.orders.find((o) => o.orderId === args.orderId && o.type === "FOOD");
  if (!order) return err("Order not found", "ORDER_NOT_FOUND");
  return ok(order);
}

// --- 13. track_food_order -------------------------------------------------

const STATUS_PROGRESSION: OrderStatus[] = [
  "PLACED",
  "ACCEPTED",
  "PREPARING",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export interface TrackFoodOrderArgs {
  orderId: string;
}

export async function track_food_order(args: TrackFoodOrderArgs): Promise<SwiggyResponse<{
  orderId: string;
  status: OrderStatus;
  etaMinutes: number;
  etaSpoken: string;
  deliveryPartner?: Order["deliveryPartner"];
}>> {
  await jitterDelay();
  if (!args.orderId) return err("orderId is required");
  const order = store.orders.find((o) => o.orderId === args.orderId);
  if (!order) return err("Order not found", "ORDER_NOT_FOUND");

  // Auto-advance the status every time someone polls so the demo feels alive.
  const idx = STATUS_PROGRESSION.indexOf(order.status);
  if (idx >= 0 && idx < STATUS_PROGRESSION.length - 1) {
    order.status = STATUS_PROGRESSION[idx + 1];
    order.etaMinutes = Math.max(0, order.etaMinutes - 8);
  }

  const etaSpoken =
    order.status === "DELIVERED"
      ? "delivered"
      : order.etaMinutes <= 5
        ? "just a few minutes"
        : `about ${order.etaMinutes} minutes`;

  return ok({
    orderId: order.orderId,
    status: order.status,
    etaMinutes: order.etaMinutes,
    etaSpoken,
    deliveryPartner: order.deliveryPartner,
  });
}

// --- 14. report_error -----------------------------------------------------

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
  const subject = encodeURIComponent(`MCP error report — ${args.tool}`);
  const body = encodeURIComponent(
    `Report ID: ${reportId}\nTool: ${args.tool}\nError: ${args.errorMessage}\nContext: ${JSON.stringify(args.toolContext ?? {}, null, 2)}`,
  );
  return ok({
    reportId,
    mailtoUrl: `mailto:builders@swiggy.in?subject=${subject}&body=${body}`,
    summary: `Logged error report ${reportId} for ${args.tool}.`,
  });
}
