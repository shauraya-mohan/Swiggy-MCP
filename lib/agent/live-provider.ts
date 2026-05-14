"use client";

import { useCallback } from "react";
import type { AgentManifest } from "@/lib/agent/manifest";
import { IDLE_MANIFEST } from "@/lib/agent/manifest";

/**
 * useLiveProvider — STUB for the real OpenAI Realtime + Cartesia wiring.
 *
 * Today it returns an idle manifest and no-op session controls so the UI can
 * render in "live" mode without crashing. The next handoff (UI HANDOFF #2)
 * fills these in:
 *   - startSession: POST /api/voice/session for an ephemeral token, open the
 *     WebRTC peer connection, attach an AnalyserNode to the inbound audio
 *     track, translate Realtime events into AgentManifest patches.
 *   - endSession: close the peer connection + analyser, fade Aura to idle.
 * Until that lands, mode='live' is purely a placeholder — the Aura sits at
 * idle and no scripted advancement happens.
 */
export interface LiveProviderState {
  manifest: AgentManifest;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
}

export function useLiveProvider(): LiveProviderState {
  const startSession = useCallback(async () => {
    // TODO(handoff-2): mint ephemeral token from /api/voice/session, open
    // WebRTC peer connection, attach AnalyserNode to inbound audio, wire
    // Realtime events into manifest patches.
  }, []);

  const endSession = useCallback(async () => {
    // TODO(handoff-2): close peer connection, detach analyser, fade aura idle.
  }, []);

  return {
    manifest: IDLE_MANIFEST,
    startSession,
    endSession,
  };
}
