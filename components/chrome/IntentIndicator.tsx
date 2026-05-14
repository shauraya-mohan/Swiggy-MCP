"use client";

import type { IntentMode } from "@/lib/agent/manifest";
import { IntentGlyph } from "@/lib/design/icons";
import { INTENT_LABEL, INTENT_PALETTE } from "@/lib/design/intent-palette";

/**
 * IntentIndicator — top-centre glyph + uppercase label.
 * The glyph picks up the active intent's accent colour.
 */
export function IntentIndicator({ intent }: { intent: IntentMode }) {
  const accent = INTENT_PALETTE[intent]?.accent ?? "var(--fg)";
  return (
    <div
      className="no-select"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        color: "var(--fg-dim)",
      }}
    >
      <div
        className="intent-glyph"
        style={{
          width: 28,
          height: 28,
          display: "grid",
          placeItems: "center",
          color: accent,
          opacity: 0.85,
        }}
      >
        <IntentGlyph intent={intent} size={20} />
      </div>
      <div
        className="font-mono"
        style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--fg-dim)" }}
      >
        {INTENT_LABEL[intent]}
      </div>
    </div>
  );
}
