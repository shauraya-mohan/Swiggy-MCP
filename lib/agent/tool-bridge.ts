/**
 * tool-bridge — relays OpenAI Realtime function calls to our /api/tools
 * HTTP surface and returns the JSON result.
 *
 * Flow:
 *   1. Model emits `response.function_call_arguments.done` with handle like
 *      `food__search_restaurants` and a JSON-string arguments payload.
 *   2. We parse the handle back into `{server, tool}`, POST args to
 *      /api/tools/[server]/[tool], and return the raw SwiggyResponse.
 *   3. live-provider wraps that result in a `conversation.item.create`
 *      function_call_output event and pushes it back over the data channel,
 *      then sends `response.create` to let the model continue.
 *
 * The bridge intentionally returns the raw envelope (success+data or
 * success=false+error). The model is good at recovering from typed error
 * codes — don't paper over them here.
 */

import { parseToolHandle } from "@/lib/mcp/router";

export interface ToolBridgeResult {
  /** Always a JSON-serializable payload we can stringify back to the model. */
  body: unknown;
  /** HTTP status. 200 = mock success or wire success; 4xx/5xx mean trouble. */
  status: number;
  /** True when the handle parsed, the fetch succeeded, AND the envelope's success flag is true. */
  ok: boolean;
}

/**
 * Execute an OpenAI tool call. Returns a result the caller can serialize.
 *
 * Never throws — error states travel inside `body` so the model sees a
 * structured envelope and can apologise / retry.
 */
export async function executeToolCall(opts: {
  handle: string;
  argsJson: string;
  fetchImpl?: typeof fetch;
}): Promise<ToolBridgeResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const parsed = parseToolHandle(opts.handle);

  if (!parsed) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: {
          code: "UNKNOWN_TOOL_HANDLE",
          message: `Tool handle '${opts.handle}' did not match the 'server__tool' format.`,
        },
      },
    };
  }

  let args: unknown = {};
  if (opts.argsJson && opts.argsJson.trim().length > 0) {
    try {
      args = JSON.parse(opts.argsJson);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Invalid JSON";
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          error: {
            code: "INVALID_TOOL_ARGS_JSON",
            message: `Couldn't parse arguments for ${opts.handle}: ${message}`,
          },
        },
      };
    }
  }

  const url = `/api/tools/${parsed.server}/${parsed.tool}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    return {
      ok: false,
      status: 502,
      body: {
        success: false,
        error: { code: "TOOL_NETWORK_ERROR", message },
      },
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {
      success: false,
      error: { code: "TOOL_NON_JSON_RESPONSE", message: `HTTP ${res.status}` },
    };
  }

  const envelope = body as { success?: boolean };
  return {
    body,
    status: res.status,
    ok: res.ok && envelope.success === true,
  };
}
