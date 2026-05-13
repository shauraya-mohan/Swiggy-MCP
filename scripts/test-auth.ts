#!/usr/bin/env tsx
// OAuth + real-MCP-client offline tests.
//
// We can't hit live Swiggy without credentials, but we can prove:
//   1. PKCE math is correct (verifier → S256 challenge round-trip).
//   2. The authorize URL we'd send is well-formed per Swiggy docs.
//   3. The router correctly demands an access token in real mode.
//   4. The real-MCP client wraps fetch() correctly: emits a proper JSON-RPC
//      envelope, maps 401 to UNAUTHENTICATED, maps tool errors, etc.
//
// We stub `fetch` for (4) — no network egress required.
//
// Run: `npm run test:auth`

import crypto from "node:crypto";
import {
  buildAuthorizeUrl,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
  isExpiringSoon,
  SWIGGY_AUTHORIZE_URL,
  SWIGGY_SCOPES,
} from "../lib/mcp/auth";
import { callRealTool } from "../lib/mcp/client";
import { callTool } from "../lib/mcp/router";

const G = "\x1b[32m";
const R = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const X = "\x1b[0m";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, name: string, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ${G}\u2713${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ${R}\u2717${X} ${name}${detail ? ` ${D}\u2014 ${detail}${X}` : ""}`);
  }
}

function section(t: string): void {
  console.log(`\n${Y}${t}${X}`);
}

// ---- fetch stub for the MCP client ---------------------------------------

interface StubResponse {
  status?: number;
  body: unknown;
  contentType?: string;
}

let stubResponses: StubResponse[] = [];
const originalFetch = globalThis.fetch;

function stubFetch(responses: StubResponse[]): void {
  stubResponses = [...responses];
  globalThis.fetch = (async (_input, _init) => {
    const next = stubResponses.shift();
    if (!next) throw new Error("stubFetch: ran out of stubbed responses");
    const body =
      typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, {
      status: next.status ?? 200,
      headers: { "Content-Type": next.contentType ?? "application/json" },
    });
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

async function main() {
  console.log("\nKitchen Copilot auth + real-MCP-client tests");
  console.log(`${D}validates PKCE math, authorize URL, router gating, JSON-RPC wrapping${X}`);

  // -----------------------------------------------------------------------
  // 1. PKCE math
  // -----------------------------------------------------------------------
  section("PKCE math");

  const verifier = generateCodeVerifier();
  assert(/^[A-Za-z0-9_-]+$/.test(verifier), "verifier is base64url (no padding)");
  assert(verifier.length >= 43 && verifier.length <= 128, "verifier length within RFC 7636 bounds", `${verifier.length}`);

  const challenge = deriveCodeChallenge(verifier);
  // Recompute by hand and compare — proves the helper matches what Swiggy will recompute server-side.
  const handDerived = crypto.createHash("sha256").update(verifier).digest("base64url");
  assert(challenge === handDerived, "challenge matches sha256(verifier) base64url");
  assert(/^[A-Za-z0-9_-]{43}$/.test(challenge), "challenge is 43-char base64url");

  const state = generateState();
  assert(state.length >= 16, "state is at least 16 chars");
  assert(generateState() !== state, "state is unique per call");

  // -----------------------------------------------------------------------
  // 2. Authorize URL shape
  // -----------------------------------------------------------------------
  section("Authorize URL");

  const { url, pkce } = buildAuthorizeUrl({
    clientId: "test_client_123",
    redirectUri: "http://localhost:3000/api/auth/swiggy/callback",
    returnTo: "/voice",
  });

  assert(url.startsWith(SWIGGY_AUTHORIZE_URL + "?"), "URL points at Swiggy /auth/authorize");
  const params = new URL(url).searchParams;
  assert(params.get("response_type") === "code", "response_type=code");
  assert(params.get("client_id") === "test_client_123", "client_id round-trips");
  assert(params.get("code_challenge_method") === "S256", "code_challenge_method=S256");
  assert(params.get("code_challenge") === deriveCodeChallenge(pkce.verifier), "code_challenge derived from cookie verifier");
  assert(params.get("state") === pkce.state, "state matches cookie value (CSRF)");
  assert(params.get("scope") === SWIGGY_SCOPES, "scope is mcp:tools mcp:resources mcp:prompts");
  assert(pkce.returnTo === "/voice", "returnTo round-trips for post-auth redirect");

  // -----------------------------------------------------------------------
  // 3. Token-expiry helper
  // -----------------------------------------------------------------------
  section("Token-expiry helper");

  const now = Math.floor(Date.now() / 1000);
  assert(
    isExpiringSoon({ accessToken: "x", expiresAt: now + 30, scope: SWIGGY_SCOPES }, now),
    "30s remaining → expiring soon",
  );
  assert(
    !isExpiringSoon({ accessToken: "x", expiresAt: now + 600, scope: SWIGGY_SCOPES }, now),
    "10min remaining → not expiring soon",
  );

  // -----------------------------------------------------------------------
  // 4. Router gating in real mode
  // -----------------------------------------------------------------------
  section("Router gating in real mode");

  const noToken = await callTool(
    { server: "food", tool: "get_addresses", args: {} },
    { mode: "real" },
  );
  assert(!noToken.success, "real mode without a token is rejected");
  if (!noToken.success) {
    assert(noToken.error.code === "UNAUTHENTICATED", "uses UNAUTHENTICATED code", noToken.error.code);
  }

  // -----------------------------------------------------------------------
  // 5. Real MCP client — JSON-RPC envelope + happy path
  // -----------------------------------------------------------------------
  section("Real MCP client wire format");

  let lastUrl = "";
  let lastInit: RequestInit | undefined;
  globalThis.fetch = (async (input, init) => {
    lastUrl = typeof input === "string" ? input : (input as Request).url;
    lastInit = init;
    // First call = initialize, second = tools/call. Both return valid JSON-RPC.
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          structuredContent: { addresses: [{ id: "addr_X", label: "Home" }] },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const happy = await callRealTool({
    server: "food",
    tool: "get_addresses",
    args: {},
    accessToken: "tok_abc",
  });
  assert(happy.success, "happy path returns success envelope");
  if (happy.success) {
    const data = happy.data as { addresses: Array<{ id: string }> };
    assert(data.addresses?.[0]?.id === "addr_X", "structuredContent is unwrapped from MCP envelope");
  }
  assert(lastUrl === "https://mcp.swiggy.com/food", "URL targets the right server", lastUrl);
  const sentHeaders = (lastInit?.headers ?? {}) as Record<string, string>;
  assert(sentHeaders.Authorization === "Bearer tok_abc", "Authorization: Bearer <token> is sent");
  assert(sentHeaders["Content-Type"] === "application/json", "Content-Type is application/json");
  const sentBody = JSON.parse((lastInit?.body as string) ?? "{}");
  assert(sentBody.jsonrpc === "2.0", "body is JSON-RPC 2.0");
  assert(sentBody.method === "tools/call", "method is tools/call");
  assert(sentBody.params?.name === "get_addresses", "params.name is the tool name");

  // -----------------------------------------------------------------------
  // 6. Real MCP client — 401 maps to UNAUTHENTICATED
  // -----------------------------------------------------------------------
  section("Real MCP client error mapping");

  stubFetch([
    { status: 401, body: { error: "Token expired" } },
  ]);
  const unauth = await callRealTool({
    server: "food",
    tool: "get_addresses",
    args: {},
    accessToken: "tok_dead",
  });
  assert(!unauth.success, "401 surfaces as a failed envelope");
  if (!unauth.success) {
    assert(unauth.error.code === "UNAUTHENTICATED", "401 → UNAUTHENTICATED", unauth.error.code);
  }

  // tool-level isError content block → TOOL_ERROR
  let toolErrCallCount = 0;
  globalThis.fetch = (async (_input, init) => {
    toolErrCallCount++;
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          isError: true,
          content: [{ type: "text", text: "Cart is empty" }],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const toolErr = await callRealTool({
    server: "food",
    tool: "place_food_order",
    args: { addressId: "addr_X" },
    accessToken: "tok_ok",
  });
  assert(!toolErr.success, "tool-level isError → failed envelope");
  if (!toolErr.success) {
    assert(toolErr.error.code === "TOOL_ERROR", "uses TOOL_ERROR code");
    assert(toolErr.error.message.includes("empty"), "preserves tool's error message");
  }
  assert(toolErrCallCount === 2, "client did initialize then tools/call", `${toolErrCallCount} calls`);

  // SSE response → still parsed
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (body.method === "initialize") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Simulate SSE — a notification then the final result.
    const sse =
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"value":0.5}}\n\n` +
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: { structuredContent: { ok: true } },
      })}\n\n`;
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;

  const sseHappy = await callRealTool({
    server: "im",
    tool: "your_go_to_items",
    args: { addressId: "addr_X" },
    accessToken: "tok_ok",
  });
  assert(sseHappy.success, "SSE response is parsed and unwrapped");

  restoreFetch();

  // -----------------------------------------------------------------------
  console.log("");
  if (failed === 0) {
    console.log(`${G}\u2713 ${passed} assertions across 6 auth-layer checks all green.${X}\n`);
    process.exit(0);
  } else {
    console.log(`${R}\u2717 ${failed} of ${passed + failed} assertions failed:${X}`);
    for (const f of failures) console.log(`  - ${f}`);
    console.log("");
    process.exit(1);
  }
}

main().catch((e) => {
  restoreFetch();
  console.error(e);
  process.exit(1);
});
