// POST /api/voice/session
//
// Mints an ephemeral OpenAI Realtime client secret. The master OPENAI_API_KEY
// stays server-side — the browser only ever sees the short-lived
// `value` returned here, which it uses to connect via WebRTC (Step 6).
//
// Targets the GA endpoint:
//   https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/

import { NextResponse } from "next/server";
import { buildSessionConfig } from "../../../../lib/voice/session-config";

export const dynamic = "force-dynamic";

const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";

export async function POST() {
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

  let config;
  try {
    config = buildSessionConfig();
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
