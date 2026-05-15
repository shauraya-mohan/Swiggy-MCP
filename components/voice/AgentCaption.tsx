"use client";

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
 */
export function AgentCaption({
  text,
  active,
  streaming = false,
}: {
  text?: string;
  active: boolean;
  streaming?: boolean;
}) {
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
        className={streaming ? undefined : "fade-in"}
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--fg-dim)",
        }}
      >
        {text}
      </div>
    </div>
  );
}
