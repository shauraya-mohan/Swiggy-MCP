"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
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

/**
 * useDemoProvider — drives a step pointer through DEMO_SCRIPT on a timer.
 * Pauseable. Loops back to step 0 when the script finishes.
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
  const [paused, setPaused] = useState(false);

  const current = DEMO_SCRIPT[step] ?? DEMO_SCRIPT[0];

  useEffect(() => {
    if (paused) return;
    const dur = current?.durationMs ?? 3000;
    const t = setTimeout(() => {
      setStep((i) => (i + 1) % DEMO_SCRIPT.length);
    }, dur);
    return () => clearTimeout(t);
  }, [step, paused, current]);

  const manifest = useMemo<AgentManifest>(
    () => stripDemoMeta(current),
    [current]
  );

  const togglePlay = useCallback(() => setPaused((p) => !p), []);

  const jumpToIntent = useCallback((intent: IntentMode) => {
    const idx = DEMO_SCRIPT.findIndex((s) => s.intent === intent);
    if (idx >= 0) setStep(idx);
  }, []);

  const reset = useCallback(() => {
    setStep(0);
    setPaused(false);
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
