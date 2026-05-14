import type { CSSProperties } from "react";
import type { IntentMode } from "@/lib/agent/manifest";

/** Intent glyphs sit beside the Aura. Inline SVG so they inherit color. */
export function IntentGlyph({
  intent,
  size = 18,
}: {
  intent: IntentMode;
  size?: number;
}) {
  const stroke = "currentColor";
  const sw = 1.4;

  if (intent === "cook") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M5 10h14v6a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-6Z" stroke={stroke} strokeWidth={sw} />
        <path d="M3 10h18" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        <path
          d="M10 6c0-1.5 1-2 1-3M14 6c0-1.5 1-2 1-3M12 7c0-1 .8-1.5.8-2.5"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (intent === "order") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path
          d="M6 8h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 8Z"
          stroke={stroke}
          strokeWidth={sw}
        />
        <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      </svg>
    );
  }
  if (intent === "dine") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <path d="M4 11h16" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
        <path
          d="M6 11v3M18 11v3M6 17v3M18 17v3"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
        />
        <path d="M3 14h18" stroke={stroke} strokeWidth={sw} strokeLinecap="round" />
      </svg>
    );
  }

  // idle — quiet wave, signals readiness without the meal-specific glyphs
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M3 12c2 0 2-3 4-3s2 6 4 6 2-3 4-3 2 3 4 3 2 -3 4 -3"
        stroke={stroke}
        strokeWidth={sw}
        strokeLinecap="round"
      />
    </svg>
  );
}

type IconProps = { size?: number; style?: CSSProperties };

/** Generic small icons used inside cards / chrome. */
export const Icon = {
  Mic: ({ size = 16, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  ),
  Clock: ({ size = 14, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Star: ({ size = 12, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style}>
      <path d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9L12 3Z" />
    </svg>
  ),
  Spark: ({ size = 14, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  ),
  Arrow: ({
    size = 14,
    dir = "right",
    style,
  }: IconProps & { dir?: "left" | "right" }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ transform: dir === "left" ? "rotate(180deg)" : "none", ...style }}
    >
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Close: ({ size = 14, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  Check: ({ size = 14, style }: IconProps) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={style}>
      <path
        d="M5 12l5 5L20 7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
};
