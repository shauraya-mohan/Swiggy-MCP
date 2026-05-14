"use client";

import type { DeliveryCardData } from "@/lib/agent/manifest";
import { Card } from "./Card";

export function DeliveryCard({ data }: { data: DeliveryCardData }) {
  const progressPct = Math.max(0, Math.min(100, data.progress * 100));
  return (
    <Card width={300} label="DELIVERY · LIVE">
      <div
        className="font-display"
        style={{ fontSize: 28, fontWeight: 600, marginBottom: 4 }}
      >
        {data.etaMinutes}
        <span
          style={{
            fontSize: 14,
            color: "var(--fg-mute)",
            fontWeight: 400,
            marginLeft: 4,
          }}
        >
          min
        </span>
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-dim)", marginBottom: 18 }}>
        {data.status}
      </div>

      <div className="progress-track">
        <div
          className="progress-fill"
          style={{
            width: `${progressPct}%`,
            transition: "width 1.4s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 10,
          fontSize: 10,
          color: "var(--fg-mute)",
        }}
        className="font-mono"
      >
        <span style={{ color: data.stage === "prep" ? "var(--accent-soft)" : undefined }}>
          PREP
        </span>
        <span style={{ color: data.stage === "route" ? "var(--accent-soft)" : undefined }}>
          ROUTE
        </span>
        <span
          style={{
            color:
              data.stage === "arriving" || progressPct > 75
                ? "var(--accent-soft)"
                : undefined,
          }}
        >
          YOU
        </span>
      </div>
    </Card>
  );
}
