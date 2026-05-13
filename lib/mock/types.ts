// Shared types modeled after the Swiggy MCP response shapes documented at
// https://mcp.swiggy.com/builders/docs/reference/

// --- envelopes -------------------------------------------------------------

export interface SwiggyOk<T> {
  success: true;
  data: T;
  message?: string;
}

export interface SwiggyErr {
  success: false;
  error: { message: string; code?: string };
}

export type SwiggyResponse<T> = SwiggyOk<T> | SwiggyErr;

// --- common ---------------------------------------------------------------

export type AddressLabel = "Home" | "Work" | "Other";

export interface Address {
  id: string;
  label: AddressLabel;
  display: string;
  lat: number;
  lng: number;
}

// --- food -----------------------------------------------------------------

export type AvailabilityStatus = "OPEN" | "CLOSED" | "UNAVAILABLE";

export interface FoodRestaurant {
  id: string;
  name: string;
  cuisines: string[];
  rating: number;
  distanceKm: number;
  deliveryTimeRange: string;
  deliveryTimeSpoken: string;
  availabilityStatus: AvailabilityStatus;
  priceForTwo: number;
  imageUrl: string;
}

export interface MenuVariant {
  id: string;
  name: string;
  priceDelta: number;
}

export interface MenuAddOn {
  id: string;
  name: string;
  price: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  price: number;
  isVeg: boolean;
  category: string;
  rating?: number;
  imageUrl?: string;
  variants?: MenuVariant[];
  addOns?: MenuAddOn[];
}

export interface MenuCategory {
  name: string;
  items: MenuItem[];
}

export interface RestaurantMenu {
  restaurantId: string;
  restaurantName: string;
  categories: MenuCategory[];
}

export interface FoodCartItem {
  itemId: string;
  name: string;
  variantId?: string;
  variantName?: string;
  addOnIds?: string[];
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface FoodCoupon {
  code: string;
  description: string;
  discount: number;
  minOrder: number;
  requiresOnlinePayment: boolean;
}

export interface FoodCart {
  restaurantId: string | null;
  restaurantName?: string;
  items: FoodCartItem[];
  subtotal: number;
  deliveryFee: number;
  taxes: number;
  discount: number;
  total: number;
  appliedCoupon: FoodCoupon | null;
  capExceeded: boolean;
}

// --- instamart ------------------------------------------------------------

export type ProductUnit = "g" | "kg" | "ml" | "l" | "piece";

export interface ProductQuantity {
  value: number;
  unit: ProductUnit;
}

export interface ProductVariant {
  spinId: string;
  name: string;
  quantity: ProductQuantity;
  price: number;
  mrp: number;
  inStock: boolean;
  imageUrl?: string;
}

export interface Product {
  id: string;
  name: string;
  brand?: string;
  category: string;
  rating?: number;
  variants: ProductVariant[];
}

export interface GoToItem {
  spinId: string;
  productName: string;
  variantName: string;
  price: number;
  orderCount: number;
}

export interface InstamartCartItem {
  spinId: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface InstamartCart {
  addressId: string | null;
  items: InstamartCartItem[];
  subtotal: number;
  deliveryFee: number;
  taxes: number;
  total: number;
  minOrderMet: boolean;
}

// --- dineout --------------------------------------------------------------

export type DineoutAvailability = "AVAILABLE" | "FULLY_BOOKED";
export type DineoutSlotBand = "BREAKFAST" | "LUNCH" | "DINNER";

export interface DineoutLocation {
  id: string;
  label: string;
  lat: number;
  lng: number;
  area: string;
}

export interface DineoutRestaurant {
  id: string;
  name: string;
  cuisines: string[];
  rating: number;
  priceRange: string;
  area: string;
  distanceKm: number;
  amenities: string[];
  availability: DineoutAvailability;
  offers: string[];
  imageUrl?: string;
}

export interface DineoutRestaurantDetails extends DineoutRestaurant {
  address: string;
  timings: string;
  about: string;
  exclusiveDeals: string[];
  menuImages: string[];
}

export interface DineoutSlot {
  slotId: string;
  date: string;
  time: string;
  band: DineoutSlotBand;
  available: boolean;
  isFree: boolean;
}

export interface Booking {
  bookingId: string;
  restaurantId: string;
  restaurantName: string;
  slotId: string;
  date: string;
  time: string;
  guestCount: number;
  status: "CONFIRMED" | "PENDING" | "CANCELLED";
  bookedAt: string;
}

// --- orders ---------------------------------------------------------------

export type OrderStatus =
  | "PLACED"
  | "ACCEPTED"
  | "PREPARING"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

export type OrderType = "FOOD" | "INSTAMART";

export interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface DeliveryPartner {
  name: string;
  phone: string;
}

export interface Order {
  orderId: string;
  type: OrderType;
  restaurantId?: string;
  restaurantName?: string;
  addressId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  taxes: number;
  discount: number;
  total: number;
  paymentMethod: "COD";
  placedAt: string;
  etaMinutes: number;
  deliveryPartner?: DeliveryPartner;
}
