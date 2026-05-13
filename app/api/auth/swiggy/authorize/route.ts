// GET /api/auth/swiggy/authorize?returnTo=/some/path
//
// Kicks off the OAuth 2.1 + PKCE flow:
//   1. Generate PKCE verifier + challenge + CSRF state
//   2. Stash verifier + state + returnTo in a short-lived HttpOnly cookie
//   3. 302 the user to https://mcp.swiggy.com/auth/authorize

import { NextResponse } from "next/server";
import {
  PKCE_COOKIE,
  buildAuthorizeUrl,
  getOAuthConfig,
} from "../../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let cfg;
  try {
    cfg = getOAuthConfig();
  } catch (e) {
    const message = e instanceof Error ? e.message : "OAuth config missing";
    return NextResponse.json(
      { success: false, error: { code: "OAUTH_NOT_CONFIGURED", message } },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/";

  const { url: authorizeUrl, pkce } = buildAuthorizeUrl({
    clientId: cfg.clientId,
    redirectUri: cfg.redirectUri,
    returnTo,
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(PKCE_COOKIE, JSON.stringify(pkce), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 min — only needs to survive the user→Swiggy→back roundtrip
  });
  return res;
}
