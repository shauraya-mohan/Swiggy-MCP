"use client";

import { useEffect, useRef } from "react";

/**
 * AgentCaption — short copilot reply beneath the Aura.
 *
 * Render modes:
 *   - Demo (default): each new sentence triggers a fresh fade-in via a parent
 *     `key` change.
 *   - Live (`streaming={true}`): no fade animation on every delta — the
 *     caption grows in place as transcript deltas arrive from OpenAI
 *     Realtime. Without this, every delta restarts the fade-in animation and
 *     the caption appears to flicker.
 *
 * Rolling window: long responses are clipped to the last ~4 lines and
 * auto-scroll-to-bottom on every delta, so the latest content is always
 * visible. A linear-gradient mask softens the top edge so the older text
 * fades out rather than getting hard-clipped.
 */

const MAX_LINE_HEIGHT_PX = 21; // 14px * 1.5 line-height
const VISIBLE_LINES = 4;
const MAX_CAPTION_HEIGHT = MAX_LINE_HEIGHT_PX * VISIBLE_LINES; // ≈ 84px

export function AgentCaption({
  text,
  active,
  streaming = false,
}: {
  text?: string;
  active: boolean;
  streaming?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-pin to the bottom of the scroll container whenever the text
  // changes. useEffect (not useLayoutEffect) is fine — by the time it
  // runs the new content is rendered and scrollHeight reflects it.
  useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [text, streaming]);

  if (!active || !text) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        paddingTop: 24,
        width: "max-content",
        maxWidth: 480,
        textAlign: "center",
        pointerEvents: "none",
      }}
    >
      <div
        className="font-mono no-select"
        style={{
          fontSize: 9,
          letterSpacing: "0.18em",
          color: "var(--fg-mute)",
          marginBottom: 8,
        }}
      >
        COPILOT
      </div>
      <div
        ref={scrollRef}
        className={streaming ? undefined : "fade-in"}
        style={{
          fontSize: 14,
          lineHeight: `${MAX_LINE_HEIGHT_PX}px`,
          color: "var(--fg-dim)",
          maxHeight: MAX_CAPTION_HEIGHT,
          overflow: "hidden",
          // Fade the top edge so older text dissolves out of view instead of
          // being hard-clipped by the container. Bottom stays fully opaque
          // so the freshest line lands cleanly.
          WebkitMaskImage:
            "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.6) 15%, black 40%, black 100%)",
          maskImage:
            "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.6) 15%, black 40%, black 100%)",
        }}
      >
        {text}
      </div>
    </div>
  );
}
