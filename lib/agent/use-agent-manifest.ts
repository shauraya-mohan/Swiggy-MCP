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
export function useAgentManifest(
  initialMode: ProviderMode = "demo",
  /**
   * Optional Realtime voice the live session should mint with. Changing
   * this WHILE in live mode tears the session down and rebuilds it with
   * the new voice — useful so the Tweaks panel's voice picker has an
   * audible effect within seconds. In demo mode it's a no-op (no real
   * session to apply it to).
   */
  voice?: string,
): AgentManifestProvider {
  const [mode, setMode] = useState<ProviderMode>(initialMode);
  const demo = useDemoProvider();
  const live = useLiveProvider();
  const lastModeRef = useRef<ProviderMode>(initialMode);
  const lastVoiceRef = useRef<string | undefined>(voice);

  // Lazily open/close the live session in response to mode changes.
  // Using a ref guard prevents double-start during React 19 StrictMode
  // dev double-invocation of effects.
  useEffect(() => {
    if (mode === lastModeRef.current) return;
    lastModeRef.current = mode;
    if (mode === "live") {
      void live.startSession({ voice });
    } else {
      void live.endSession();
    }
    // `voice` intentionally excluded from deps — this effect is keyed
    // on mode transitions only. Voice changes get their own effect
    // below. If both changed in the same tick (rare), the voice effect
    // wins because it runs second and explicitly restarts the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, live]);

  // Restart the session when the voice changes WHILE in live mode.
  // No-op in demo (no session to restart) and on the very first render
  // (lastVoiceRef seeded equal to current). We tear down before bringing
  // up so the underlying WebRTC peer connection is fully released —
  // OpenAI charges per session and the realtime-client cleanup also
  // closes the AudioContexts that would otherwise leak.
  useEffect(() => {
    if (voice === lastVoiceRef.current) return;
    lastVoiceRef.current = voice;
    if (mode !== "live") return;
    (async () => {
      await live.endSession();
      await live.startSession({ voice });
    })();
    // mode intentionally excluded — we don't want a mode flip to also
    // trigger this branch; that's handled by the mode effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, live]);

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
    // Live-only: demo has no real tool calls to gate, so no consent
    // resolver is exposed. Card components / ConfirmationSheet check
    // `provider.confirmMutation !== undefined` to decide whether to
    // render an interactive sheet vs a pure visual preview.
    confirmMutation: mode === "live" ? live.confirmMutation : undefined,
    agentAudible: mode === "live" ? live.agentAudible : false,
  };
}
