/**
 * Typed access to the CSS custom properties defined in app/globals.css.
 *
 * Use these strings when a component needs to reference a token in inline
 * styles. The values are read from CSS at runtime — JS never sees the literal
 * hex codes, so changing a token in CSS is picked up everywhere.
 */
export const TOKEN = {
  bg0: "var(--bg-0)",
  bg1: "var(--bg-1)",
  bg2: "var(--bg-2)",
  fg: "var(--fg)",
  fgDim: "var(--fg-dim)",
  fgMute: "var(--fg-mute)",
  accent: "var(--accent)",
  accentSoft: "var(--accent-soft)",
  accentDeep: "var(--accent-deep)",
  glassBlur: "var(--glass-blur)",
  glassBg: "var(--glass-bg)",
  glassBorder: "var(--glass-border)",
  glassShadow: "var(--glass-shadow)",
} as const;

/** Map the 0..100 "blur intensity" slider to the actual blur radius (8..58px). */
export function blurPercentToPx(percent: number): number {
  return 8 + (Math.max(0, Math.min(100, percent)) / 100) * 50;
}
