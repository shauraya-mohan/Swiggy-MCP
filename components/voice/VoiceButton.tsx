"use client";

import { Icon } from "@/lib/design/icons";
import type { AuraState } from "@/lib/agent/manifest";

/**
 * VoiceButton — the single tap target that drives the entire conversation.
 *
 * State machine:
 *   demo + idle/success     → "Tap to talk"   inert (mirrors live's resting label)
 *   demo + listening        → "Tap to send"   inert
 *   demo + thinking         → "Thinking…"     inert, busy
 *   demo + speaking         → "Interrupt"     inert
 *   live + connecting       → "Connecting…"   busy, no-op
 *   live + errored          → "Retry"         tap → re-opens session
 *   live + idle             → "Tap to talk"   tap → enables mic, clears buffer
 *   live + listening        → "Tap to send"   tap → commits buffer + asks for response
 *   live + thinking         → "Thinking…"     busy, no-op while the model composes
 *   live + speaking         → "Interrupt"     tap → cancels the in-progress response
 *
 * Demo mode deliberately mirrors live's labels off the same `auraState`
 * instead of showing a distinct "Start voice" CTA — a button that visibly
 * invites "click to go live" is both a giveaway that the run is scripted
 * and a live footgun (an accidental tap mid-recording would open a real,
 * billed Realtime session and prompt for mic access). Switching into live
 * mode is still available from the Tweaks panel.
 *
 * This is a debug/dev affordance per the build plan. Once the prompt + agent
 * modules are stable we plan to drop the button and let server VAD drive
 * turn-taking again. The button is the v0.1 demo-safe path.
 */
export type VoiceButtonAction =
  | "openSession"
  | "startListening"
  | "stopListening"
  | "interrupt"
  | "noop";

interface VoiceButtonProps {
  mode: "demo" | "live";
  connected: boolean;
  isListening: boolean;
  auraState: AuraState;
  error: string | null;
  onAction: (action: VoiceButtonAction) => void;
}

interface ButtonView {
  label: string;
  action: VoiceButtonAction;
  busy: boolean;
  tone: "neutral" | "primary" | "live" | "danger" | "muted";
}

function resolve({
  mode,
  connected,
  isListening,
  auraState,
  error,
}: Omit<VoiceButtonProps, "onAction">): ButtonView {
  if (mode === "demo") {
    // Same labels a live session would show for this aura state, but
    // every action is "noop" — there's no real session underneath.
    switch (auraState) {
      case "listening":
        return { label: "Tap to send", action: "noop", busy: false, tone: "live" };
      case "thinking":
        return { label: "Thinking…", action: "noop", busy: true, tone: "muted" };
      case "speaking":
        return { label: "Interrupt", action: "noop", busy: false, tone: "muted" };
      default:
        return { label: "Tap to talk", action: "noop", busy: false, tone: "primary" };
    }
  }
  if (error) {
    return { label: "Retry voice", action: "openSession", busy: false, tone: "danger" };
  }
  if (!connected) {
    return { label: "Connecting…", action: "noop", busy: true, tone: "primary" };
  }
  if (isListening) {
    return { label: "Tap to send", action: "stopListening", busy: false, tone: "live" };
  }
  if (auraState === "thinking") {
    return { label: "Thinking…", action: "noop", busy: true, tone: "muted" };
  }
  if (auraState === "speaking") {
    return { label: "Interrupt", action: "interrupt", busy: false, tone: "muted" };
  }
  return { label: "Tap to talk", action: "startListening", busy: false, tone: "primary" };
}

const TONE_STYLES: Record<
  ButtonView["tone"],
  { fg: string; bg: string; ring: string; glow: string }
> = {
  neutral: {
    fg: "var(--fg-dim)",
    bg: "rgba(255, 245, 230, 0.05)",
    ring: "rgba(255, 230, 200, 0.18)",
    glow: "0 4px 18px rgba(0,0,0,0.4)",
  },
  primary: {
    fg: "var(--accent-soft)",
    bg: "rgba(252, 128, 25, 0.12)",
    ring: "rgba(252, 128, 25, 0.4)",
    glow: "0 0 18px rgba(252, 128, 25, 0.18), 0 4px 18px rgba(0,0,0,0.45)",
  },
  live: {
    fg: "var(--accent)",
    bg: "rgba(252, 128, 25, 0.22)",
    ring: "rgba(252, 128, 25, 0.65)",
    glow: "0 0 28px rgba(252, 128, 25, 0.4), 0 4px 24px rgba(0,0,0,0.5)",
  },
  danger: {
    fg: "rgba(255, 180, 180, 0.95)",
    bg: "rgba(220, 60, 60, 0.18)",
    ring: "rgba(220, 80, 80, 0.45)",
    glow: "0 4px 18px rgba(0,0,0,0.4)",
  },
  muted: {
    fg: "var(--fg-mute)",
    bg: "rgba(255, 245, 230, 0.04)",
    ring: "rgba(255, 230, 200, 0.12)",
    glow: "0 4px 18px rgba(0,0,0,0.4)",
  },
};

export function VoiceButton(props: VoiceButtonProps) {
  const view = resolve(props);
  const palette = TONE_STYLES[view.tone];

  const handleClick = () => {
    if (view.busy) return;
    props.onAction(view.action);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="font-mono no-select"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 18px",
        borderRadius: 999,
        border: `1px solid ${palette.ring}`,
        background: palette.bg,
        backdropFilter: "blur(var(--glass-blur)) saturate(140%)",
        WebkitBackdropFilter: "blur(var(--glass-blur)) saturate(140%)",
        color: palette.fg,
        fontSize: 11,
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        // `cursor: progress` triggers the macOS rainbow spinner on hover —
        // visually noisy and conflates "agent is thinking" with "your OS is
        // hung". `default` is the polite "non-clickable" cursor.
        cursor: view.busy ? "default" : "pointer",
        transition:
          "background 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease",
        boxShadow: palette.glow,
        minWidth: 168,
        justifyContent: "center",
      }}
      aria-pressed={props.isListening}
      aria-busy={view.busy}
    >
      <span
        style={{
          display: "inline-flex",
          width: 18,
          height: 18,
          alignItems: "center",
          justifyContent: "center",
          color: palette.fg,
        }}
      >
        {view.action === "stopListening" ? (
          // Small square — universal "stop / commit" affordance.
          <svg width={12} height={12} viewBox="0 0 12 12">
            <rect x={1} y={1} width={10} height={10} rx={2} fill="currentColor" />
          </svg>
        ) : (
          <Icon.Mic size={16} />
        )}
      </span>
      <span>{view.label}</span>
      {props.isListening && (
        <span
          className="pulsar"
          style={{
            background: "var(--accent)",
            width: 6,
            height: 6,
            borderRadius: 999,
            display: "inline-block",
          }}
        />
      )}
    </button>
  );
}
