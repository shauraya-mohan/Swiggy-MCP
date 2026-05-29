// Mock implementations for the 13 Swiggy Instamart MCP tools.
// Shapes mirror docs at https://mcp.swiggy.com/builders/docs/reference/instamart/

import { seed } from "./data";
import { err, genId, jitterDelay, nowIso, ok, scoreSearchMatch, tokenize } from "./helpers";
import { store } from "./store";
import type {
  Address,
  AddressLabel,
  GoToItem,
  InstamartCart,
  InstamartCartItem,
  Order,
  OrderStatus,
  Product,
  ProductVariant,
  SwiggyResponse,
} from "./types";

const INSTAMART_MIN_ORDER = 99;
const INSTAMART_DELIVERY_FEE = 25;
const TAX_RATE = 0.05;

function recomputeInstamartCart(cart: InstamartCart): void {
  cart.subtotal = cart.items.reduce((acc, i) => acc + i.lineTotal, 0);
  cart.deliveryFee = cart.items.length ? INSTAMART_DELIVERY_FEE : 0;
  cart.taxes = Math.round(cart.subtotal * TAX_RATE);
  cart.total = cart.subtotal + cart.deliveryFee + cart.taxes;
  cart.minOrderMet = cart.subtotal >= INSTAMART_MIN_ORDER;
}

function findVariant(spinId: string): { product: Product; variant: ProductVariant } | null {
  for (const product of seed.products) {
    const variant = product.variants.find((v) => v.spinId === spinId);
    if (variant) return { product, variant };
  }
  return null;
}

// In-memory address mutations (mock-only). Real Swiggy treats addresses as
// shared between Food and Instamart — this slice tracks anything added in-session.
const sessionAddresses: Address[] = [];

function allAddresses(): Address[] {
  return [...seed.addresses, ...sessionAddresses];
}

// --- 1. get_addresses -----------------------------------------------------

export async function get_addresses(_args: object = {}): Promise<SwiggyResponse<Address[]>> {
  await jitterDelay();
  return ok(allAddresses());
}

// --- 2. create_address ----------------------------------------------------

export interface CreateAddressArgs {
  label?: AddressLabel;
  display: string;
  lat: number;
  lng: number;
}

export async function create_address(args: CreateAddressArgs): Promise<SwiggyResponse<Address>> {
  await jitterDelay(80, 200);
  if (!args.display) return err("display is required");
  if (typeof args.lat !== "number" || typeof args.lng !== "number") {
    return err("lat and lng are required");
  }
  const address: Address = {
    id: genId("addr"),
    label: args.label ?? "Other",
    display: args.display,
    lat: args.lat,
    lng: args.lng,
  };
  sessionAddresses.push(address);
  return ok(address, "Address saved.");
}

// --- 3. delete_address ----------------------------------------------------

export interface DeleteAddressArgs {
  addressId: string;
}

export async function delete_address(args: DeleteAddressArgs): Promise<SwiggyResponse<{ addressId: string }>> {
  await jitterDelay();
  if (!args.addressId) return err("addressId is required");
  const idx = sessionAddresses.findIndex((a) => a.id === args.addressId);
  if (idx < 0) return err("Address not found or read-only.", "ADDRESS_NOT_FOUND");
  sessionAddresses.splice(idx, 1);
  return ok({ addressId: args.addressId }, "Address removed.");
}

// --- 4. search_products ---------------------------------------------------

export interface SearchProductsArgs {
  addressId: string;
  query: string;
  offset?: number;
}

export async function search_products(args: SearchProductsArgs): Promise<SwiggyResponse<{
  products: Product[];
  nextOffset: number | null;
}>> {
  await jitterDelay();
  if (!args.addressId) return err("addressId is required");
  if (!args.query) return err("query is required");

  // Token-scored search. See lib/mock/helpers.ts → scoreSearchMatch for
  // the scoring model. Critically, brand matching is exact-token-only
  // (no substring / no prefix) — so a search for "milk" no longer
  // surfaces "Milky Mist Paneer" via its brand.
  const queryTokens = tokenize(args.query);
  if (queryTokens.length === 0) return err("query is required");

  const scored = seed.products
    .map((p) => ({
      product: p,
      score: scoreSearchMatch(queryTokens, {
        name: p.name,
        category: p.category,
        brand: p.brand,
      }),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return (b.product.rating ?? 0) - (a.product.rating ?? 0);
    });

  return ok({ products: scored.map((x) => x.product), nextOffset: null });
}

// --- 5. your_go_to_items --------------------------------------------------

export interface YourGoToItemsArgs {
  addressId: string;
}

export async function your_go_to_items(args: YourGoToItemsArgs): Promise<SwiggyResponse<{ items: GoToItem[] }>> {
  await jitterDelay();
  if (!args.addressId) return err("addressId is required");
  return ok({ items: seed.goToItems });
}

// --- 6. update_cart -------------------------------------------------------

export interface UpdateCartArgs {
  addressId?: string;
  items: Array<{ spinId: string; quantity: number }>;
}

export async function update_cart(args: UpdateCartArgs): Promise<SwiggyResponse<InstamartCart>> {
  await jitterDelay();

  if (args.addressId) store.instamartCart.addressId = args.addressId;

  // MERGE semantics — the agent's mental model and the function name
  // both imply "update the cart with these changes", not "PUT the cart
  // wholesale". Each line in args.items adjusts ONE item:
  //
  //   quantity > 0  → upsert (set quantity to N, add if not present)
  //   quantity == 0 → remove this item
  //   quantity < 0  → skip (treat as no-op rather than error)
  //
  // Items already in the cart that are NOT mentioned in args stay
  // untouched. To clear the whole cart, use clear_cart.
  //
  // The previous implementation wiped store.items=[] before re-adding
  // — which meant the agent calling update_cart([milk]) after already
  // having [butter, cream, garlic] would lose the other three. This
  // showed up as "subtotal ₹92, below minimum" when the user expected
  // ₹230+. See scenarios.ts → cartMergeRegression for the regression
  // lock.

  for (const line of args.items) {
    if (line.quantity < 0) continue;

    if (line.quantity === 0) {
      store.instamartCart.items = store.instamartCart.items.filter(
        (i) => i.spinId !== line.spinId,
      );
      continue;
    }

    const found = findVariant(line.spinId);
    if (!found) return err(`Product variant ${line.spinId} not found`, "PRODUCT_NOT_FOUND");
    if (!found.variant.inStock) {
      return err(`${found.product.name} (${found.variant.name}) is out of stock.`, "OUT_OF_STOCK");
    }

    const cartItem: InstamartCartItem = {
      spinId: found.variant.spinId,
      productId: found.product.id,
      productName: found.product.name,
      variantName: found.variant.name,
      quantity: line.quantity,
      unitPrice: found.variant.price,
      lineTotal: found.variant.price * line.quantity,
    };

    const existingIdx = store.instamartCart.items.findIndex((i) => i.spinId === line.spinId);
    if (existingIdx >= 0) {
      store.instamartCart.items[existingIdx] = cartItem;
    } else {
      store.instamartCart.items.push(cartItem);
    }
  }

  recomputeInstamartCart(store.instamartCart);
  return ok(store.instamartCart);
}

// --- 7. get_cart ----------------------------------------------------------

export async function get_cart(_args: object = {}): Promise<SwiggyResponse<InstamartCart>> {
  await jitterDelay();
  return ok(store.instamartCart);
}

// --- 8. clear_cart --------------------------------------------------------

export async function clear_cart(_args: object = {}): Promise<SwiggyResponse<InstamartCart>> {
  await jitterDelay();
  store.instamartCart.items = [];
  store.instamartCart.addressId = null;
  recomputeInstamartCart(store.instamartCart);
  return ok(store.instamartCart, "Cart cleared.");
}

// --- 9. checkout ----------------------------------------------------------

export interface CheckoutArgs {
  paymentMethod?: "COD";
}

export async function checkout(args: CheckoutArgs): Promise<SwiggyResponse<Order>> {
  await jitterDelay(120, 280);
  if (!store.instamartCart.items.length) return err("Cart is empty.", "CART_EMPTY");
  if (!store.instamartCart.addressId) return err("No address selected.", "ADDRESS_MISSING");
  if (!store.instamartCart.minOrderMet) {
    return err(
      `Cart subtotal ₹${store.instamartCart.subtotal} is below Instamart minimum ₹${INSTAMART_MIN_ORDER}.`,
      "MIN_ORDER_NOT_MET",
    );
  }
  if ((args.paymentMethod ?? "COD") !== "COD") {
    return err("Only COD payment is supported in v1.", "PAYMENT_METHOD_UNSUPPORTED");
  }

  const order: Order = {
    orderId: genId("ord"),
    type: "INSTAMART",
    addressId: store.instamartCart.addressId,
    status: "PLACED",
    items: store.instamartCart.items.map((i) => ({
      name: `${i.productName} (${i.variantName})`,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    })),
    subtotal: store.instamartCart.subtotal,
    deliveryFee: store.instamartCart.deliveryFee,
    taxes: store.instamartCart.taxes,
    discount: 0,
    total: store.instamartCart.total,
    paymentMethod: "COD",
    placedAt: nowIso(),
    etaMinutes: 14,
    deliveryPartner: { name: "Priya M.", phone: "+91 98XXXXXX87" },
  };
  store.orders.unshift(order);

  // Clear the cart now that order is placed.
  store.instamartCart.items = [];
  store.instamartCart.addressId = null;
  recomputeInstamartCart(store.instamartCart);

  return ok(order, "Order placed.");
}

// --- 10. get_orders -------------------------------------------------------

export async function get_orders(_args: object = {}): Promise<SwiggyResponse<{ orders: Order[] }>> {
  await jitterDelay();
  return ok({ orders: store.orders.filter((o) => o.type === "INSTAMART") });
}

// --- 11. get_order_details ------------------------------------------------

export interface GetOrderDetailsArgs {
  orderId: string;
}

export async function get_order_details(args: GetOrderDetailsArgs): Promise<SwiggyResponse<Order>> {
  await jitterDelay();
  if (!args.orderId) return err("orderId is required");
  const order = store.orders.find((o) => o.orderId === args.orderId && o.type === "INSTAMART");
  if (!order) return err("Order not found", "ORDER_NOT_FOUND");
  return ok(order);
}

// --- 12. track_order ------------------------------------------------------

const STATUS_PROGRESSION: OrderStatus[] = [
  "PLACED",
  "ACCEPTED",
  "PREPARING",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

export interface TrackOrderArgs {
  orderId: string;
}

export async function track_order(args: TrackOrderArgs): Promise<SwiggyResponse<{
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

  const idx = STATUS_PROGRESSION.indexOf(order.status);
  if (idx >= 0 && idx < STATUS_PROGRESSION.length - 1) {
    order.status = STATUS_PROGRESSION[idx + 1];
    order.etaMinutes = Math.max(0, order.etaMinutes - 4);
  }

  const etaSpoken =
    order.status === "DELIVERED"
      ? "delivered"
      : order.etaMinutes <= 3
        ? "any moment now"
        : `about ${order.etaMinutes} minutes`;

  return ok({
    orderId: order.orderId,
    status: order.status,
    etaMinutes: order.etaMinutes,
    etaSpoken,
    deliveryPartner: order.deliveryPartner,
  });
}

// --- 13. report_error -----------------------------------------------------

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
  const subject = encodeURIComponent(`MCP error report — Instamart — ${args.tool}`);
  const body = encodeURIComponent(
    `Report ID: ${reportId}\nTool: ${args.tool}\nError: ${args.errorMessage}\nContext: ${JSON.stringify(args.toolContext ?? {}, null, 2)}`,
  );
  return ok({
    reportId,
    mailtoUrl: `mailto:builders@swiggy.in?subject=${subject}&body=${body}`,
    summary: `Logged error report ${reportId} for ${args.tool}.`,
  });
}
