import type { AgentManifest } from "@/lib/agent/manifest";

/**
 * DemoStep — a scripted AgentManifest plus how long to dwell on it before the
 * demo provider advances to the next step. Mirrors the 18-step SCRIPT in the
 * Claude Design playground (Cooking → Ordering → Dining Out, then loops).
 */
export interface DemoStep extends AgentManifest {
  id: string;
  durationMs: number;
}

/**
 * 18 steps. Content (pasta carbonara ingredients, Soi 38 / House of Lemongrass
 * Thai picks, Olive Bistro / Toscano negotiator slots, ETA + status copy) is
 * ported verbatim from the design prototype — do not rewrite without
 * coordinating with the system prompt.
 */
export const DEMO_SCRIPT: DemoStep[] = [
  // ---------- COOKING flow ----------
  {
    id: "cook-intro",
    intent: "cook",
    aura: "idle",
    userSays: "I want to make pasta carbonara for two",
    durationMs: 3200,
  },
  {
    id: "cook-listen",
    intent: "cook",
    aura: "listening",
    userSays: "I want to make pasta carbonara for two",
    durationMs: 2400,
  },
  {
    id: "cook-think",
    intent: "cook",
    aura: "thinking",
    agentSays: "Pulling ingredients from Instamart…",
    durationMs: 1600,
  },
  {
    id: "cook-show",
    intent: "cook",
    aura: "speaking",
    agentSays: "You'll need these. Pancetta only comes in 200g packs.",
    cards: [
      {
        kind: "instamart",
        id: "im-pancetta",
        name: "Pancetta",
        reason: "You asked for 120g. Smallest pack is 200g pack.",
        pack: "200g pack",
        price: 420,
        imageHue: 12,
      },
      {
        kind: "instamart",
        id: "im-pecorino",
        name: "Pecorino Romano",
        reason: "You asked for 80g. Smallest pack is 150g block.",
        pack: "150g block",
        price: 385,
        imageHue: 50,
      },
      {
        kind: "instamart",
        id: "im-peppercorns",
        name: "Black Peppercorns",
        reason: "You asked for a pinch. Smallest pack is 50g jar.",
        pack: "50g jar",
        price: 95,
        imageHue: 28,
      },
    ],
    durationMs: 5500,
  },
  {
    id: "cook-confirm",
    intent: "cook",
    aura: "success",
    agentSays: "Added to cart. Delivering in 12 minutes.",
    cards: [
      {
        kind: "instamart",
        id: "im-pancetta",
        name: "Pancetta",
        reason: "You asked for 120g. Smallest pack is 200g pack.",
        pack: "200g pack",
        price: 420,
        imageHue: 12,
        state: "added",
      },
      {
        kind: "instamart",
        id: "im-pecorino",
        name: "Pecorino Romano",
        reason: "You asked for 80g. Smallest pack is 150g block.",
        pack: "150g block",
        price: 385,
        imageHue: 50,
        state: "added",
      },
      {
        kind: "instamart",
        id: "im-peppercorns",
        name: "Black Peppercorns",
        reason: "You asked for a pinch. Smallest pack is 50g jar.",
        pack: "50g jar",
        price: 95,
        imageHue: 28,
        state: "added",
      },
    ],
    confirm: { title: "3 items · ₹900", subtitle: "Arrives in 12 min" },
    durationMs: 3200,
  },

  // ---------- ORDERING flow ----------
  {
    id: "order-intro",
    intent: "order",
    aura: "idle",
    userSays: "Actually, just order me something Thai",
    durationMs: 2400,
  },
  {
    id: "order-listen",
    intent: "order",
    aura: "listening",
    userSays: "Actually, just order me something Thai",
    durationMs: 2400,
  },
  {
    id: "order-think",
    intent: "order",
    aura: "thinking",
    agentSays: "Scanning 8 nearby restaurants…",
    durationMs: 1600,
  },
  {
    id: "order-show",
    intent: "order",
    aura: "speaking",
    agentSays: "Best matches under 30 minutes.",
    cards: [
      {
        kind: "restaurant",
        id: "res-soi-38",
        name: "Soi 38",
        cuisine: "Bangkok street food · 1.2 km",
        rating: 4.6,
        etaMinutes: 24,
        price: 540,
        imageHue: 30,
        agentPick: { item: "Pad kee mao with prawns", price: 540 },
      },
      {
        kind: "restaurant",
        id: "res-lemongrass",
        name: "House of Lemongrass",
        cuisine: "Modern Thai · 2.1 km",
        rating: 4.4,
        etaMinutes: 28,
        price: 680,
        imageHue: 18,
        agentPick: { item: "Massaman lamb shank", price: 680 },
      },
    ],
    durationMs: 5000,
  },
  {
    id: "order-progress",
    intent: "order",
    aura: "success",
    agentSays: "Ordered Pad Kee Mao from Soi 38.",
    cards: [
      {
        kind: "delivery",
        status: "Soi 38 · preparing your order",
        etaMinutes: 24,
        progress: 0.18,
        stage: "prep",
      },
    ],
    durationMs: 3000,
  },
  {
    id: "order-progress2",
    intent: "order",
    aura: "idle",
    cards: [
      {
        kind: "delivery",
        status: "Rohan is on the way",
        etaMinutes: 11,
        progress: 0.68,
        stage: "route",
      },
    ],
    durationMs: 3200,
  },

  // ---------- DINING OUT flow ----------
  {
    id: "dine-intro",
    intent: "dine",
    aura: "idle",
    userSays: "Book us a table at Olive, 8pm tonight",
    durationMs: 2400,
  },
  {
    id: "dine-listen",
    intent: "dine",
    aura: "listening",
    userSays: "Book us a table at Olive, 8pm tonight",
    durationMs: 2400,
  },
  {
    id: "dine-think",
    intent: "dine",
    aura: "thinking",
    agentSays: "Checking availability…",
    durationMs: 1600,
  },
  {
    id: "dine-negotiate",
    intent: "dine",
    aura: "speaking",
    agentSays: "8pm is full. Here's what I found.",
    negotiator: {
      headline: "8:00 at Olive Bistro is full.",
      restaurantStrikethrough: "Olive Bistro",
      slots: [
        {
          time: "7:15",
          label: "EARLIER",
          available: true,
          rationale: {
            headline: "Earlier slot, same restaurant",
            note: "You'd skip the late-evening crowd. Sunset terrace seating likely.",
          },
        },
        {
          time: "8:00",
          label: "REQUESTED",
          available: false,
        },
        {
          time: "8:45",
          label: "+45 MIN",
          available: true,
          rationale: {
            headline: "Same restaurant, slight wait",
            note: "Olive has a 45-minute opening on the patio. Similar buzz to your usual.",
          },
        },
        {
          time: "8:30",
          label: "SIMILAR VIBE",
          available: true,
          restaurant: "Toscano",
          rationale: {
            headline: "Toscano — 4 min walk, same vibe",
            note: "Modern Italian, comparable wine list. 4.5★ from your regulars.",
          },
        },
      ],
      focusedSlotIndex: 2,
      state: "choosing",
    },
    durationMs: 6500,
  },
  {
    id: "dine-confirm",
    intent: "dine",
    aura: "success",
    agentSays: "Booked Olive at 8:45 PM for 2.",
    confirm: { title: "Olive Bistro · 8:45 PM", subtitle: "Table for 2 confirmed" },
    durationMs: 3200,
  },
];
