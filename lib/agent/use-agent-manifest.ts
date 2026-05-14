"use client";

import { useCallback, useState } from "react";
import type {
  AgentManifest,
  AgentManifestProvider,
  IntentMode,
  ProviderMode,
} from "@/lib/agent/manifest";
import { useDemoProvider } from "@/lib/agent/demo-provider";
import { useLiveProvider } from "@/lib/agent/live-provider";

/**
 * useAgentManifest — unified hook the UI consumes regardless of mode.
 *
 * Internally it holds both demo and live providers and exposes whichever one
 * matches the current `mode`. The demo provider keeps ticking in the
 * background even when mode='live' (cheap; just a setTimeout per step), so
 * switching back is seamless.
 */
export function useAgentManifest(initialMode: ProviderMode = "demo"): AgentManifestProvider {
  const [mode, setMode] = useState<ProviderMode>(initialMode);
  const demo = useDemoProvider();
  const live = useLiveProvider();

  const manifest: AgentManifest = mode === "demo" ? demo.manifest : live.manifest;

  const togglePlay = useCallback(() => {
    if (mode === "demo") demo.togglePlay();
  }, [mode, demo]);

  const jumpToIntent = useCallback(
    (intent: IntentMode) => {
      if (mode === "demo") {
        demo.jumpToIntent(intent);
      }
    },
    [mode, demo]
  );

  return {
    manifest,
    isPlaying: mode === "demo" ? demo.isPlaying : false,
    step: mode === "demo" ? demo.step : 0,
    totalSteps: mode === "demo" ? demo.totalSteps : 0,
    togglePlay,
    jumpToIntent,
    startSession: live.startSession,
    endSession: live.endSession,
    mode,
    setMode,
  };
}
