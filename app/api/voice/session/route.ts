// POST /api/voice/session
//
// Mints an ephemeral OpenAI Realtime client secret. The master OPENAI_API_KEY
// stays server-side — the browser only ever sees the short-lived
// `value` returned here, which it uses to connect via WebRTC (Step 6).
//
// Targets the GA endpoint:
//   https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/
//
// Optional query params:
//   ?voice=<voice>  — override the default voice (sage). Validated against
//                     the set defined in lib/voice/session-config.ts. Unknown
//                     or invalid values are silently dropped to the default
//                     rather than 400'd — voice is cosmetic, not load-bearing.

import { NextRequest, NextResponse } from "next/server";
import {
  buildSessionConfig,
  type RealtimeVoice,
} from "../../../../lib/voice/session-config";

export const dynamic = "force-dynamic";

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

// Kept in sync with RealtimeVoice in lib/voice/session-config.ts.
// Centralised here too so the route can validate without importing the
// type system. Drift between the two is caught by scripts/test-voice.ts.
const ALLOWED_VOICES: ReadonlySet<RealtimeVoice> = new Set<RealtimeVoice>([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "OPENAI_NOT_CONFIGURED",
          message: "OPENAI_API_KEY is not set in the environment.",
        },
      },
      { status: 503 },
    );
  }

  // Optional voice override. Silent fallback to default if the value is
  // missing or not one of ALLOWED_VOICES — a typo in the URL shouldn't
  // 400 the session, the user just hears the default.
  const requestedVoice = req.nextUrl.searchParams.get("voice");
  const voice: RealtimeVoice | undefined =
    requestedVoice && ALLOWED_VOICES.has(requestedVoice as RealtimeVoice)
      ? (requestedVoice as RealtimeVoice)
      : undefined;

  let config;
  try {
    config = buildSessionConfig(voice ? { voice } : undefined);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to build session config";
    return NextResponse.json(
      { success: false, error: { code: "CONFIG_BUILD_FAILED", message } },
      { status: 500 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(config),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Network error";
    return NextResponse.json(
      { success: false, error: { code: "OPENAI_NETWORK_ERROR", message } },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "OPENAI_SESSION_FAILED",
          message: `OpenAI returned ${upstream.status}: ${body || upstream.statusText}`,
        },
      },
      { status: 502 },
    );
  }

  // GA response shape: { value, expires_at, session: { id, model, ... } }
  const payload = (await upstream.json()) as {
    value: string;
    expires_at: number;
    session: {
      id: string;
      model: string;
      audio?: { output?: { voice?: string } };
    };
  };

  // Return only what the browser needs to open a Realtime WebRTC connection.
  // Never echo the prompt + tools (large, server-side concern).
  return NextResponse.json({
    success: true,
    data: {
      sessionId: payload.session.id,
      model: payload.session.model,
      voice: payload.session.audio?.output?.voice ?? config.session.audio.output.voice,
      clientSecret: payload.value,
      expiresAt: payload.expires_at,
    },
  });
}
