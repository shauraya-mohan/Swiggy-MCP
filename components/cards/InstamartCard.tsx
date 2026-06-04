"use client";

import { useState } from "react";
import type { InstamartCardData } from "@/lib/agent/manifest";
import { Icon } from "@/lib/design/icons";
import { Card } from "./Card";
import { FoodGlyph, pickInstamartGlyph } from "./FoodGlyph";

export function InstamartCard({
  data,
  onTap,
}: {
  data: InstamartCardData;
  /**
   * Optional tap handler. In live mode the parent wires this to
   * `sendUserText("Add <product> to my cart")` or "Remove it" if the
   * card is already in the "added" state. In demo mode tap falls
   * back to the visual local toggle.
   */
  onTap?: () => void;
}) {
  const [localAdded, setLocalAdded] = useState(data.state === "added");
  const added = data.state ? data.state === "added" : localAdded;
  const hue = data.imageHue ?? 22;

  const handleClick = onTap ?? (() => setLocalAdded((a) => !a));

  return (
    <Card
      width={250}
      label="INSTAMART · INGREDIENT"
      selected={added}
      onClick={handleClick}
    >
      <div style={{ position: "relative", marginBottom: 12 }}>
        <div
          className="placeholder-shimmer"
          style={{
            height: 110,
            borderRadius: 12,
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <FoodGlyph kind={pickInstamartGlyph(hue)} size={70} hue={hue} />
        </div>
        <div
          className="mvq-badge font-mono"
          style={{
            position: "absolute",
            top: 10,
            left: 10,
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: "0.1em",
            padding: "4px 8px",
            borderRadius: 6,
          }}
        >
          MVQ · {data.pack}
        </div>
      </div>

      <div
        className="font-display"
        style={{ fontSize: 17, fontWeight: 600, marginBottom: 6 }}
      >
        {data.name}
      </div>
      <div
        style={{
          fontSize: 11,
          color: "var(--fg-mute)",
          marginBottom: 12,
          lineHeight: 1.4,
        }}
      >
        {data.reason}
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div className="font-display" style={{ fontSize: 18, fontWeight: 600 }}>
          ₹{data.price}
        </div>
        <div
          className="font-mono"
          style={{
            fontSize: 10,
            color: added ? "var(--accent-soft)" : "var(--fg-dim)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "4px 8px",
            borderRadius: 6,
            background: added ? "rgba(252,128,25,0.14)" : "rgba(255,255,255,0.04)",
            border: `1px solid ${
              added ? "rgba(252,128,25,0.4)" : "rgba(255,255,255,0.08)"
            }`,
            transition: "all 0.25s",
          }}
        >
          {added ? (
            <>
              <Icon.Check size={10} /> ADDED
            </>
          ) : (
            "+ ADD"
          )}
        </div>
      </div>
    </Card>
  );
}
