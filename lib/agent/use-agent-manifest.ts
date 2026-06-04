"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
 * matches the current `mode`. Switching INTO live mode automatically opens
 * the Realtime session (mic prompt → ephemeral mint → WebRTC); switching out
 * tears it down so the mic LED actually turns off.
 *
 * The demo provider keeps ticking in the background even when mode='live'
 * (cheap; just a setTimeout per step), so switching back is seamless.
 */
export function useAgentManifest(initialMode: ProviderMode = "demo"): AgentManifestProvider {
  const [mode, setMode] = useState<ProviderMode>(initialMode);
  const demo = useDemoProvider();
  const live = useLiveProvider();
  const lastModeRef = useRef<ProviderMode>(initialMode);

  // Lazily open/close the live session in response to mode changes.
  // Using a ref guard prevents double-start during React 19 StrictMode
  // dev double-invocation of effects.
  useEffect(() => {
    if (mode === lastModeRef.current) return;
    lastModeRef.current = mode;
    if (mode === "live") {
      void live.startSession();
    } else {
      void live.endSession();
    }
  }, [mode, live]);

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
    [mode, demo],
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
    inboundAnalyser: mode === "live" ? live.inboundAnalyser : null,
    outboundAnalyser: mode === "live" ? live.outboundAnalyser : null,
    liveError: mode === "live" ? live.liveError : null,
    liveConnected: mode === "live" ? live.liveConnected : false,
    isListening: mode === "live" ? live.isListening : false,
    startListening: live.startListening,
    stopListening: live.stopListening,
    interruptResponse: live.interruptResponse,
    // Live-only: demo cards stay click-to-toggle (no real session to
    // talk to). Gate at the hook layer so card components can just
    // check `provider.sendUserText !== undefined` to decide whether
    // to render in interactive mode.
    sendUserText: mode === "live" ? live.sendUserText : undefined,
    agentAudible: mode === "live" ? live.agentAudible : false,
  };
}
