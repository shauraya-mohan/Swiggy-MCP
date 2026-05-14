"use client";

import { useEffect, useState } from "react";

/**
 * TranscriptStream — user transcript bubble rising from the Aura.
 * Tokenises the line and animates each word in sequence (110ms cadence).
 *
 * Renders above the Aura; the parent positions it via absolute layout.
 */
export function TranscriptStream({
  text,
  active,
}: {
  text?: string;
  active: boolean;
}) {
  const [shown, setShown] = useState<string[]>([]);

  // The parent gives this component a key derived from `text`, so we mount
  // fresh on each new utterance — no reset of `shown` is needed in the effect.
  useEffect(() => {
    if (!active || !text) return;
    const words = text.split(" ");
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setShown(words.slice(0, i));
      if (i >= words.length) clearInterval(interval);
    }, 110);
    return () => clearInterval(interval);
  }, [text, active]);

  if (!active || !text) return null;

  return (
    <div
      style={{
        position: "absolute",
        bottom: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        paddingBottom: 28,
        width: "max-content",
        maxWidth: 520,
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <div
        className="font-mono no-select"
        style={{
          fontSize: 10,
          letterSpacing: "0.18em",
          color: "var(--fg-mute)",
          marginBottom: 10,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <span className="pulsar" />
        LISTENING
      </div>
      <div
        className="font-display"
        style={{
          fontSize: 22,
          fontWeight: 400,
          lineHeight: 1.35,
          color: "var(--fg)",
          textShadow: "0 0 24px rgba(252,128,25,0.25)",
        }}
      >
        {shown.map((w, i) => (
          <span
            key={`${w}-${i}`}
            className="transcript-line"
            style={{
              display: "inline-block",
              marginRight: "0.32em",
              animationDelay: `${i * 0.04}s`,
            }}
          >
            {w}
          </span>
        ))}
        <span
          style={{
            display: "inline-block",
            width: 2,
            height: "1em",
            background: "var(--accent)",
            verticalAlign: "middle",
            marginLeft: 2,
            opacity: 0.7,
            animation: "pulsar 1s ease-in-out infinite",
          }}
        />
      </div>
    </div>
  );
}
