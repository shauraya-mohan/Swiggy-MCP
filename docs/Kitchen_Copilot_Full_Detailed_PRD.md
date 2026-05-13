# Product Requirements Document: Kitchen Copilot
**Version:** 1.0 (MVP)
**Status:** In Development (Localhost/Mock-First)

## 1. Executive Summary
Kitchen Copilot is an AI-agentic commerce platform that serves as a hands-free "Executive Assistant for the Kitchen." By leveraging the **Model Context Protocol (MCP)** and Swiggy’s ecosystem (Food, Instamart, Dineout), it eliminates the mental load of meal planning, ingredient procurement, and dining logistics. 

Unlike standard "recipe apps," Kitchen Copilot is action-oriented: it doesn't just tell you how to cook; it ensures the ingredients are at your door or the table is booked, all via a natural voice interface.

---

## 2. Problem Statement
1. **Decision Fatigue:** "What's for dinner?" is a daily high-friction question.
2. **Context Switching:** Users have to jump between recipes, grocery apps, and delivery apps.
3. **The "Messy Hands" Problem:** Using a touch-screen device while cooking is unhygienic and difficult.
4. **Logistics Friction:** Finding the right quantity of ingredients or negotiating restaurant slots is time-consuming.

---

## 3. Core Functional Requirements

### 3.1. Unified Intent Gateway
At launch, the agent must establish the user's intent to direct resources to the correct Swiggy MCP server:
- **Query:** "Are we cooking tonight, ordering in, or heading out?"
- **Logic:** Branch the LLM context to either Instamart, Food, or Dineout.

### 3.2. Swiggy Food (The "Scout" Module)
- **Deep Menu Parsing:** The agent must not just find restaurants but scan the `menu_items` tool output to match specific user cravings or dietary restrictions (e.g., "Find a place with spicy wings but under ₹400").
- **Cart Consolidation vs. Choice:** - Suggest a "One-Stop Shop" to minimize delivery fees.
    - If the user wants items from multiple places, the agent must explicitly warn about the extra fees but support the multi-cart intent.
- **Visual Feedback:** A non-intrusive, "cool" progress bar with live "Time-to-Delivery" metrics.

### 3.3. Swiggy Instamart (The "Auditor" Module)
- **Ingredient Gap Analysis:** Cross-references recipe requirements with user intent via `search_products`.
- **Minimum Viable Quantity (MVQ) Logic:** - If a user needs a small amount (e.g., 2 onions), the agent searches for the smallest available SKU (e.g., 500g pack).
    - It prioritizes "Best Rated" products based on search results.
- **Confirmation Loop:** Before execution, the agent must verbally read back the list: *"I've added 500g onions and 1L milk. Total is ₹140. Proceed?"* This allows the user to edit via voice.

### 3.4. Swiggy Dineout (The "Negotiator" Module)
- **Slot Negotiation:** If `get_available_slots` returns a conflict for the requested time, the agent must proactively check and suggest windows of ±30 minutes.
- **Similarity Logic:** If a restaurant is fully booked, the agent uses `search_restaurants` to find "similar vibes" nearby with open slots.
- **Reservation Card:** A stylized, shareable UI component generated upon successful `book_table` execution.

---

## 4. Technical Architecture

### 4.1. The 2026 Tech Stack
- **AI Orchestration:** Vercel AI SDK 6 (using `experimental_createMCPClient`).
- **LLM:** Claude 3.5 Sonnet or GPT-4o (required for complex tool-calling/reasoning).
- **Voice Interface:** - **STT:** OpenAI Whisper (optimized for high-noise kitchen environments).
    - **TTS:** Cartesia / ElevenLabs Turbo v2.5 (for low-latency, human-like responses).
- **Frontend:** Next.js with **Framer Motion** for a "Liquid Glass" UI (transparent overlays, morphing containers).

### 4.2. MCP Integration Strategy
- **Servers:** `mcp.swiggy.com/food`, `mcp.swiggy.com/im`, `mcp.swiggy.com/dineout`.
- **Protocol:** Streamable HTTP JSON-RPC.
- **Authentication:** OAuth 2.1 with PKCE (Localhost redirect URI allowed for dev).

---

## 5. Phase 1: The "Mock-First" Development Strategy
**Challenge:** Lack of live Swiggy Developer Client ID during initial build.
**Implementation:**
1. **Local Tool Router:** A proxy service on `localhost` that intercepts MCP calls.
2. **JSON Stubs:** A database of mock responses for 35 tools (e.g., `mock_restaurants.json`, `mock_products.json`).
3. **The "Video Proof" Goal:** The objective is to build a 100% functional "Shadow Version" of the app. Once the voice-to-action flow is proven in a demo video, it will be submitted to `builders@swiggy.in` for production whitelist access.

---

## 6. UI/UX Design Philosophy
- **Agentic UI:** The interface is not a set of buttons; it is a blank canvas that "generates" cards, charts, or menus only when the agent needs to show them to the user.
- **Hands-Free Priority:** Every visual element must be confirmable or dismissible via voice command.
- **Visual Payoff:** Clean, high-contrast typography and subtle animations that give the "cool" feel requested without being "gimmicky."

---

## 7. Future Roadmap
- **Multi-Agent "War Room":** Distinct personas (Chef vs. Foodie) discussing the health/cost trade-offs of an order.
- **Contextual Memory:** Remembering that the user hates cilantro or always orders milk on Mondays.
- **Schedule Orders:** Using background agents to auto-order groceries when stocks are predicted to be low.
