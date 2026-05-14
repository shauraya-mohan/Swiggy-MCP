"use client";

/**
 * AgentCaption — short copilot reply beneath the Aura. Fades in on demand.
 */
export function AgentCaption({ text, active }: { text?: string; active: boolean }) {
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
        className="fade-in"
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "var(--fg-dim)",
        }}
        // Each new text gets a fresh fade-in by remounting via key from the parent.
      >
        {text}
      </div>
    </div>
  );
}
