// Static seed data loaded from JSON. Single source of truth, frozen at module
// load so accidental mutations from a tool can't corrupt the fixtures.

import addressesJson from "@/data/mock/addresses.json";
import couponsJson from "@/data/mock/coupons.json";
import dineoutRestaurantsJson from "@/data/mock/dineout_restaurants.json";
import goToItemsJson from "@/data/mock/go_to_items.json";
import menusJson from "@/data/mock/menus.json";
import productsJson from "@/data/mock/products.json";
import restaurantsJson from "@/data/mock/restaurants.json";
import savedLocationsJson from "@/data/mock/saved_locations.json";

import type {
  Address,
  DineoutLocation,
  DineoutRestaurantDetails,
  FoodCoupon,
  FoodRestaurant,
  GoToItem,
  Product,
  RestaurantMenu,
} from "./types";

export const seed = {
  addresses: addressesJson.addresses as Address[],
  foodRestaurants: restaurantsJson.restaurants as FoodRestaurant[],
  menus: menusJson as Record<string, RestaurantMenu>,
  products: productsJson.products as Product[],
  goToItems: goToItemsJson.items as GoToItem[],
  dineoutRestaurants: dineoutRestaurantsJson.restaurants as DineoutRestaurantDetails[],
  savedLocations: savedLocationsJson.locations as DineoutLocation[],
  coupons: couponsJson.coupons as FoodCoupon[],
} as const;
