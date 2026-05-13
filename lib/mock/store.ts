// Process-singleton in-memory store for mock mode.
//
// Real Swiggy MCP keeps cart / order state server-side, keyed to the OAuth
// session. The mock layer mimics that by holding state in a single object
// shared across all tool calls in this Node process. Good enough for local
// dev where one user drives the agent at a time.
//
// The `globalThis` dance keeps state alive across Next.js hot reloads in dev.

import type { Booking, FoodCart, InstamartCart, Order } from "./types";

class MockStore {
  foodCart: FoodCart = MockStore.emptyFoodCart();
  instamartCart: InstamartCart = MockStore.emptyInstamartCart();
  orders: Order[] = [];
  bookings: Booking[] = [];

  static emptyFoodCart(): FoodCart {
    return {
      restaurantId: null,
      items: [],
      subtotal: 0,
      deliveryFee: 0,
      taxes: 0,
      discount: 0,
      total: 0,
      appliedCoupon: null,
      capExceeded: false,
    };
  }

  static emptyInstamartCart(): InstamartCart {
    return {
      addressId: null,
      items: [],
      subtotal: 0,
      deliveryFee: 0,
      taxes: 0,
      total: 0,
      minOrderMet: false,
    };
  }

  resetAll(): void {
    this.foodCart = MockStore.emptyFoodCart();
    this.instamartCart = MockStore.emptyInstamartCart();
    this.orders = [];
    this.bookings = [];
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __kitchenCopilotMockStore: MockStore | undefined;
}

export const store: MockStore =
  globalThis.__kitchenCopilotMockStore ??
  (globalThis.__kitchenCopilotMockStore = new MockStore());
