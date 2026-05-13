// POST /api/auth/swiggy/logout
//
// Best-effort server-side revocation, then clear local cookies regardless.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  PKCE_COOKIE,
  revokeToken,
  type AuthState,
} from "../../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(AUTH_COOKIE)?.value;

  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AuthState;
      if (parsed.accessToken) await revokeToken(parsed.accessToken);
    } catch {
      /* malformed cookie — nothing to revoke */
    }
  }

  const res = NextResponse.json({ success: true, data: { signedOut: true } });
  res.cookies.set(AUTH_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(PKCE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
