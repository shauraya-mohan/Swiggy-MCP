"use client";

import { useState } from "react";
import clsx from "clsx";
import type { NegotiatorData } from "@/lib/agent/manifest";
import { Icon } from "@/lib/design/icons";

/**
 * Negotiator — horizontal timeline of dineout slots.
 * Slots are clickable; click to refocus rationale + confirm button.
 * Visual shape ported from negotiator.jsx; data shape conforms to NegotiatorData.
 *
 * Initial focused/confirmed state seed from props once. When a new manifest
 * arrives the parent re-mounts us via a `key` derived from the step id so
 * the user's local interactions don't leak across script steps.
 */
export function Negotiator({
  data,
  onConfirmSlot,
}: {
  data: NegotiatorData;
  /**
   * Optional confirm handler. In live mode the parent passes a
   * callback that sends the agent a synthetic "Book the 7:30 PM
   * slot" message (the agent then does the verbal readback +
   * book_table dance). Without this prop, the CONFIRM button is
   * a pure visual ack (demo mode).
   */
  onConfirmSlot?: (slot: { time: string; label: string }) => void;
}) {
  const [focused, setFocused] = useState(data.focusedSlotIndex);
  const [confirmed, setConfirmed] = useState(data.state === "confirmed");

  const availableCount = data.slots.filter((s) => s.available).length;
  const focusedSlot = data.slots[focused];
  const hasFocusedRationale =
    focusedSlot && focusedSlot.available && focusedSlot.rationale;

  return (
    <div className="glass card-enter" style={{ width: 560, padding: 22 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
          position: "relative",
          zIndex: 1,
        }}
      >
        <div
          className="font-mono"
          style={{ fontSize: 10, letterSpacing: "0.14em", color: "var(--fg-mute)" }}
        >
          NEGOTIATING · DINEOUT
        </div>
        <div
          className="font-mono"
          style={{
            fontSize: 10,
            color: "var(--accent-soft)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span className="pulsar" /> {availableCount} ALTERNATES
        </div>
      </div>

      <div
        className="font-display"
        style={{
          fontSize: 22,
          fontWeight: 500,
          lineHeight: 1.25,
          marginBottom: 4,
          position: "relative",
          zIndex: 1,
        }}
      >
        {data.restaurantStrikethrough ? (
          renderHeadlineWithStrikethrough(data.headline, data.restaurantStrikethrough)
        ) : (
          data.headline
        )}
        {data.dateLabel && (
          <span
            className="font-mono"
            style={{
              marginLeft: 10,
              fontSize: 10,
              letterSpacing: "0.14em",
              color: "var(--fg-mute)",
              textTransform: "uppercase",
              verticalAlign: "middle",
            }}
          >
            · {data.dateLabel}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          color: "var(--fg-dim)",
          marginBottom: 22,
          position: "relative",
          zIndex: 1,
        }}
      >
        Tap a slot — here are nearby times and one similar-vibe option.
      </div>

      <div style={{ position: "relative", marginTop: 8, marginBottom: 8, zIndex: 1 }}>
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 32,
            height: 1,
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.12), transparent)",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", position: "relative" }}>
          {data.slots.map((slot, i) => {
            const isFocused = i === focused;
            // Prefer the stable slot id from the data layer. Falls back
            // to a composite that includes the array index so duplicate
            // (time, label) pairs don't collide — see the 12:00 LUNCH ×3
            // bug we fixed where the mapper now dedupes upstream, but
            // we keep this defensive in case a different data source
            // produces ties.
            const key = slot.id ?? `${i}-${slot.time}-${slot.label}`;
            return (
              <div
                key={key}
                onClick={() => slot.available && setFocused(i)}
                className={clsx(
                  "slot",
                  slot.available ? "active" : "unavailable",
                  !isFocused && slot.available && "dimmed"
                )}
                style={{
                  position: "relative",
                  flex: 1,
                  marginRight: i < data.slots.length - 1 ? 6 : 0,
                  padding: "10px 8px 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.08)",
                  textAlign: "center",
                  cursor: slot.available ? "pointer" : "not-allowed",
                }}
              >
                <div
                  className="font-display"
                  style={{
                    fontSize: 18,
                    fontWeight: 600,
                    color: slot.available
                      ? isFocused
                        ? "var(--accent-soft)"
                        : "var(--fg)"
                      : "var(--fg-mute)",
                    textShadow:
                      isFocused && slot.available
                        ? "0 0 18px rgba(252,128,25,0.5)"
                        : "none",
                  }}
                >
                  {slot.time}
                </div>
                <div
                  className="font-mono"
                  style={{
                    fontSize: 9,
                    letterSpacing: "0.1em",
                    marginTop: 4,
                    color: "var(--fg-mute)",
                  }}
                >
                  {slot.label}
                </div>
                <div
                  style={{
                    position: "absolute",
                    top: -5,
                    left: "50%",
                    transform: "translateX(-50%)",
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    background:
                      isFocused && slot.available
                        ? "var(--accent)"
                        : slot.available
                          ? "rgba(255,255,255,0.3)"
                          : "rgba(255,255,255,0.1)",
                    boxShadow:
                      isFocused && slot.available ? "0 0 14px var(--accent)" : "none",
                    transition: "all 0.4s",
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {hasFocusedRationale && focusedSlot?.rationale && (
        <div
          key={focused}
          className="glass-soft fade-in"
          style={{
            padding: "12px 14px",
            marginTop: 18,
            position: "relative",
            zIndex: 1,
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <div
              style={{
                marginTop: 2,
                color: "var(--accent-soft)",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Icon.Spark size={14} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: "var(--fg)", marginBottom: 3 }}>
                {focusedSlot.rationale.headline}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-mute)", lineHeight: 1.5 }}>
                {focusedSlot.rationale.note}
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: 8,
          marginTop: 16,
          justifyContent: "flex-end",
          position: "relative",
          zIndex: 1,
        }}
      >
        <button className="btn-ghost" onClick={() => setConfirmed(false)}>
          DECLINE
        </button>
        <button
          className="btn-ghost active"
          onClick={() => {
            setConfirmed(true);
            // Hand off to the agent. The booking still goes through the
            // verbal-confirm contract, so this tap is the user "saying"
            // "book this one" — agent will read back and ask for a
            // final yes before firing dineout__book_table.
            if (focusedSlot && focusedSlot.available) {
              onConfirmSlot?.({ time: focusedSlot.time, label: focusedSlot.label });
            }
          }}
          style={
            confirmed
              ? { color: "var(--accent-soft)", display: "flex", alignItems: "center", gap: 4 }
              : { display: "flex", alignItems: "center", gap: 4 }
          }
        >
          {confirmed ? (
            <>
              <Icon.Check size={10} /> CONFIRMED {focusedSlot?.time}
            </>
          ) : (
            <>CONFIRM {focusedSlot?.time}</>
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * The headline reads "8:00 at Olive Bistro is full." — we want the restaurant
 * name struck through (matches the design's red strikethrough). If the
 * restaurant string isn't in the headline, fall back to plain text.
 */
function renderHeadlineWithStrikethrough(headline: string, restaurant: string) {
  const idx = headline.indexOf(restaurant);
  if (idx === -1) return headline;
  const before = headline.slice(0, idx);
  const after = headline.slice(idx + restaurant.length);
  return (
    <>
      {before}
      <span
        style={{
          color: "var(--fg-mute)",
          textDecoration: "line-through",
          textDecorationColor: "rgba(255,100,80,0.6)",
        }}
      >
        {restaurant}
      </span>
      {after}
    </>
  );
}
