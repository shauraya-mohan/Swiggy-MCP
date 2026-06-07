"use client";

import { useEffect, useRef, useState } from "react";
import { Aura } from "@/components/voice/Aura";
import { TranscriptStream } from "@/components/voice/TranscriptStream";
import { AgentCaption } from "@/components/voice/AgentCaption";
import { IntentPillStrip } from "@/components/voice/IntentPill";
import { VoiceButton, type VoiceButtonAction } from "@/components/voice/VoiceButton";
import { RestaurantCard } from "@/components/cards/RestaurantCard";
import { InstamartCard } from "@/components/cards/InstamartCard";
import { DeliveryCard } from "@/components/cards/DeliveryCard";
import { ConfirmCard } from "@/components/cards/ConfirmCard";
import { ConfirmationSheet } from "@/components/cards/ConfirmationSheet";
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

// No card cap on the panel — the agent's spoken summary still names at
// most 3, but the panel renders the full set and scrolls. An Instamart
// basket of 5+ items is normal; capping the visible list at 3 made
// later additions (milk, the 4th ingredient) silently disappear off
// the bottom of the slice. The mask + scroll already handle overflow.

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
  // effectiveAura = "what the orb + button should reflect right now"
  // Resolution order, highest priority first:
  //   1. Tweaks panel manual override (debug only)
  //   2. Real audio is currently audible → speaking (overrides server
  //      state so the button stays on "Interrupt" until the user actually
  //      stops hearing the agent — fixes the "response.done flips the
  //      button to Tap-to-Talk while audio is still playing" race).
  //   3. Whatever the event reducer says.
  const effectiveAura =
    tweaks.auraState !== "auto"
      ? tweaks.auraState
      : provider.agentAudible
        ? "speaking"
        : provider.manifest.aura;

  const manifest = provider.manifest;
  const cards = manifest.cards ?? [];

  // Auto-scroll the cards column to the bottom whenever its length
  // grows. Without this, freshly added items (e.g. milk being the 4th
  // ingredient) land below the viewport and the user assumes the agent
  // never added them. Bottom-aligned because new cards append there in
  // upsertCards / syncCartCards.
  const cardsScrollRef = useRef<HTMLDivElement | null>(null);
  const prevCardsLenRef = useRef(0);
  useEffect(() => {
    const el = cardsScrollRef.current;
    if (!el) return;
    if (cards.length > prevCardsLenRef.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
    prevCardsLenRef.current = cards.length;
  }, [cards.length]);

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
          <Aura
            state={effectiveAura}
            intent={effectiveIntent}
            size={340}
            inboundAnalyser={provider.inboundAnalyser ?? null}
            outboundAnalyser={provider.outboundAnalyser ?? null}
          />
          {/* The two bubbles trade off in strict sequence:
              - User talks (listening) → transcript fills
              - User taps send (thinking) → transcript STAYS visible while
                the model composes
              - Agent starts speaking → transcript HIDES, caption fills
              - Agent done (idle) → caption STAYS visible until the user
                opens the next turn (startListening clears both)
              The `!agentSays` guard on the transcript prevents the previous
              user line from re-appearing after the agent finishes (when aura
              flips back to idle). */}
          <TranscriptStream
            text={manifest.userSays}
            active={
              !!manifest.userSays &&
              !manifest.agentSays &&
              (effectiveAura === "listening" || effectiveAura === "thinking")
            }
            streaming={provider.mode === "live"}
          />
          <AgentCaption
            text={manifest.agentSays}
            active={!!manifest.agentSays && effectiveAura !== "listening"}
            streaming={provider.mode === "live"}
          />
        </div>

        {/* Context cards (left of aura).
            Scrollable column with symmetric top + bottom fade-out masks.
            The mask makes both edges dissolve into the dark scene background
            instead of hard-cutting — matches the natural fade-at-viewport-edge
            the bottom card already had from page overflow. Scrollbar is
            visually hidden (className=hide-scrollbar in globals) so the
            void-into-void aesthetic stays clean. */}
        {cards.length > 0 && (
          <div
            ref={cardsScrollRef}
            className="hide-scrollbar"
            style={{
              position: "absolute",
              left: "6%",
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              maxHeight: "80vh",
              overflowY: "auto",
              paddingTop: 40,
              paddingBottom: 40,
              WebkitMaskImage:
                "linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%)",
              maskImage:
                "linear-gradient(to bottom, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%)",
            }}
          >
            {cards.map((card, i) => (
              <div
                key={cardKey(card, i)}
                style={{ animationDelay: `${i * 0.15}s`, flexShrink: 0 }}
              >
                {card.kind === "restaurant" && (
                  <RestaurantCard
                    data={card}
                    index={i}
                    total={cards.length}
                    // Tap a restaurant → tell the agent to focus on it.
                    // The agent will pull up the menu / agent pick and
                    // ask the user what they want to order.
                    onTap={
                      provider.sendUserText
                        ? () =>
                            provider.sendUserText!(
                              `Let's go with ${card.name} — what would you recommend?`,
                            )
                        : undefined
                    }
                  />
                )}
                {card.kind === "instamart" && (
                  <InstamartCard
                    data={card}
                    // Tap toggles intent: add if not added, remove if already added.
                    // Agent will read back the change before firing im__update_cart.
                    onTap={
                      provider.sendUserText
                        ? () =>
                            provider.sendUserText!(
                              card.state === "added"
                                ? `Actually, remove the ${card.name} from my cart.`
                                : `Add ${card.name} (${card.pack}) to my cart.`,
                            )
                        : undefined
                    }
                  />
                )}
                {card.kind === "delivery" && <DeliveryCard data={card} />}
              </div>
            ))}
          </div>
        )}

        {/* Negotiator (right of aura) — keyed so a new manifest re-mounts and
            re-seeds the locally-tracked focused/confirmed state.

            Hidden whenever a ConfirmationSheet is up. The Negotiator is for
            disambiguation ("here are slot options"); once the user has
            committed to a specific time the sheet is the active surface
            and the option grid becomes visual noise. The prompt's PATH A
            (direct book on a specific time) means the Negotiator should
            never have rendered in the first place, but this is the
            belt-and-braces guard for cases where the agent already
            populated it. */}
        {manifest.negotiator && !manifest.pendingMutation && (
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
              // CONFIRM button → hands off to the agent, which then
              // does the verbal readback ("Booking Toscano, 7:30 PM,
              // table for two — confirm?") before firing book_table.
              onConfirmSlot={
                provider.sendUserText
                  ? ({ time }) =>
                      provider.sendUserText!(
                        `Book the ${time} slot — that works for me.`,
                      )
                  : undefined
              }
            />
          </div>
        )}

        {/* Pre-mutation gate (right side, vertically centred). Mirrors
            the Negotiator's position so destructive consent shares the
            same visual real-estate as slot disambiguation — the user's
            eyes don't have to chase across the screen for the next
            decision moment. Mutually exclusive with the receipt
            ConfirmCard — the gate appears FIRST (model paused on tool
            call), user resolves it, tool actually runs, then the
            receipt appears in the bottom-centre slot.

            zIndex above the Negotiator so PATH C (book → SLOT_UNAVAILABLE
            → get_available_slots populates Negotiator → book again on
            user pick) renders the sheet on top of any stale panel,
            though the {!pendingMutation} guard on the Negotiator
            usually prevents the overlap. */}
        {manifest.pendingMutation && (
          <div
            style={{
              position: "absolute",
              right: "6%",
              top: "50%",
              transform: "translateY(-50%)",
              zIndex: 10,
            }}
          >
            <ConfirmationSheet
              data={manifest.pendingMutation}
              onConfirm={() =>
                provider.confirmMutation?.(manifest.pendingMutation!.callId, true)
              }
              onCancel={() =>
                provider.confirmMutation?.(manifest.pendingMutation!.callId, false)
              }
            />
          </div>
        )}

        {/* Mutation receipt (bottom centre, above pills). Stays in
            its original slot — the sheet has already cleared by the
            time the receipt appears, and the agent caption is gone
            too (it cleared on the response.done that produced the
            tool result). No collision. */}
        {!manifest.pendingMutation && manifest.confirm && (
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

        {/* Voice control + intent quick-jump strip — stacked at the bottom. */}
        <div
          style={{
            position: "absolute",
            bottom: 32,
            left: "50%",
            transform: "translateX(-50%)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
          }}
        >
          <VoiceButton
            mode={provider.mode}
            connected={!!provider.liveConnected}
            isListening={!!provider.isListening}
            auraState={effectiveAura}
            error={provider.liveError ?? null}
            onAction={(action: VoiceButtonAction) => {
              switch (action) {
                case "openSession":
                  provider.setMode("live");
                  return;
                case "startListening":
                  provider.startListening?.();
                  return;
                case "stopListening":
                  provider.stopListening?.();
                  return;
                case "interrupt":
                  provider.interruptResponse?.();
                  return;
                case "noop":
                default:
                  return;
              }
            }}
          />
          <IntentPillStrip
            active={
              effectiveIntent === "idle" ? manifest.intent : effectiveIntent
            }
            onJump={provider.jumpToIntent}
          />
        </div>

        {/* Live-mode status / error toast (top-right under step counter) */}
        {provider.mode === "live" && (provider.liveError || provider.liveConnected) && (
          <div
            className="font-mono"
            style={{
              position: "absolute",
              top: 76,
              right: 32,
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              padding: "6px 10px",
              borderRadius: 999,
              background: provider.liveError
                ? "rgba(220, 60, 60, 0.18)"
                : "rgba(80, 200, 120, 0.16)",
              border: `1px solid ${
                provider.liveError ? "rgba(220,60,60,0.4)" : "rgba(80,200,120,0.4)"
              }`,
              color: provider.liveError ? "#ffb4b4" : "#bdf0cf",
              maxWidth: 320,
            }}
          >
            {provider.liveError ? `Error: ${provider.liveError}` : "Live · connected"}
          </div>
        )}

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
