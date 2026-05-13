// Thin HTTP wrapper around lib/mcp/router.
//
// POST /api/tools/{server}/{tool}
//   Body: JSON args object
//   Returns: SwiggyResponse<T> envelope as JSON, HTTP 200 on success,
//   HTTP 400 on validation errors so curl-based testing is intuitive.
//
// The real consumer of this endpoint is the OpenAI Realtime client which
// receives a `tool_call` event, posts the args here, and feeds the result
// back into the session via a `tool_call_output` event.

import { NextResponse } from "next/server";
import { callTool } from "../../../../../lib/mcp/router";
import type { ToolServer } from "../../../../../lib/mcp/manifest";

interface RouteParams {
  params: Promise<{ server: string; tool: string }>;
}

const ALLOWED_SERVERS: ToolServer[] = ["food", "im", "dineout"];

export async function POST(req: Request, { params }: RouteParams) {
  const { server, tool } = await params;

  if (!ALLOWED_SERVERS.includes(server as ToolServer)) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "UNKNOWN_SERVER", message: `Unknown server: ${server}` },
      },
      { status: 400 },
    );
  }

  let args: Record<string, unknown> = {};
  if (req.body) {
    try {
      const raw = await req.text();
      if (raw.length > 0) args = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: "INVALID_JSON", message: "Request body must be valid JSON or empty." },
        },
        { status: 400 },
      );
    }
  }

  const result = await callTool({ server: server as ToolServer, tool, args });

  // Validation / kill-switch errors deserve a 4xx so curl shows red.
  // Tool-internal errors (e.g. CART_CAP_EXCEEDED) stay 200 because the
  // envelope itself communicates them — that's the docs' contract.
  if (!result.success) {
    const code = result.error.code ?? "";
    const status = ["UNKNOWN_TOOL", "UNKNOWN_SERVER", "MISSING_PARAMETER"].includes(code)
      ? 400
      : code === "DEMO_MODE_BLOCKED"
        ? 403
        : 200;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
