<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version (Next 16+) has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Project — Kitchen Copilot

Voice-first AI agent that wires OpenAI Realtime + Cartesia Sonic-2 TTS to the three Swiggy MCP servers (Food, Instamart, Dineout).

## External docs — Swiggy Builders Club

When writing code against Swiggy MCP, consult the authoritative docs:

- Index:     https://mcp.swiggy.com/builders/llms.txt
- Full text: https://mcp.swiggy.com/builders/llms-full.txt
- Per-page:  append `.md` to any https://mcp.swiggy.com/builders/docs/... URL

Tool schemas live under `/docs/reference/{food,instamart,dineout}`. Error codes at `/docs/reference/errors`. Auth at `/docs/start/authenticate`.

**Never invent tool names or parameters.** If the docs don't cover it, ask.

## Build plan

See [docs/Kitchen_Copilot_Full_Detailed_PRD.md](docs/Kitchen_Copilot_Full_Detailed_PRD.md) for the product spec and the matching plan in `.cursor/plans/`.

## Where the product actually lives

**The system prompt is the product.** Mocks, the tool router, and the voice plumbing are scaffolding — replaceable, finite, well-specified by the docs. The thing that turns 35 generic Swiggy tools into "Kitchen Copilot" is the system prompt fed to the OpenAI Realtime brain (and the per-module sub-prompts under `agent/modules/`).

Implications for how we work:

- **Don't try to encode behavior in mock fixtures.** User flows are infinite; we can't mock our way to coverage. Mocks only need to prove the data is *shaped* correctly for the agent to reason about. The PRD scenario tests in `scripts/scenarios.ts` are the floor for that, not a ceiling to expand.
- **Edge cases live in the system prompt.** Multi-cart warnings, ±30 min slot flex, MVQ selection, similar-vibes fallback — these are prompt-level rules ("when X, do Y"), not mock-data conditionals. Code-side we only enforce *hard rails* the docs require (cart caps, min order, non-idempotency, voice-contract sanitization).
- **When you change a tool's response shape, update the prompt.** The prompt teaches the model what fields to read and how. Drift here is silent breakage.
- **Prompts live under version control alongside code.** `agent/prompts/*.md` is the source of truth — never edit only in console / playground.

## Voice contract (from Swiggy docs)

When writing system prompts or response shaping:

- **Max 3 items** in any list spoken aloud.
- **Never read IDs** (`addressId`, `spinId`, `restaurantId`) — filter from TTS input.
- **Prices spoken naturally**: "₹249" → "two hundred and forty-nine rupees".
- **Always confirm before mutation** (`place_food_order`, `checkout`, `book_table`).
- **Default to user's saved Home address** unless they specified otherwise.
- Prefer `deliveryTimeSpoken` over `deliveryTimeRange` for voice.

## Safety rails

- `place_food_order` / `checkout` / `book_table` are **non-idempotent**. Use check-then-retry via `lib/mcp/idempotency.ts`.
- `LIVE_MUTATIONS=false` blocks those 3 tools even in real mode.
- Tokens only in HttpOnly cookies — never localStorage, never logs.
- ₹1000 Food cart cap, ₹99 Instamart minimum.
