/**
 * BrandHeader — top-left mark.
 * Two-line stack: "Kitchen Copilot" + a small mono version line.
 */
export function BrandHeader({ version = "v0.1" }: { version?: string }) {
  return (
    <div
      className="no-select"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        className="font-display"
        style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em" }}
      >
        Kitchen Copilot
      </div>
      <div
        className="font-mono"
        style={{ fontSize: 9, letterSpacing: "0.18em", color: "var(--fg-mute)" }}
      >
        MCP · 35 TOOLS · {version.toUpperCase()}
      </div>
    </div>
  );
}
