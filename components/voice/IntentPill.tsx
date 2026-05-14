"use client";

import clsx from "clsx";
import type { IntentMode } from "@/lib/agent/manifest";
import { IntentGlyph } from "@/lib/design/icons";

/**
 * IntentPill — bottom-centre strip of three quick-jump pills (Cooking,
 * Ordering, Dining). Clicking jumps the demo script to that intent's first
 * step. The pill matching the current intent is highlighted with the accent.
 */
const PILLS: { key: IntentMode; label: string }[] = [
  { key: "cook", label: "Cooking" },
  { key: "order", label: "Ordering" },
  { key: "dine", label: "Dining" },
];

export function IntentPillStrip({
  active,
  onJump,
}: {
  active: IntentMode;
  onJump: (intent: IntentMode) => void;
}) {
  return (
    <div
      className="glass no-select"
      style={{
        display: "flex",
        gap: 6,
        padding: 5,
      }}
    >
      {PILLS.map(({ key, label }) => {
        const isActive = active === key;
        return (
          <button
            key={key}
            type="button"
            className={clsx("btn-ghost", isActive && "active")}
            onClick={() => onJump(key)}
            style={{
              padding: "8px 16px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              border: "none",
              background: isActive ? "rgba(252,128,25,0.12)" : "transparent",
              position: "relative",
              zIndex: 1,
            }}
          >
            <IntentGlyph intent={key} size={14} />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
