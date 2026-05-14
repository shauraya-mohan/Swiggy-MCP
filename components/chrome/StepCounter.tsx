"use client";

import clsx from "clsx";

/**
 * StepCounter — top-right step indicator + play/pause control.
 * `step` is 0-indexed; display is 1-indexed and zero-padded.
 */
export function StepCounter({
  step,
  total,
  isPlaying,
  onToggle,
}: {
  step: number;
  total: number;
  isPlaying: boolean;
  onToggle: () => void;
}) {
  const showCounter = total > 0;
  return (
    <div
      className="no-select"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      {showCounter && (
        <div
          className="font-mono"
          style={{ fontSize: 10, letterSpacing: "0.16em", color: "var(--fg-mute)" }}
        >
          {String(step + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
        </div>
      )}
      <button
        type="button"
        onClick={onToggle}
        className={clsx("btn-ghost", !isPlaying && "active")}
        style={{ padding: "6px 10px", fontSize: 10 }}
      >
        {isPlaying ? "PAUSE" : "PLAY"}
      </button>
    </div>
  );
}
