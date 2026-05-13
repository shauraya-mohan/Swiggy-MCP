// Minimal streamable-HTTP MCP client for Swiggy.
//
// Real Swiggy MCP is at:
//   POST https://mcp.swiggy.com/{food,im,dineout}
//   Headers: Authorization: Bearer <access_token>
//   Body:    JSON-RPC 2.0 envelope
//
// We use JSON-RPC over HTTP (sync response). We *do not* persist a long-lived
// session — every tool call is initialize → tools/call → done. This trades
// some latency for stateless API-route ergonomics (no shared connection
// pool to maintain across Lambda/Edge cold starts).
//
// Optimization for later: cache `initialize` results per `accessToken` in a
// module-level Map with TTL. Or pull `@modelcontextprotocol/sdk` if/when
// streaming notifications matter.

import { err, ok } from "../mock/helpers";
import type { SwiggyResponse } from "../mock/types";
import type { ToolServer } from "./manifest";

const SWIGGY_MCP_BASE = "https://mcp.swiggy.com";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "kitchen-copilot", version: "0.1.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number;
  result: unknown;
}
interface JsonRpcError {
  jsonrpc: "2.0";
  id: number;
  error: { code: number; message: string; data?: unknown };
}
type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

interface ToolsCallResult {
  /** Per MCP spec — content blocks; for Swiggy these are JSON text blocks. */
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  /**
   * Swiggy also returns the raw payload as `structuredContent` for clients
   * that prefer typed data over a content-blocks array. We prefer this when
   * present, fall back to parsing content[0].text otherwise.
   */
  structuredContent?: unknown;
}

let nextRpcId = 1;
function rpc(method: string, params?: Record<string, unknown>): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextRpcId++, method, params };
}

async function postJsonRpc(args: {
  server: ToolServer;
  accessToken: string;
  body: JsonRpcRequest;
}): Promise<JsonRpcResponse> {
  const res = await fetch(`${SWIGGY_MCP_BASE}/${args.server}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${args.accessToken}`,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify(args.body),
  });

  if (res.status === 401) {
    const err401 = new Error("Swiggy MCP rejected token (401). Re-run authorization.") as Error & { status?: number };
    err401.status = 401;
    throw err401;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Swiggy MCP ${args.server} returned ${res.status}: ${text || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    // Streamable HTTP: server may stream notifications then end with a `data:`
    // line carrying the JSON-RPC response. We accept the *last* JSON-RPC
    // response we see, matching the request id, and ignore intermediate
    // notifications (they carry no `id`).
    const text = await res.text();
    return parseSseForJsonRpc(text, args.body.id);
  }

  return (await res.json()) as JsonRpcResponse;
}

function parseSseForJsonRpc(sse: string, expectedId: number): JsonRpcResponse {
  const lines = sse.split(/\r?\n/);
  let last: JsonRpcResponse | null = null;
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.id === expectedId) last = parsed;
    } catch {
      // ignore malformed lines
    }
  }
  if (!last) throw new Error("Swiggy MCP SSE stream ended without a JSON-RPC response for our id.");
  return last;
}

// ---- MCP handshakes ------------------------------------------------------

async function initialize(server: ToolServer, accessToken: string): Promise<void> {
  const resp = await postJsonRpc({
    server,
    accessToken,
    body: rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }),
  });
  if ("error" in resp) {
    throw new Error(`Swiggy MCP ${server} initialize failed: ${resp.error.message}`);
  }
}

/**
 * Call a Swiggy MCP tool over the wire.
 *
 * Returns the standard SwiggyResponse<T> envelope so the router can hand
 * the result back to the agent without knowing whether it came from the
 * mock layer or live Swiggy. Maps wire-level errors (401, 5xx, tool errors)
 * onto envelope error codes that callers can branch on.
 */
export async function callRealTool<T = unknown>(args: {
  server: ToolServer;
  tool: string;
  args: Record<string, unknown>;
  accessToken: string;
}): Promise<SwiggyResponse<T>> {
  try {
    await initialize(args.server, args.accessToken);

    const resp = await postJsonRpc({
      server: args.server,
      accessToken: args.accessToken,
      body: rpc("tools/call", {
        name: args.tool,
        arguments: args.args,
      }),
    });

    if ("error" in resp) {
      return err(resp.error.message, mapJsonRpcErrorCode(resp.error.code));
    }

    const result = resp.result as ToolsCallResult;
    if (result.isError) {
      const message = result.content?.[0]?.text ?? "Tool reported an error.";
      return err(message, "TOOL_ERROR");
    }

    // Prefer structured content when the server provides it; otherwise parse
    // the first text block as JSON. Swiggy's docs say tools return JSON.
    if (result.structuredContent !== undefined) {
      return ok(result.structuredContent as T);
    }
    const text = result.content?.find((c) => c.type === "text")?.text;
    if (!text) return ok({} as T);
    try {
      return ok(JSON.parse(text) as T);
    } catch {
      // Some tools return plain-text status messages — surface as-is.
      return ok(text as unknown as T);
    }
  } catch (e) {
    const status = (e as { status?: number }).status;
    const message = e instanceof Error ? e.message : "Unknown error";
    if (status === 401) return err(message, "UNAUTHENTICATED");
    return err(message, "MCP_TRANSPORT_ERROR");
  }
}

/**
 * Map JSON-RPC error codes to our envelope's error.code.
 *
 *   -32001  →  UNAUTHENTICATED  (Swiggy uses this for auth/session issues)
 *   -32602  →  INVALID_ARGUMENT (bad params)
 *   -32603  →  INTERNAL_ERROR
 *   else    →  MCP_ERROR
 */
function mapJsonRpcErrorCode(code: number): string {
  switch (code) {
    case -32001:
      return "UNAUTHENTICATED";
    case -32602:
      return "INVALID_ARGUMENT";
    case -32603:
      return "INTERNAL_ERROR";
    default:
      return "MCP_ERROR";
  }
}
