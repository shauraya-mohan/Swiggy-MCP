"use client";

import { useEffect, useState } from "react";
import { Aura } from "@/components/voice/Aura";
import { TranscriptStream } from "@/components/voice/TranscriptStream";
import { AgentCaption } from "@/components/voice/AgentCaption";
import { IntentPillStrip } from "@/components/voice/IntentPill";
import { RestaurantCard } from "@/components/cards/RestaurantCard";
import { InstamartCard } from "@/components/cards/InstamartCard";
import { DeliveryCard } from "@/components/cards/DeliveryCard";
import { ConfirmCard } from "@/components/cards/ConfirmCard";
import { Negotiator } from "@/components/negotiator/Negotiator";
import { BrandHeader } from "@/components/chrome/BrandHeader";
import { IntentIndicator } from "@/components/chrome/IntentIndicator";
import { StepCounter } from "@/components/chrome/StepCounter";
import {
  TweaksPanel,
  DEFAULT_TWEAKS,
  type TweaksState,
} from "@/components/tweaks/TweaksPanel";
import { useAgentManifest } from "@/lib/agent/use-agent-manifest";
import type { IntentMode } from "@/lib/agent/manifest";
import { blurPercentToPx } from "@/lib/design/tokens";

const MAX_CARDS = 3; // voice contract — max 3 spoken-list items, mirrored here for parity.

export default function VoicePage() {
  const provider = useAgentManifest("demo");
  const [tweaks, setTweaks] = useState<TweaksState>(DEFAULT_TWEAKS);

  // Live-apply tweak CSS vars (blur + accent swatches).
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--glass-blur",
      `${blurPercentToPx(tweaks.glassBlur)}px`
    );
  }, [tweaks.glassBlur]);

  useEffect(() => {
    document.documentElement.style.setProperty("--accent", tweaks.accent);
    document.documentElement.style.setProperty("--accent-soft", tweaks.accent);
    document.documentElement.style.setProperty("--accent-deep", tweaks.accent);
  }, [tweaks.accent]);

  // Resolve effective intent + aura state honouring tweaks overrides.
  const effectiveIntent: IntentMode =
    tweaks.intent !== "auto" ? tweaks.intent : provider.manifest.intent;
  const effectiveAura =
    tweaks.auraState !== "auto" ? tweaks.auraState : provider.manifest.aura;

  const manifest = provider.manifest;
  const cards = (manifest.cards ?? []).slice(0, MAX_CARDS);

  return (
    <main
      style={{
        position: "relative",
        width: "100vw",
        height: "100vh",
        display: "grid",
        placeItems: "center",
        overflow: "hidden",
      }}
    >
      <div className="scene" />

      <div style={{ position: "relative", zIndex: 1, width: "100%", height: "100%" }}>
        {/* Top-left brand */}
        <div style={{ position: "absolute", top: 28, left: 32 }}>
          <BrandHeader />
        </div>

        {/* Top-centre intent indicator */}
        <div
          style={{
            position: "absolute",
            top: 32,
            left: "50%",
            transform: "translateX(-50%)",
          }}
        >
          <IntentIndicator intent={effectiveIntent} />
        </div>

        {/* Top-right step counter (demo mode shows the full counter; live mode just play/pause). */}
        <div style={{ position: "absolute", top: 28, right: 32 }}>
          <StepCounter
            step={provider.step}
            total={provider.mode === "demo" ? provider.totalSteps : 0}
            isPlaying={provider.isPlaying}
            onToggle={provider.togglePlay}
          />
        </div>

        {/* Aura + transcripts (centre) */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            display: "grid",
            placeItems: "center",
          }}
        >
          <Aura state={effectiveAura} intent={effectiveIntent} size={340} />
          <TranscriptStream
            key={`transcript-${manifest.userSays ?? ""}`}
            text={manifest.userSays}
            active={
              !!manifest.userSays &&
              (effectiveAura === "listening" || effectiveAura === "idle")
            }
          />
          <AgentCaption
            key={manifest.agentSays /* remount → re-fade */}
            text={manifest.agentSays}
            active={
              !!manifest.agentSays &&
              (effectiveAura === "speaking" ||
                effectiveAura === "success" ||
                effectiveAura === "thinking")
            }
          />
        </div>

        {/* Context cards (left of aura) */}
        {cards.length > 0 && (
          <div
            style={{
              position: "absolute",
              left: "6%",
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              maxHeight: "80vh",
            }}
          >
            {cards.map((card, i) => (
              <div
                key={cardKey(card, i)}
                style={{ animationDelay: `${i * 0.15}s` }}
              >
                {card.kind === "restaurant" && (
                  <RestaurantCard data={card} index={i} total={cards.length} />
                )}
                {card.kind === "instamart" && <InstamartCard data={card} />}
                {card.kind === "delivery" && <DeliveryCard data={card} />}
              </div>
            ))}
          </div>
        )}

        {/* Negotiator (right of aura) — keyed so a new manifest re-mounts and
            re-seeds the locally-tracked focused/confirmed state. */}
        {manifest.negotiator && (
          <div
            style={{
              position: "absolute",
              right: "6%",
              top: "50%",
              transform: "translateY(-50%)",
            }}
          >
            <Negotiator
              key={`neg-${manifest.negotiator.headline}-${manifest.negotiator.focusedSlotIndex}`}
              data={manifest.negotiator}
            />
          </div>
        )}

        {/* Confirm card (bottom centre, above pills) */}
        {manifest.confirm && (
          <div
            style={{
              position: "absolute",
              bottom: 120,
              left: "50%",
              transform: "translateX(-50%)",
            }}
          >
            <ConfirmCard data={manifest.confirm} />
          </div>
        )}

        {/* Intent quick-jump strip */}
        <div
          style={{
            position: "absolute",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
          }}
        >
          <IntentPillStrip
            active={
              effectiveIntent === "idle" ? manifest.intent : effectiveIntent
            }
            onJump={provider.jumpToIntent}
          />
        </div>

        {/* Tweaks panel — floating bottom-right */}
        <TweaksPanel
          state={tweaks}
          onChange={setTweaks}
          mode={provider.mode}
          onModeChange={provider.setMode}
        />
      </div>
    </main>
  );
}

function cardKey(card: { kind: string } & Partial<{ id: string }>, index: number) {
  return card.id ?? `${card.kind}-${index}`;
}
