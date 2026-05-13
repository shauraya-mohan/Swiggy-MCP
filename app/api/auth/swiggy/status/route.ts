// GET /api/auth/swiggy/status
//
// Returns the current auth state for the UI to decide whether to show a
// "Sign in to Swiggy" affordance. Never returns the access token itself —
// only whether one exists and when it expires.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, type AuthState } from "../../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

interface StatusResponse {
  authenticated: boolean;
  expiresAt?: number;
  expiresInSec?: number;
  scope?: string;
  mode: "mock" | "real";
}

export async function GET() {
  const mode: StatusResponse["mode"] =
    (process.env.SWIGGY_MODE ?? "mock") === "real" ? "real" : "mock";

  const cookieStore = await cookies();
  const raw = cookieStore.get(AUTH_COOKIE)?.value;
  if (!raw) {
    return NextResponse.json<StatusResponse>({ authenticated: false, mode });
  }

  try {
    const parsed = JSON.parse(raw) as AuthState;
    const now = Math.floor(Date.now() / 1000);
    if (!parsed.accessToken || parsed.expiresAt <= now) {
      return NextResponse.json<StatusResponse>({ authenticated: false, mode });
    }
    return NextResponse.json<StatusResponse>({
      authenticated: true,
      expiresAt: parsed.expiresAt,
      expiresInSec: parsed.expiresAt - now,
      scope: parsed.scope,
      mode,
    });
  } catch {
    return NextResponse.json<StatusResponse>({ authenticated: false, mode });
  }
}
