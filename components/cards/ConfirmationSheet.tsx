"use client";

import { useEffect, useRef, useState } from "react";
import type { PendingMutation } from "@/lib/agent/manifest";
import { Icon } from "@/lib/design/icons";

/**
 * ConfirmationSheet — the hard safety gate that intercepts every
 * mutating tool call (book_table, update_cart, checkout,
 * place_food_order). The model is paused waiting on the tool result
 * the whole time this sheet is up; tapping Confirm releases the gate
 * and the tool fires, tapping Cancel returns USER_DECLINED to the
 * model so it acknowledges verbally.
 *
 * Visual language: larger than ConfirmCard (after-the-fact receipt),
 * accent-bordered, monospace data rows, two-button footer split
 * Cancel | Confirm. Cautionary copy (for high-stakes ops like
 * checkout) sits above the buttons in caution colour.
 *
 * Keyboard: Esc → Cancel, Enter → Confirm. Mirrors the convention
 * users expect from native confirm dialogs and means the sheet is
 * usable from a keyboard-only setting (demo screen-share, etc.).
 */
export function ConfirmationSheet({
  data,
  onConfirm,
  onCancel,
}: {
  data: PendingMutation;
  /** Release the gate — tool will fire next. */
  onConfirm: () => void;
  /** Decline the gate — model gets USER_DECLINED back. */
  onCancel: () => void;
}) {
  // Guard against double-tap. Once the user resolves the gate we
  // disable both buttons until the parent unmounts us (which happens
  // ~immediately when the manifest's pendingMutation clears).
  const [resolved, setResolved] = useState(false);
  const resolvedRef = useRef(false);

  const handleConfirm = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setResolved(true);
    onConfirm();
  };

  const handleCancel = () => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    setResolved(true);
    onCancel();
  };

  // Keyboard shortcuts. The sheet doesn't own focus (it's a passive
  // overlay alongside the voice loop), so we listen on window and
  // bail early if any text input has focus — though there isn't one
  // in the voice page today, this keeps the hook safe to copy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (resolvedRef.current) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // We deliberately don't depend on handleConfirm/handleCancel:
    // they're stable closures within this render and we want a single
    // listener for the sheet's whole lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isDestructive = !!data.cautionary;

  return (
    <div
      className="glass card-enter"
      style={{
        width: 420,
        padding: 22,
        borderRadius: 18,
        // Brighter accent border than a regular card — this is the
        // "you need to make a choice" affordance. Slightly thicker.
        border: `1.5px solid ${
          isDestructive ? "rgba(252,128,25,0.55)" : "rgba(252,128,25,0.45)"
        }`,
        boxShadow: isDestructive
          ? "0 18px 60px rgba(252,128,25,0.18), 0 4px 18px rgba(0,0,0,0.35)"
          : "0 12px 40px rgba(0,0,0,0.4)",
      }}
    >
      {/* ---- Header ---- */}
      <div
        className="font-mono no-select"
        style={{
          fontSize: 10,
          letterSpacing: "0.18em",
          color: "var(--accent-soft)",
          marginBottom: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <Icon.Check size={10} />
        <span>CONFIRM TO PROCEED</span>
      </div>

      <div
        className="font-display"
        style={{ fontSize: 22, fontWeight: 600, lineHeight: 1.15, marginBottom: 4 }}
      >
        {data.title}
      </div>

      {data.subtitle && (
        <div style={{ fontSize: 13, color: "var(--fg-mute)", marginBottom: 14 }}>
          {data.subtitle}
        </div>
      )}

      {/* ---- Rows (monospace data) ---- */}
      {data.rows.length > 0 && (
        <div
          className="glass-soft"
          style={{
            padding: "12px 14px",
            marginTop: data.subtitle ? 4 : 14,
            marginBottom: 16,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {data.rows.map((row, i) => (
            <div
              key={i}
              className="font-mono"
              style={{
                fontSize: 12,
                color: "var(--fg)",
                letterSpacing: "0.02em",
              }}
            >
              {row}
            </div>
          ))}
        </div>
      )}

      {/* ---- Cautionary copy (destructive ops only) ---- */}
      {data.cautionary && (
        <div
          style={{
            fontSize: 11,
            color: "var(--accent-soft)",
            marginBottom: 14,
            lineHeight: 1.5,
            opacity: 0.9,
          }}
        >
          {data.cautionary}
        </div>
      )}

      {/* ---- Footer buttons (split Cancel | Confirm) ---- */}
      <div style={{ display: "flex", gap: 10 }}>
        <button
          className="btn-ghost"
          onClick={handleCancel}
          disabled={resolved}
          style={{
            flex: 1,
            padding: "12px 16px",
            opacity: resolved ? 0.5 : 1,
            cursor: resolved ? "default" : "pointer",
          }}
        >
          Cancel
        </button>
        <button
          className="btn-ghost active"
          onClick={handleConfirm}
          disabled={resolved}
          style={{
            flex: 1.4,
            padding: "12px 16px",
            fontWeight: 600,
            opacity: resolved ? 0.5 : 1,
            cursor: resolved ? "default" : "pointer",
          }}
        >
          {data.primaryLabel}
        </button>
      </div>
    </div>
  );
}
