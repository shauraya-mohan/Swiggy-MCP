"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "@/lib/design/icons";
import type { AuraState, IntentMode, ProviderMode } from "@/lib/agent/manifest";

/**
 * TweaksPanel — toolbar-toggled developer panel for runtime knobs.
 *
 * Sections: Mode (demo/live), Glass blur intensity, Accent swatches,
 * Intent override, Aura state override.
 *
 * NOTE on voice: we A/B'd the full modern OpenAI Realtime set
 * (marin, cedar, verse, ash, coral, ballad, sage) and landed on
 * `sage` as the production voice — measured, neutral, calm-advisor.
 * The picker is intentionally removed from the panel; the field is
 * still in TweaksState + plumbed through useAgentManifest in case we
 * want to A/B again later, but the UI doesn't expose it. To
 * experiment, hit /api/voice/session?voice=<name> directly or flip
 * DEFAULT_TWEAKS.voice below.
 */

export type TweaksIntent = "auto" | IntentMode;
export type TweaksAura = "auto" | AuraState;

/**
 * OpenAI Realtime voice — kept as a typed field for the API surface,
 * but the picker is no longer rendered in the panel. See note above.
 */
export type TweaksVoice =
  | "marin"
  | "cedar"
  | "verse"
  | "ash"
  | "coral"
  | "ballad"
  | "sage";

export interface TweaksState {
  glassBlur: number; // 0..100
  accent: string;
  intent: TweaksIntent;
  auraState: TweaksAura;
  voice: TweaksVoice;
}

export const DEFAULT_TWEAKS: TweaksState = {
  glassBlur: 40,
  accent: "#FC8019",
  intent: "auto",
  auraState: "auto",
  voice: "sage",
};

const ACCENT_SWATCHES = ["#FC8019", "#6FD8C8", "#B380FF", "#FFD166"];

export function TweaksPanel({
  state,
  onChange,
  mode,
  onModeChange,
}: {
  state: TweaksState;
  onChange: (next: TweaksState) => void;
  mode: ProviderMode;
  onModeChange: (mode: ProviderMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const set = <K extends keyof TweaksState>(key: K, value: TweaksState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Close tweaks" : "Open tweaks"}
        className="btn-ghost"
        style={{
          position: "fixed",
          bottom: 32,
          right: 32,
          zIndex: 50,
          width: 38,
          height: 38,
          padding: 0,
          display: "grid",
          placeItems: "center",
          borderRadius: "50%",
        }}
      >
        {open ? <Icon.Close size={14} /> : <Icon.Spark size={14} />}
      </button>

      {open && (
        <div
          className="glass"
          style={{
            position: "fixed",
            bottom: 82,
            right: 32,
            zIndex: 50,
            width: 280,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 18,
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          <div
            style={{
              position: "relative",
              zIndex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <div
              className="font-mono no-select"
              style={{ fontSize: 10, letterSpacing: "0.18em", color: "var(--fg-mute)" }}
            >
              TWEAKS
            </div>
          </div>

          <Section label="Mode">
            <SegmentedSelect
              value={mode}
              options={[
                { value: "demo", label: "Demo" },
                { value: "live", label: "Live" },
              ]}
              onChange={(v) => onModeChange(v as ProviderMode)}
            />
          </Section>

          <Section label="Glass">
            <Slider
              label="Blur intensity"
              value={state.glassBlur}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => set("glassBlur", v)}
            />
          </Section>

          <Section label="Accent color">
            <Swatches
              value={state.accent}
              options={ACCENT_SWATCHES}
              onChange={(v) => set("accent", v)}
            />
          </Section>

          <Section label="Intent">
            <SegmentedSelect
              value={state.intent}
              options={[
                { value: "auto", label: "Auto" },
                { value: "cook", label: "Cook" },
                { value: "order", label: "Order" },
                { value: "dine", label: "Dine" },
              ]}
              onChange={(v) => set("intent", v as TweaksIntent)}
            />
          </Section>

          <Section label="Aura">
            <SegmentedSelect
              value={state.auraState}
              options={[
                { value: "auto", label: "Auto" },
                { value: "idle", label: "Idle" },
                { value: "listening", label: "Listening" },
                { value: "thinking", label: "Thinking" },
                { value: "speaking", label: "Speaking" },
                { value: "success", label: "Success" },
              ]}
              onChange={(v) => set("auraState", v as TweaksAura)}
            />
          </Section>
        </div>
      )}
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        className="font-mono no-select"
        style={{
          fontSize: 9,
          letterSpacing: "0.18em",
          color: "var(--fg-mute)",
        }}
      >
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 11,
          color: "var(--fg-dim)",
        }}
      >
        <span>{label}</span>
        <span className="font-mono" style={{ color: "var(--fg-mute)" }}>
          {value}
          {unit ?? ""}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={sliderStyle}
      />
    </label>
  );
}

function Swatches({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {options.map((c) => {
        const selected = value.toLowerCase() === c.toLowerCase();
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            aria-label={c}
            style={{
              width: 26,
              height: 26,
              borderRadius: 999,
              background: c,
              border: selected
                ? "2px solid var(--fg)"
                : "1px solid rgba(255,255,255,0.12)",
              boxShadow: selected
                ? `0 0 14px ${c}55`
                : "0 1px 0 rgba(0,0,0,0.4) inset",
              cursor: "pointer",
              padding: 0,
            }}
          />
        );
      })}
    </div>
  );
}

function SegmentedSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
      }}
    >
      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={clsx("btn-ghost", isActive && "active")}
            style={{
              padding: "5px 10px",
              fontSize: 10,
              flex: "0 1 auto",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

const sliderStyle: CSSProperties = {
  appearance: "none",
  width: "100%",
  height: 3,
  background: "rgba(255,255,255,0.1)",
  borderRadius: 999,
  outline: "none",
  cursor: "pointer",
  accentColor: "var(--accent)",
};
