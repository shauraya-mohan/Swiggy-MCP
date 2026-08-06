import type { SwiggyErr, SwiggyOk } from "./types";

export function ok<T>(data: T, message?: string): SwiggyOk<T> {
  return message ? { success: true, data, message } : { success: true, data };
}

export function err(message: string, code?: string): SwiggyErr {
  return code
    ? { success: false, error: { message, code } }
    : { success: false, error: { message } };
}

// Adds realistic-feeling latency so the agent doesn't get suspiciously instant
// answers from the mock layer.
export function jitterDelay(min = 60, max = 180): Promise<void> {
  const ms = Math.floor(min + Math.random() * (max - min));
  return new Promise((r) => setTimeout(r, ms));
}

export function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function lowerIncludes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

// ===========================================================================
//  Tokenized search — used by search_products / search_restaurants /
//  search_menu instead of naïve substring matching.
//
//  WHY: substring matching on the brand field meant "Milky Mist" matched a
//  user search for "milk" (because the string "milk" is a prefix of "milky"),
//  so a paneer product surfaced in milk searches. Token-with-plural-insensitivity
//  matching gives the obvious answer: "milk" matches "Milk" but not "Milky".
// ===========================================================================

/**
 * Split a string into lowercase word tokens, throwing away whitespace
 * and common punctuation. Returns an empty array for the empty string.
 *
 *   tokenize("Amul Gold Milk")   → ["amul", "gold", "milk"]
 *   tokenize("Milky Mist")       → ["milky", "mist"]
 *   tokenize("Chicken Curry Cut")→ ["chicken", "curry", "cut"]
 */
export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s,./_&()\-]+/)
    .filter((t) => t.length > 0);
}

/**
 * Loose token equality with very narrow plural insensitivity.
 *
 *   - exact:           "milk" ↔ "milk"
 *   - trailing -s:     "onion" ↔ "onions"
 *   - trailing -es:    "tomato" ↔ "tomatoes"
 *
 * Deliberately does NOT prefix-match — "milk" is NOT equal to "milky".
 * That was the whole point of moving off substring matching.
 *
 * The 4-char minimum prevents weird false positives on short tokens
 * (e.g. "as" ↔ "ass").
 */
export function tokenEquals(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4) {
    if (a + "s" === b || a === b + "s") return true;
    if (a + "es" === b || a === b + "es") return true;
  }
  return false;
}

/** Returns true if any token in `a` is `tokenEquals` to any token in `b`. */
export function tokensIntersect(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (tokenEquals(x, y)) return true;
    }
  }
  return false;
}

/**
 * Weighted relevance score for a single product / restaurant / menu item
 * against a list of query tokens. Each query token contributes to the
 * score at most once (highest-priority field hit wins), so a query like
 * "amul milk" gets +10 for the name hit AND +2 for the brand hit (each
 * token scored independently), not +12 from one stacking on the other.
 *
 * Default weights:
 *   name        → 10  (primary signal)
 *   category    →  3  (cuisine / department)
 *   brand       →  2  (alias; exact-token-only — no prefix matching)
 *   description →  1  (long tail)
 *
 * Caller decides whether a returned score of 0 means "drop this row" —
 * usually yes.
 */
export function scoreSearchMatch(
  queryTokens: string[],
  fields: {
    name?: string;
    category?: string | string[];
    brand?: string | string[];
    description?: string;
  },
  weights: { name?: number; category?: number; brand?: number; description?: number } = {},
): number {
  const w = { name: 10, category: 3, brand: 2, description: 1, ...weights };

  const toTokens = (v: string | string[] | undefined): string[] => {
    if (!v) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.flatMap((s) => tokenize(s));
  };

  const nameTokens = toTokens(fields.name);
  const categoryTokens = toTokens(fields.category);
  const brandTokens = toTokens(fields.brand);
  const descTokens = toTokens(fields.description);

  let score = 0;
  for (const qt of queryTokens) {
    if (tokensIntersect([qt], nameTokens)) score += w.name;
    else if (tokensIntersect([qt], categoryTokens)) score += w.category;
    else if (tokensIntersect([qt], brandTokens)) score += w.brand;
    else if (tokensIntersect([qt], descTokens)) score += w.description;
  }
  return score;
}
