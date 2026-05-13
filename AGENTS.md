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
