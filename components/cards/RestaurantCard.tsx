"use client";

import { useState } from "react";
import type { RestaurantCardData } from "@/lib/agent/manifest";
import { Icon } from "@/lib/design/icons";
import { Card } from "./Card";
import { FoodGlyph } from "./FoodGlyph";

export function RestaurantCard({
  data,
  index = 0,
  total = 1,
}: {
  data: RestaurantCardData;
  index?: number;
  total?: number;
}) {
  // Driven by manifest `state` if provided, otherwise local "tap to toggle".
  const [localOrdered, setLocalOrdered] = useState(data.state === "ordered");
  const ordered = data.state ? data.state === "ordered" : localOrdered;

  return (
    <Card
      width={300}
      label={`RESTAURANT · MATCH ${String(index + 1).padStart(2, "0")}/${String(total).padStart(
        2,
        "0"
      )}`}
      selected={ordered}
      onClick={() => setLocalOrdered((o) => !o)}
      trailing={
        <div
          className="font-mono"
          style={{
            fontSize: 9,
            letterSpacing: "0.12em",
            color: ordered ? "var(--accent-soft)" : "var(--fg-mute)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {ordered ? (
            <>
              <Icon.Check size={10} /> ORDERED
            </>
          ) : (
            "TAP TO ORDER"
          )}
        </div>
      }
    >
      <div style={{ position: "relative", marginBottom: 14 }}>
        <div
          className="placeholder-shimmer"
          style={{
            height: 130,
            borderRadius: 14,
            display: "grid",
            placeItems: "center",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <FoodGlyph kind="plate" size={88} hue={data.imageHue ?? 35} />
        </div>
        <div
          style={{
            position: "absolute",
            top: 10,
            right: 10,
            background: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            borderRadius: 999,
            padding: "4px 8px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          <Icon.Star size={10} />
          <span>{data.rating.toFixed(1)}</span>
        </div>
      </div>

      <div
        className="font-display"
        style={{
          fontSize: 20,
          fontWeight: 600,
          lineHeight: 1.15,
          marginBottom: 4,
        }}
      >
        {data.name}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-mute)", marginBottom: 14 }}>
        {data.cuisine}
      </div>

      {data.agentPick && (
        <div className="glass-soft" style={{ padding: "10px 12px", marginBottom: 12 }}>
          <div
            className="font-mono"
            style={{
              fontSize: 9,
              letterSpacing: "0.12em",
              color: "var(--fg-mute)",
              marginBottom: 3,
            }}
          >
            AGENT PICK
          </div>
          <div style={{ fontSize: 13, color: "var(--fg)" }}>{data.agentPick.item}</div>
        </div>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 12,
          color: "var(--fg-dim)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Icon.Clock size={12} />
          <span>{data.etaMinutes} min</span>
        </div>
        <div style={{ fontWeight: 600, color: "var(--fg)" }}>₹{data.price}</div>
      </div>
    </Card>
  );
}
