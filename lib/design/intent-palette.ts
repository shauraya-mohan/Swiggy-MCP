import type { IntentMode } from "@/lib/agent/manifest";

/**
 * INTENT_PALETTE — ported verbatim from aura.jsx in the design bundle.
 *
 * `h` (HSL hue) and `s` (saturation 0..1) seed the Aura canvas, and `accent`
 * is the picker swatch used in chrome (intent indicator, intent pill, etc.).
 * Idle is folded into the cook palette so the Aura always has a hue to draw.
 */
export interface IntentPaletteEntry {
  h: number;
  s: number;
  accent: string;
}

export const INTENT_PALETTE: Record<IntentMode, IntentPaletteEntry> = {
  cook: { h: 22, s: 0.95, accent: "#FC8019" },
  order: { h: 35, s: 0.55, accent: "#FFB070" },
  dine: { h: 175, s: 0.45, accent: "#6FD8C8" },
  idle: { h: 22, s: 0.95, accent: "#FC8019" },
};

export const INTENT_LABEL: Record<IntentMode, string> = {
  cook: "COOKING",
  order: "ORDERING",
  dine: "DINING OUT",
  idle: "READY",
};
