/**
 * AgentManifest — the seam between voice/agent events and UI rendering.
 *
 * Whether the manifest comes from a scripted demo (lib/agent/demo-provider.ts)
 * or from real OpenAI Realtime events (lib/agent/live-provider.ts, wired in a
 * later handoff), the UI consumes the same shape. This contract is load-bearing
 * for downstream work — flag to the user before changing it.
 */

export type IntentMode = "cook" | "order" | "dine" | "idle";

export type AuraState = "idle" | "listening" | "thinking" | "speaking" | "success";

export interface RestaurantCardData {
  kind: "restaurant";
  id: string;
  name: string;
  cuisine: string;
  rating: number;
  etaMinutes: number;
  price: number;
  imageHue?: number;
  agentPick?: { item: string; price: number };
  state?: "default" | "ordered";
}

export interface InstamartCardData {
  kind: "instamart";
  id: string;
  name: string;
  /** Sentence the agent uses to justify the SKU. e.g. "You asked for 120g. Smallest pack is 200g pack." */
  reason: string;
  /** Badge text — the Minimum Viable Quantity. e.g. "200g" */
  pack: string;
  price: number;
  imageHue?: number;
  state?: "default" | "added";
}

export type DeliveryStage = "prep" | "route" | "arriving";

export interface DeliveryCardData {
  kind: "delivery";
  etaMinutes: number;
  /** Spoken status line, e.g. "Soi 38 · preparing your order" */
  status: string;
  /** 0..1 */
  progress: number;
  stage: DeliveryStage;
}

export type CardData = RestaurantCardData | InstamartCardData | DeliveryCardData;

export interface NegotiatorSlot {
  /**
   * Stable id from the source slot (DineoutSlot.slotId). Used as the
   * React key in the Negotiator panel. Two slots can otherwise share
   * the same {time, label} pair (e.g., 12:00 LUNCH on different days)
   * and would collide on a composite key.
   */
  id?: string;
  /** e.g. "8:00 PM" */
  time: string;
  /** Short uppercase label. e.g. "EARLIER" / "REQUESTED" / "+45 MIN" / "SIMILAR VIBE" */
  label: string;
  available: boolean;
  /** Override for similar-vibe alternates that point to a different restaurant. */
  restaurant?: string;
  rationale?: { headline: string; note: string };
}

export interface NegotiatorData {
  /** e.g. "8:00 PM at Olive Bistro is full." */
  headline: string;
  /**
   * Spoken-form date the panel is showing slots for: "today",
   * "tomorrow", "Sat, May 30". Lets the UI render the requested date
   * next to the headline so the user can verify the agent dialled the
   * right day — without this the panel could silently show next-Monday
   * slots while the user thought they asked about tonight.
   */
  dateLabel?: string;
  restaurantStrikethrough?: string;
  slots: NegotiatorSlot[];
  focusedSlotIndex: number;
  state: "choosing" | "confirmed";
}

export interface ConfirmData {
  title: string;
  subtitle: string;
}

export interface AgentManifest {
  intent: IntentMode;
  aura: AuraState;
  userSays?: string;
  agentSays?: string;
  cards?: CardData[];
  negotiator?: NegotiatorData;
  confirm?: ConfirmData;
}

export type ProviderMode = "demo" | "live";

export interface AgentManifestProvider {
  manifest: AgentManifest;
  /** Demo-mode play state. Live mode keeps this at false. */
  isPlaying: boolean;
  /** 0-indexed step in the demo script. 0 in live mode. */
  step: number;
  totalSteps: number;
  togglePlay: () => void;
  /** Demo: snap to the first step matching this intent. Live: no-op. */
  jumpToIntent: (intent: IntentMode) => void;
  /** Live: open Realtime session. Demo: no-op. */
  startSession: () => Promise<void>;
  /** Live: close Realtime session. Demo: no-op. */
  endSession: () => Promise<void>;
  mode: ProviderMode;
  setMode: (mode: ProviderMode) => void;
  /**
   * Live mode only — Web Audio analyser on the agent's audio output. When set,
   * the Aura reads real frequency bins from this in `speaking`/`thinking` states
   * instead of its Math.sin fallback. Null in demo mode or before the inbound
   * track lands.
   */
  inboundAnalyser?: AnalyserNode | null;
  /** Live mode only — Web Audio analyser on the user's microphone input. */
  outboundAnalyser?: AnalyserNode | null;
  /** Live mode only — last transport / session error, surfaced for UI. */
  liveError?: string | null;
  /** Live mode only — true while the WebRTC connection is up. */
  liveConnected?: boolean;
  /** Live mode only — true while the user has the floor (mic enabled). */
  isListening?: boolean;
  /** Live mode only — open the floor. No-op in demo. */
  startListening?: () => void;
  /** Live mode only — close the floor, commit, ask the model to respond. */
  stopListening?: () => void;
  /** Live mode only — cancel an in-progress agent response. */
  interruptResponse?: () => void;
  /**
   * Live mode only — inject a synthetic user message into the
   * conversation, as if the user had just spoken it. The agent
   * still observes the verbal-confirm contract before any mutation,
   * so a misclick is never silently destructive — it just sets the
   * agent up to ask for confirmation.
   *
   * No-op while the user is mid-utterance (the live mic takes
   * priority); also no-op in demo mode.
   */
  sendUserText?: (text: string) => void;
  /**
   * Live mode only — true while the inbound audio analyser sees real
   * energy from the agent's voice. Use this (not aura alone) to gate
   * "is the agent currently audible right now?" UI affordances like
   * the Interrupt button. Lags the audio by ≤ 50 ms on the rising edge
   * and ~500 ms on the falling edge (hysteresis prevents flicker on
   * mid-sentence pauses).
   */
  agentAudible?: boolean;
}

export const IDLE_MANIFEST: AgentManifest = {
  intent: "idle",
  aura: "idle",
};
