#!/usr/bin/env tsx
// End-to-end smoke for the exact user scenario:
//   1. search butter, cream, garlic, milk         (Auditor)
//   2. update_cart([butter, cream, garlic])       (first batch)
//   3. user later says "add milk"
//   4. update_cart([milk_1l])                     (the bug-trigger)
// After each step we run the SwiggyResponse through the same
// cardFromToolResult + upsertCards the live-provider uses, and dump
// what the panel would show. Catches code-level bugs that the unit
// tests don't (e.g. unexpected envelope shape from the mock).

import { callMockTool, store } from "../lib/mock";
import type { Address, InstamartCart, Product, SwiggyResponse } from "../lib/mock/types";
import { cardFromToolResult, upsertCards } from "../lib/agent/tool-card-mapper";
import type { CardData } from "../lib/agent/manifest";

store.resetAll();

// Narrow a SwiggyResponse to its success payload. The mock always
// succeeds in this smoke, so a failure here is a genuine test bug — we
// throw rather than limp on with `any`.
function okData<T>(r: SwiggyResponse<T>): T {
  if (!r.success) throw new Error(`expected success, got error: ${r.error.message}`);
  return r.data;
}

let cards: CardData[] | undefined = undefined;
let HOME = "";

function applyToolResult(
  server: "food" | "im" | "dineout",
  tool: string,
  body: SwiggyResponse<unknown>,
) {
  const patch = cardFromToolResult({ server, tool }, body);
  console.log(`\n>>> ${server}__${tool}`);
  console.log(`    envelope.success: ${body.success}`);
  if (body.success) {
    const d = body.data as Record<string, unknown>;
    if (Array.isArray((d as { products?: unknown }).products)) {
      console.log(`    data.products[].length: ${((d as { products: unknown[] }).products).length}`);
    }
    if (Array.isArray((d as { items?: unknown }).items)) {
      console.log(`    data.items[].length: ${((d as { items: unknown[] }).items).length}`);
    }
  }
  console.log(`    mapper patch: ${patch ? "yes" : "null"}`);
  if (patch) {
    console.log(`      cardsMode: ${patch.cardsMode ?? "(default replace)"}`);
    console.log(`      cards: ${patch.cards?.length ?? 0}`);
  }
  if (patch?.cards !== undefined) {
    const mode = patch.cardsMode ?? "replace";
    cards = mode === "upsert" ? upsertCards(cards, patch.cards) : patch.cards;
  }
  console.log(`    panel now: [${(cards ?? []).map((c) => {
    if (c.kind === "instamart") return `${c.name}${c.state === "added" ? " ✓" : ""}`;
    return c.kind;
  }).join(", ")}]`);
}

async function main() {
  const addrResp = (await callMockTool("food", "get_addresses", {})) as SwiggyResponse<Address[]>;
  if (!addrResp.success) throw new Error("get_addresses failed: " + JSON.stringify(addrResp));
  HOME = addrResp.data.find((a) => a.label === "Home")?.id ?? addrResp.data[0].id;

  // 1. Auditor searches each ingredient (the agent does this serially).
  const butter = await callMockTool("im", "search_products", { addressId: HOME, query: "butter" });
  applyToolResult("im", "search_products", butter);

  const cream = await callMockTool("im", "search_products", { addressId: HOME, query: "cream" });
  applyToolResult("im", "search_products", cream);

  const garlic = await callMockTool("im", "search_products", { addressId: HOME, query: "garlic" });
  applyToolResult("im", "search_products", garlic);

  // 2. User confirms — agent batches them into one update_cart.
  const ingr = [butter, cream, garlic].map((r) => {
    const d = okData(r as SwiggyResponse<{ products: Product[] }>);
    return d.products[0];
  });
  const batchItems = ingr.map((p) => ({
    spinId: p.variants.find((v) => v.inStock)!.spinId,
    quantity: 1,
  }));
  const batch = await callMockTool("im", "update_cart", {
    addressId: HOME,
    items: batchItems,
  });
  applyToolResult("im", "update_cart", batch);

  // 3. User says "add milk" — agent searches.
  const milk = await callMockTool("im", "search_products", { addressId: HOME, query: "milk" });
  applyToolResult("im", "search_products", milk);

  // 4. User: "1L please". Agent goes straight to update_cart with the 1L SPIN.
  const milkProd = okData(milk as SwiggyResponse<{ products: Product[] }>).products[0];
  const milk1L = milkProd.variants.find((v) => /1\s?l/i.test(v.name) && v.inStock) ?? milkProd.variants.find((v) => v.inStock)!;
  const milkAdd = await callMockTool("im", "update_cart", {
    addressId: HOME,
    items: [{ spinId: milk1L.spinId, quantity: 1 }],
  });
  applyToolResult("im", "update_cart", milkAdd);

  // 5. The cart inside the mock should still hold all 4 items.
  const cartNow = okData(milkAdd as SwiggyResponse<InstamartCart>);
  console.log(`\n=== final cart state from update_cart response ===`);
  console.log(`    items: ${cartNow.items.length}`);
  for (const i of cartNow.items) {
    console.log(`      - ${i.productName} (${i.variantName}) × ${i.quantity}  spin=${i.spinId} pid=${i.productId}`);
  }
  console.log(`    subtotal ₹${cartNow.subtotal} · delivery ₹${cartNow.deliveryFee} · tax ₹${cartNow.taxes} · total ₹${cartNow.total} · minOrderMet=${cartNow.minOrderMet}`);

  console.log(`\n=== final UI panel ===`);
  console.log(`    cards on screen: ${cards?.length ?? 0}`);
  for (const c of cards ?? []) {
    if (c.kind === "instamart") {
      console.log(`      - ${c.name} [${c.pack}]  state=${c.state ?? "default"}  id=${c.id}`);
    }
  }

  // Asserts (these are the questions the user asked).
  const expectedNames = ["Butter", "Fresh Cream", "Garlic", "Milk"];
  let allPresent = true;
  for (const n of expectedNames) {
    if (!cards?.some((c) => c.kind === "instamart" && c.name.toLowerCase().includes(n.toLowerCase()))) {
      console.error(`!! MISSING in panel: ${n}`);
      allPresent = false;
    }
  }
  const milkCard = cards?.find((c) => c.kind === "instamart" && c.name.toLowerCase().includes("milk")) as
    | (CardData & { state?: string; pack?: string })
    | undefined;
  const milkAdded = milkCard?.state === "added";
  const milkIs1L = milkCard?.pack?.toLowerCase().includes("1l") || milkCard?.pack?.toLowerCase().includes("1 l");

  console.log(`\n=== assertions ===`);
  console.log(`  ${allPresent ? "✓" : "✗"} all 4 ingredients show in panel`);
  console.log(`  ${milkAdded ? "✓" : "✗"} milk card is in 'added' state`);
  console.log(`  ${milkIs1L ? "✓" : "✗"} milk card shows 1L pack`);

  if (!allPresent || !milkAdded || !milkIs1L) {
    console.error("\nFAIL — the code path is NOT producing the expected milk card.");
    process.exit(1);
  } else {
    console.log("\nOK — code path produces milk card correctly.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
