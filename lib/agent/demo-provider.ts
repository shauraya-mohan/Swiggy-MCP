"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { AgentManifest, IntentMode } from "@/lib/agent/manifest";
import { DEMO_SCRIPT, type DemoStep } from "@/agent/scripts/demo-script";

/** Strip the demo-only `id` and `durationMs` so the manifest matches AgentManifest exactly. */
function stripDemoMeta(step: DemoStep): AgentManifest {
  return {
    intent: step.intent,
    aura: step.aura,
    userSays: step.userSays,
    agentSays: step.agentSays,
    cards: step.cards,
    negotiator: step.negotiator,
    confirm: step.confirm,
  };
}

// Shortest valid WAV (a single silent sample), used to "prime" the shared
// <audio> element inside a real click. Browsers gate autoplay-with-sound
// behind a user gesture — Chrome per-origin, Safari per-element — and
// playing anything (even silence) synchronously inside the click satisfies
// both, so every later `.play()` on this same element (including from a
// setTimeout) goes through unblocked.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/**
 * useDemoProvider — drives a step pointer through DEMO_SCRIPT on a timer.
 * Pauseable. Loops back to step 0 when the script finishes.
 *
 * Starts PAUSED (rather than autoplaying on mount) so the first
 * `togglePlay()` — a real click on the StepCounter's PLAY button — can
 * double as the user gesture that unlocks the shared `<audio>` element.
 * Step advancement is always driven by the fixed `durationMs` timer, never
 * by the audio's `ended` event: if a clip is missing or blocked, the demo
 * still runs to schedule instead of stalling on dead air.
 *
 * Freezes on the last step instead of wrapping back to step 0 — an
 * abrupt restart mid-recording is the fastest way to reveal this is a
 * loop. `jumpToIntent` (the bottom pill strip) can still manually rewind.
 */
export interface DemoProviderState {
  manifest: AgentManifest;
  step: number;
  totalSteps: number;
  isPlaying: boolean;
  togglePlay: () => void;
  jumpToIntent: (intent: IntentMode) => void;
  reset: () => void;
}

export function useDemoProvider(): DemoProviderState {
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const unlockedRef = useRef(false);

  const current = DEMO_SCRIPT[step] ?? DEMO_SCRIPT[0];

  useEffect(() => {
    if (paused) return;
    const dur = current?.durationMs ?? 3000;
    const isLastStep = step === DEMO_SCRIPT.length - 1;
    const t = setTimeout(() => {
      if (isLastStep) {
        setPaused(true);
        return;
      }
      setStep((i) => i + 1);
    }, dur);
    return () => clearTimeout(t);
  }, [step, paused, current]);

  // Play the step's spoken clip (public/demo-audio/{id}.mp3), if any,
  // whenever we land on it while playing. Purely additive — a 404,
  // network hiccup, or autoplay block is swallowed; the caption + timer
  // above already carry the demo forward on schedule regardless.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    if (paused || !current?.agentSays) return;
    audio.src = `/demo-audio/${current.id}.wav`;
    audio.currentTime = 0;
    void audio.play().catch(() => {});
    return () => audio.pause();
  }, [step, paused, current]);

  const manifest = useMemo<AgentManifest>(
    () => stripDemoMeta(current),
    [current]
  );

  const togglePlay = useCallback(() => {
    if (!unlockedRef.current) {
      unlockedRef.current = true;
      const el = audioRef.current ?? new Audio();
      audioRef.current = el;
      el.src = SILENT_WAV;
      void el.play().catch(() => {});
    }
    setPaused((p) => !p);
  }, []);

  const jumpToIntent = useCallback((intent: IntentMode) => {
    const idx = DEMO_SCRIPT.findIndex((s) => s.intent === intent);
    if (idx >= 0) setStep(idx);
  }, []);

  const reset = useCallback(() => {
    audioRef.current?.pause();
    setStep(0);
    setPaused(true);
  }, []);

  return {
    manifest,
    step,
    totalSteps: DEMO_SCRIPT.length,
    isPlaying: !paused,
    togglePlay,
    jumpToIntent,
    reset,
  };
}
