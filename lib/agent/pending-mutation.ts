/**
 * pending-mutation — builds a PendingMutation preview from a tool call.
 *
 * The hard safety-rail companion to `tool-card-mapper.ts`:
 *
 *   tool-card-mapper  — after the tool runs, paints the result panel.
 *   pending-mutation  — BEFORE the tool runs, paints the consent sheet.
 *
 * The challenge: the agent's tool-call arguments are mostly opaque IDs
 * (`slotId: "slot_2025_06_04_1930"`, `spinId: "im_amul_milk_1l"`) which
 * are hostile to a "are you sure?" sheet. We solve that by reading from
 * the *current manifest*: the agent always shows the user something
 * (Negotiator slots, Instamart cards, Restaurant cards) before asking
 * to mutate, so the human-readable names are sitting right there.
 *
 *   book_table         → look up the slot in manifest.negotiator.slots
 *   checkout           → list the current cart items from manifest.cards
 *   place_food_order   → list the focused restaurant + its agentPick
 *
 * `im__update_cart` is intentionally NOT gated here (see the docs on
 * MutationToolName for why — cart adds are reversible and gating them
 * makes shopping feel like an interrogation).
 *
 * If context is missing (rare — would mean the agent skipped showing
 * before mutating) we fall back to the raw IDs so the sheet is still
 * shown and the user is never silently bypassed.
 */

import type {
  AgentManifest,
  InstamartCardData,
  MutationToolName,
  PendingMutation,
} from "@/lib/agent/manifest";

/**
 * The OpenAI-namespaced tool names we gate. Kept in sync with
 * `lib/mcp/manifest.ts` (`isMutation: true`) by the test in
 * scripts/test-pending-mutation.ts which asserts both sets match.
 */
export const MUTATION_TOOL_NAMES: ReadonlySet<MutationToolName> = new Set([
  "dineout__book_table",
  "im__checkout",
  "food__place_food_order",
]);

export function isMutationTool(toolName: string): toolName is MutationToolName {
  return MUTATION_TOOL_NAMES.has(toolName as MutationToolName);
}

// =========================================================================
//  Time formatting (24h → spoken)
// =========================================================================

/**
 * "19:30" → "7:30 PM". Defensive against malformed strings — returns
 * the input unchanged if it can't parse, so the sheet still renders
 * with the raw value rather than failing the whole gate.
 */
function formatTimeSpoken(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  if (Number.isNaN(h) || h < 0 || h > 23) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${min} ${period}`;
}

/**
 * Friendly date label for the sheet's slot row. "today" / "tomorrow"
 * (matches the language the user used out loud), or "Sat, Jun 7" for
 * dates further out. Always shows "today" if `date` is today's ISO,
 * never relying on a stringly-passed "today" — the model sometimes
 * passes ISO even when the user said "tonight".
 */
function formatDateFriendly(iso: string, now: Date = new Date()): string {
  // Accept "YYYY-MM-DD" or full ISO; we only care about the date.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!ymd) return iso;
  const d = new Date(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((target.getTime() - today.getTime()) / 86_400_000);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Tomorrow";
  if (dayDiff === -1) return "Yesterday";

  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ][d.getMonth()];
  return `${weekday}, ${month} ${d.getDate()}`;
}

// =========================================================================
//  Per-tool builders
// =========================================================================

/**
 * dineout__book_table — args:
 *   { restaurantId, slotId, guestCount, date, time, specialRequests? }
 *
 * `time` is the canonical slot time (HH:MM 24h). We pull the restaurant
 * name out of the Negotiator's headline if available; the slot's spoken
 * time we format ourselves from `time` so the sheet always reads in 12h
 * with AM/PM (matching how the user spoke it).
 */
function buildBookTablePreview(
  callId: string,
  args: Record<string, unknown>,
  manifest: AgentManifest,
): PendingMutation {
  const time = typeof args.time === "string" ? args.time : "";
  const date = typeof args.date === "string" ? args.date : "";
  const guests = typeof args.guestCount === "number" ? args.guestCount : null;
  const specialRequests =
    typeof args.specialRequests === "string" ? args.specialRequests.trim() : "";

  // Negotiator headline format the mapper produces: "Olive Bistro · DINNER".
  // Take everything before the first " · " as the restaurant name; if
  // there's no separator (older mapper) take the whole headline.
  const headline = manifest.negotiator?.headline ?? "";
  const restaurantName = headline.split("·")[0]?.trim() || "Selected restaurant";

  const dateLabel = date
    ? formatDateFriendly(date)
    : (manifest.negotiator?.dateLabel ?? "");
  const timeLabel = time ? formatTimeSpoken(time) : "";
  const whenRow = [dateLabel, timeLabel].filter(Boolean).join(" · ");

  const rows: string[] = [];
  if (whenRow) rows.push(whenRow);
  if (guests !== null) rows.push(`Table for ${guests}`);
  if (specialRequests) rows.push(`Note: ${specialRequests}`);

  return {
    callId,
    toolName: "dineout__book_table",
    title: "Confirm Booking",
    subtitle: restaurantName,
    rows,
    primaryLabel: "Book Table",
  };
}

/**
 * im__checkout — args: {} (the cart on file is what gets placed).
 *
 * Show the cart items + subtotal so the user can verify before paying.
 * This is the highest-stakes mutation — destructive cautionary copy.
 */
function buildCheckoutPreview(
  callId: string,
  _args: Record<string, unknown>,
  manifest: AgentManifest,
): PendingMutation {
  const cart = (manifest.cards ?? []).filter(
    (c) => c.kind === "instamart" && c.state === "added",
  ) as InstamartCardData[];

  const rows: string[] = cart.length
    ? cart.map((c) => `${c.name} · ${c.pack} — ₹${c.price}`)
    : ["Place the current Instamart cart"];

  const subtotal = cart.reduce((s, c) => s + c.price, 0);
  if (subtotal > 0) rows.push(`Total ₹${subtotal} · Cash on Delivery`);

  return {
    callId,
    toolName: "im__checkout",
    title: "Place Order",
    subtitle: "Instamart · Cash on Delivery",
    rows,
    primaryLabel: "Place Order",
    cautionary: "This will charge you on delivery and cannot be undone.",
  };
}

/**
 * food__place_food_order — args: { addressId }.
 *
 * Tricky one — by the time we get here the user has typically chosen a
 * restaurant from the cards. We try to surface that restaurant's name
 * and agent pick. If the manifest doesn't have a "selected" restaurant
 * we fall back to the first restaurant card, then to a generic line.
 */
function buildPlaceFoodOrderPreview(
  callId: string,
  _args: Record<string, unknown>,
  manifest: AgentManifest,
): PendingMutation {
  const restaurants = (manifest.cards ?? []).filter((c) => c.kind === "restaurant");
  const selected =
    restaurants.find((c) => c.kind === "restaurant" && c.state === "ordered") ?? restaurants[0];

  const rows: string[] = [];
  let subtotal = 0;

  if (selected && selected.kind === "restaurant") {
    if (selected.agentPick) {
      rows.push(`${selected.agentPick.item} — ₹${selected.agentPick.price}`);
      subtotal += selected.agentPick.price;
    } else {
      rows.push(`Order from ${selected.name}`);
      subtotal += selected.price;
    }
    rows.push(`ETA ≈ ${selected.etaMinutes} min · Cash on Delivery`);
  } else {
    rows.push("Place the current cart");
  }

  if (subtotal > 0) {
    rows.splice(rows.length - 1, 0, `Total ₹${subtotal}`);
  }

  return {
    callId,
    toolName: "food__place_food_order",
    title: "Place Order",
    subtitle: selected && selected.kind === "restaurant" ? selected.name : undefined,
    rows,
    primaryLabel: "Place Order",
    cautionary: "This will charge you on delivery and cannot be undone.",
  };
}

// =========================================================================
//  Entry point
// =========================================================================

/**
 * Build a PendingMutation preview for a gated tool call.
 *
 * Returns null for non-mutation tools (caller should fall through to
 * normal execution). Never throws on malformed args — the worst case
 * is a sheet with a few "Item" placeholders, which is still safer
 * than silently executing.
 *
 * Inputs:
 *   - call.name      — OpenAI tool handle e.g. "dineout__book_table"
 *   - call.call_id   — to round-trip through confirmMutation()
 *   - call.arguments — JSON string from the model (may be malformed)
 *   - manifest       — current visual state, used to look up names
 */
export function buildPendingMutation(
  call: { name: string; call_id: string; arguments: string },
  manifest: AgentManifest,
): PendingMutation | null {
  if (!isMutationTool(call.name)) return null;

  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.arguments || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON — fall through with empty args. The per-tool
    // builders are defensive against missing fields.
  }

  switch (call.name as MutationToolName) {
    case "dineout__book_table":
      return buildBookTablePreview(call.call_id, args, manifest);
    case "im__checkout":
      return buildCheckoutPreview(call.call_id, args, manifest);
    case "food__place_food_order":
      return buildPlaceFoodOrderPreview(call.call_id, args, manifest);
  }
}

// =========================================================================
//  Test-only exports (formatting helpers)
// =========================================================================

export const __test = {
  formatTimeSpoken,
  formatDateFriendly,
};
