"use client";

import { useEffect, useState } from "react";

/**
 * TranscriptStream — user transcript bubble rising from the Aura.
 *
 * Two render modes:
 *   - Demo (default, `streaming={false}`): the parent gives a full sentence
 *     up-front; we tokenize and animate each word in over 110ms — preserves
 *     the prototype's word-by-word "rise + blur-up" choreography.
 *   - Live (`streaming={true}`): the parent re-feeds an ever-growing string
 *     as deltas arrive from OpenAI Realtime. We render text directly so the
 *     bubble grows naturally as words land, with no setInterval-driven
 *     animation restart on every keystroke. (Without this, every delta
 *     resets the word-by-word interval and the user sees the whole final
 *     transcript snap in at once.)
 *
 * Renders above the Aura; the parent positions it via absolute layout.
 */
export function TranscriptStream({
  text,
  active,
  streaming = false,
}: {
  text?: string;
  active: boolean;
  streaming?: boolean;
}) {
  const [shown, setShown] = useState<string[]>([]);

  // Demo mode: tokenize and animate. Live mode skips this entirely — we
  // render `text` directly because OpenAI's streaming IS the animation.
  useEffect(() => {
    if (streaming) {
      setShown([]);
      return;
    }
    if (!active || !text) {
      setShown([]);
      return;
    }
    const words = text.split(" ");
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setShown(words.slice(0, i));
      if (i >= words.length) clearInterval(interval);
    }, 110);
    return () => clearInterval(interval);
  }, [text, active, streaming]);

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
        {streaming ? (
          // Live streaming: render text as one block. No per-word animation,
          // no remount — the bubble grows in place as deltas arrive.
          <span>{text}</span>
        ) : (
          shown.map((w, i) => (
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
          ))
        )}
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
