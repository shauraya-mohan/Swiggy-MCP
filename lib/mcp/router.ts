// Unified tool router — the single entry point all agent tool calls go through.
//
// Responsibilities (kept tight on purpose):
//   1. Look up the tool in the manifest. Unknown tools → UNKNOWN_TOOL.
//   2. Validate required parameters are present. Missing → MISSING_PARAMETER.
//   3. Apply the LIVE_MUTATIONS kill-switch on the three non-idempotent tools.
//   4. Dispatch by SWIGGY_MODE:
//        - mock  → callMockTool() in lib/mock
//        - real  → callRealTool() in lib/mcp/client (OAuth'd streamable-HTTP)
//   5. Return a uniform SwiggyResponse envelope.
//
// Anything richer (per-flow rules, multi-tool orchestration, voice-contract
// rewrites) belongs in the agent modules or the system prompt — NOT here.

import { callMockTool } from "../mock";
import type { SwiggyResponse } from "../mock/types";
import { err } from "../mock/helpers";
import { callRealTool } from "./client";
import { findTool, TOOLS, type ToolDef, type ToolServer } from "./manifest";

export type Mode = "mock" | "real";

export interface CallToolInput {
  server: ToolServer;
  tool: string;
  args: Record<string, unknown>;
}

export interface RouterContext {
  /** Override for tests; defaults to SWIGGY_MODE env. */
  mode?: Mode;
  /** Override for tests; defaults to LIVE_MUTATIONS env. */
  liveMutations?: boolean;
  /**
   * Swiggy MCP access token. Required in real mode; ignored in mock mode.
   * Read from the swiggy_auth HttpOnly cookie by the /api/tools route
   * handler, or passed explicitly by server-side callers.
   */
  accessToken?: string;
}

function getMode(ctx?: RouterContext): Mode {
  if (ctx?.mode) return ctx.mode;
  return (process.env.SWIGGY_MODE ?? "mock") === "real" ? "real" : "mock";
}

function getLiveMutations(ctx?: RouterContext): boolean {
  if (ctx?.liveMutations !== undefined) return ctx.liveMutations;
  return process.env.LIVE_MUTATIONS === "true";
}

/** Light validation: confirm required keys exist and aren't null/undefined. */
function validateArgs(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of def.parameters.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null) return key;
  }
  return null;
}

/**
 * Single entry point for every Swiggy MCP tool call the agent makes.
 *
 * Returns the standard `SwiggyResponse<T>` envelope so callers (system-prompt
 * tool handlers, the HTTP route, future telemetry) all see the same shape.
 */
export async function callTool<T = unknown>(
  input: CallToolInput,
  ctx?: RouterContext,
): Promise<SwiggyResponse<T>> {
  const def = findTool(input.server, input.tool);
  if (!def) {
    return err(`Unknown tool: ${input.server}:${input.tool}`, "UNKNOWN_TOOL");
  }

  const missing = validateArgs(def, input.args ?? {});
  if (missing) {
    return err(`Missing required parameter: ${missing}`, "MISSING_PARAMETER");
  }

  const mode = getMode(ctx);

  // Mock mode runs everything — including mutations — against the in-
  // memory store. There's no real money on the line, so the LIVE_MUTATIONS
  // kill-switch doesn't apply here. The user expects "place order" to
  // succeed end-to-end during demos against the mock backend.
  if (mode === "mock") {
    return (await callMockTool(input.server, input.tool, input.args)) as SwiggyResponse<T>;
  }

  // From here on we're in REAL mode — calls hit Swiggy's MCP server,
  // which means real Swiggy carts, real orders, real bookings. The
  // LIVE_MUTATIONS kill-switch gates non-idempotent tools so a
  // misbehaving agent can't accidentally spend the user's money.
  if (def.isMutation && !getLiveMutations(ctx)) {
    return err(
      `Tool '${input.server}:${input.tool}' is blocked by LIVE_MUTATIONS=false. ` +
        "This is a non-idempotent mutation against the real Swiggy MCP — only runs when explicitly enabled.",
      "DEMO_MODE_BLOCKED",
    );
  }

  // Real mode requires an access token from the OAuth flow.
  if (!ctx?.accessToken) {
    return err(
      "Real mode requires a Swiggy access token. Sign in at /api/auth/swiggy/authorize.",
      "UNAUTHENTICATED",
    );
  }

  return await callRealTool<T>({
    server: input.server,
    tool: input.tool,
    args: input.args ?? {},
    accessToken: ctx.accessToken,
  });
}

/**
 * Compact, agent-facing list of tools — pass straight to OpenAI Realtime
 * `session.update` as the `tools` array. Strips internal metadata
 * (`server`, `isMutation`) and namespaces the tool name so dispatch is
 * unambiguous.
 */
export function toolsForOpenAI(): Array<{
  type: "function";
  name: string;
  description: string;
  parameters: ToolDef["parameters"];
}> {
  return TOOLS.map((t) => ({
    type: "function" as const,
    name: `${t.server}__${t.name}`, // dots/colons are disallowed in OpenAI tool names
    description: t.description,
    parameters: t.parameters,
  }));
}

/** Parse an OpenAI-namespaced tool name back into `{server, tool}`. */
export function parseToolHandle(handle: string): { server: ToolServer; tool: string } | null {
  const [server, tool] = handle.split("__");
  if (server !== "food" && server !== "im" && server !== "dineout") return null;
  if (!tool) return null;
  return { server, tool };
}
