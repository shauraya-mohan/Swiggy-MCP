# Kitchen Copilot

> Voice-first AI agent that turns "what's for dinner?" into action. Wired into [Swiggy MCP](https://mcp.swiggy.com/builders/docs/) (Food, Instamart, Dineout) with sub-second human-grade voice.

**Status:** Step 4 / 10 — OAuth 2.1 + PKCE flow and real-MCP client wired behind the router. Awaiting Swiggy credentials to flip `SWIGGY_MODE=real`; mock mode remains the default.

---

## What this is

An *Executive Assistant for the Kitchen.* Ask it to cook, order in, or head out, and it routes you to the right Swiggy surface — finding restaurants, auditing your ingredients, or negotiating a table — all hands-free.

Three modules over a unified voice agent:

| Module | Surface | What it does |
| --- | --- | --- |
| **Scout** | Swiggy Food | Deep menu parsing, cart consolidation, live delivery ETAs |
| **Auditor** | Swiggy Instamart | Recipe gap analysis + Minimum Viable Quantity SKU picking |
| **Negotiator** | Swiggy Dineout | Slot search with ±30 min flex, "similar vibes" fallback |

## Stack

| Layer | Pick |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Styling | Tailwind 4 + Framer Motion |
| Voice in | OpenAI Realtime API (`gpt-4o-realtime`, text-out mode) |
| Voice out | Cartesia Sonic-2 streaming TTS → browser AudioWorklet |
| MCP client | `@modelcontextprotocol/sdk` streamable-HTTP (real mode) + JSON stubs (mock mode) |
| Auth | OAuth 2.1 + PKCE (when SWIGGY_MODE=real) |
| Language | TypeScript 5 |

## Modes

| Env var | Default | What it does |
| --- | --- | --- |
| `SWIGGY_MODE` | `mock` | `mock` reads JSON stubs; `real` calls live `mcp.swiggy.com` |
| `LIVE_MUTATIONS` | `false` | Hard kill on `place_food_order` / `checkout` / `book_table` even in real mode |

Mock mode lets us build and demo the entire experience without production credentials, exactly as the [docs recommend](https://mcp.swiggy.com/builders/docs/operate/access.md#build-locally-first-then-send-us-a-video).

## Getting started

```bash
cp .env.example .env.local
# fill in OPENAI_API_KEY and CARTESIA_API_KEY when you reach Step 6/7
npm install
npm run dev
```

Open <http://localhost:3000>.

### Verifying the mock layer

The mock data and its 35 tool implementations are continuously validated against the PRD. Two test scripts ship today:

```bash
npm run test:mocks       # smoke test: every tool returns a valid envelope (35/35)
npm run test:scenarios   # PRD-aligned scenarios: 79 assertions across 12 flows
npm run test:router      # router checks: manifest, validation, kill-switch (28 assertions)
npm run test:auth        # OAuth PKCE + real-MCP client wire-format (33 assertions)
npm test                 # typecheck + all four suites (175 assertions total)
```

`scripts/scenarios.ts` walks the actual user journeys from PRD §3.1-§3.4:

| Scenario | What it proves |
| --- | --- |
| A | End-to-end Scout order: search → menu → variant+addon → coupon → place → track |
| B | Deep menu parsing — "find spicy wings under ₹400" hits Truffles via its menu |
| C | Multi-cart restaurant switch behaves as per docs (flush + new binding) |
| D | ₹1000 cart cap is enforced; `place_food_order` returns `CART_CAP_EXCEEDED` |
| E | Auditor recipe gap analysis + MVQ — onion picks 500g over 1kg |
| F | ₹99 minimum order is enforced; bumps over min unlock checkout |
| G | `your_go_to_items` one-tap reorder |
| H | ±30 min slot flex — Negotiator finds 19:30 / 20:30 when 20:00 is blocked |
| I | Fully-booked Toit → similar-vibes fallback to Toscano / Black Pearl in Indiranagar |
| J | `book_table` non-idempotency — `get_booking_status` recovers on retry |
| K | Voice-contract data hygiene — IDs strippable, prices integer, `*Spoken` digit-free |
| L | Combined "plan my evening" demo flow (PRD §6) |

## Build plan

See `.cursor/plans/kitchen_copilot_mvp_*.plan.md` for the full step-by-step plan. Each step ends in a commit + push. UI styling is handled in four Claude Code handoffs interleaved between steps.

| Step | What lands | Status |
| --- | --- | --- |
| 1 | Bootstrap + GitHub | ✓ |
| 2 | Mock data for 35 tools + 12 PRD scenario tests | ✓ |
| 3 | Tool router (mock) + `/api/tools/[server]/[tool]` HTTP surface | ✓ |
| 4 | OAuth 2.1 + PKCE + real-MCP client behind the router | ✓ |
| 5 | Voice session backend | — |
| 🎨 | VoiceOrb + Canvas chrome | — |
| 6 | Realtime client (WebRTC) | — |
| 7 | Cartesia TTS + AudioWorklet | — |
| 🎨 | RestaurantCard + MenuItemCard | — |
| 8 | Agent modules (Scout/Auditor/Negotiator) | — |
| 🎨 | Remaining cards | — |
| 9 | Safety rails | — |
| 🎨 | ConfirmationSheet | — |
| 10 | End-to-end rehearsal + v0.1.0 tag | — |

## Repo layout

```
app/                     Next.js routes + API
  api/voice/session/     Ephemeral OpenAI Realtime token mint
  api/tools/[server]/    Tool router endpoint
  api/auth/swiggy/       OAuth 2.1 + PKCE flow
components/
  cards/                 Agentic UI cards (restaurant, cart, reservation, ...)
  voice/                 VoiceOrb, TranscriptStream
lib/
  voice/                 Realtime client, Cartesia TTS, audio worklet
  mcp/                   Tool router, MCP client, retry, idempotency, auth
  mock/                  Mock implementations of 35 Swiggy tools
data/mock/               JSON fixtures for mock tool responses
agent/                   Intent gateway + Scout/Auditor/Negotiator modules
docs/                    PRD + reference notes
```

## References

- [Product PRD](docs/Kitchen_Copilot_Full_Detailed_PRD.md)
- [Swiggy Builders Club docs](https://mcp.swiggy.com/builders/docs/)
- [Swiggy MCP tools index](https://mcp.swiggy.com/builders/llms.txt)
