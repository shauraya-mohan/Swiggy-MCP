import { useId } from "react";

/**
 * Abstract food placeholder vectors — glassy gradient orbs/shapes suggestive
 * of food without being literal. Ported from icons.jsx in the design bundle.
 *
 * Used as the imagery slot on cards until real images land.
 */
export type GlyphKind = "bowl" | "leaf" | "wrap" | "drink" | "plate" | "spice";

export function FoodGlyph({
  kind = "bowl",
  size = 88,
  hue = 22,
}: {
  kind?: GlyphKind;
  size?: number;
  hue?: number;
}) {
  // useId() gives a stable id across SSR + client. Random() would mismatch.
  const reactId = useId().replace(/[^a-zA-Z0-9_-]/g, "_");
  const id = `g-${kind}-${reactId}`;
  const hid = `${id}-h`;

  const c1 = `hsl(${hue}, 90%, 65%)`;
  const c2 = `hsl(${hue + 15}, 80%, 45%)`;
  const c3 = `hsl(${hue - 5}, 70%, 30%)`;

  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <defs>
        <radialGradient id={id} cx="35%" cy="30%" r="80%">
          <stop offset="0%" stopColor={c1} stopOpacity="0.95" />
          <stop offset="60%" stopColor={c2} stopOpacity="0.6" />
          <stop offset="100%" stopColor={c3} stopOpacity="0.3" />
        </radialGradient>
        <radialGradient id={hid} cx="30%" cy="20%" r="40%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.7)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>

      {kind === "bowl" && (
        <>
          <ellipse cx="50" cy="62" rx="38" ry="22" fill={`url(#${id})`} />
          <ellipse cx="50" cy="58" rx="34" ry="6" fill="rgba(255,255,255,0.12)" />
          <circle cx="42" cy="52" r="14" fill={`url(#${hid})`} />
        </>
      )}
      {kind === "leaf" && (
        <>
          <path d="M20 70 Q30 25 75 22 Q72 65 25 78 Z" fill={`url(#${id})`} />
          <path
            d="M22 73 Q45 50 72 25"
            stroke="rgba(255,255,255,0.3)"
            strokeWidth="1.2"
            fill="none"
          />
          <circle cx="38" cy="42" r="10" fill={`url(#${hid})`} />
        </>
      )}
      {kind === "wrap" && (
        <>
          <path
            d="M18 50 Q22 22 50 22 Q78 22 82 50 Q78 78 50 78 Q22 78 18 50 Z"
            fill={`url(#${id})`}
          />
          <path
            d="M30 30 Q50 38 70 30 M30 50 Q50 58 70 50 M30 70 Q50 78 70 70"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1.2"
            fill="none"
          />
          <circle cx="42" cy="40" r="13" fill={`url(#${hid})`} />
        </>
      )}
      {kind === "drink" && (
        <>
          <path d="M28 18 L72 18 L66 82 Q50 88 34 82 Z" fill={`url(#${id})`} />
          <ellipse cx="50" cy="22" rx="22" ry="3" fill="rgba(255,255,255,0.25)" />
          <ellipse cx="42" cy="38" rx="6" ry="14" fill={`url(#${hid})`} />
        </>
      )}
      {kind === "plate" && (
        <>
          <circle cx="50" cy="50" r="36" fill={`url(#${id})`} />
          <circle
            cx="50"
            cy="50"
            r="36"
            fill="none"
            stroke="rgba(255,255,255,0.18)"
            strokeWidth="1"
          />
          <circle cx="50" cy="50" r="22" fill="rgba(0,0,0,0.12)" />
          <circle cx="42" cy="42" r="14" fill={`url(#${hid})`} />
        </>
      )}
      {kind === "spice" && (
        <>
          <rect x="32" y="20" width="36" height="60" rx="6" fill={`url(#${id})`} />
          <rect x="36" y="14" width="28" height="8" rx="2" fill={c3} opacity="0.6" />
          <circle cx="50" cy="40" r="2" fill="rgba(255,255,255,0.4)" />
          <circle cx="44" cy="50" r="1.5" fill="rgba(255,255,255,0.4)" />
          <circle cx="56" cy="55" r="1.5" fill="rgba(255,255,255,0.4)" />
          <circle cx="48" cy="62" r="2" fill="rgba(255,255,255,0.4)" />
          <circle cx="42" cy="38" r="10" fill={`url(#${hid})`} />
        </>
      )}
    </svg>
  );
}

/**
 * Deterministic glyph picker for Instamart cards — keys off `imageHue` so the
 * three prototype ingredients (pancetta hue 12 → wrap, peppercorn hue 28 →
 * spice, pecorino hue 50 → plate) render identically to the design without
 * adding a `glyphKind` field to the manifest contract.
 */
export function pickInstamartGlyph(hue: number): GlyphKind {
  if (hue < 20) return "wrap";
  if (hue < 45) return "spice";
  return "plate";
}
