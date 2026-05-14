"use client";

import type { ConfirmData } from "@/lib/agent/manifest";
import { Icon } from "@/lib/design/icons";
import { Card } from "./Card";

export function ConfirmCard({ data }: { data: ConfirmData }) {
  return (
    <Card width={280} className="fade-in">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 999,
            background: "rgba(252,128,25,0.18)",
            border: "1px solid rgba(252,128,25,0.4)",
            display: "grid",
            placeItems: "center",
            color: "var(--accent-soft)",
            flexShrink: 0,
          }}
        >
          <Icon.Check size={16} />
        </div>
        <div>
          <div className="font-display" style={{ fontSize: 16, fontWeight: 600 }}>
            {data.title}
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-mute)" }}>{data.subtitle}</div>
        </div>
      </div>
    </Card>
  );
}
