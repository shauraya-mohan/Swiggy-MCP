// GET /api/auth/swiggy/callback?code=...&state=...
//
// Handles the redirect from https://mcp.swiggy.com/auth/authorize. Verifies
// CSRF state matches the cookie-stashed value, exchanges the code for an
// access token, then writes the token into a long-lived HttpOnly cookie
// and redirects the user back to wherever they came from.

import { NextResponse } from "next/server";
import {
  AUTH_COOKIE,
  PKCE_COOKIE,
  exchangeCodeForToken,
  getOAuthConfig,
  type AuthState,
  type PkceState,
} from "../../../../../lib/mcp/auth";

export const dynamic = "force-dynamic";

function fail(message: string, status = 400) {
  return NextResponse.json(
    { success: false, error: { code: "OAUTH_CALLBACK_FAILED", message } },
    { status },
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return fail(`Swiggy denied authorization: ${oauthError}`, 400);
  }
  if (!code || !state) {
    return fail("Missing code or state on callback URL.");
  }

  let cfg;
  try {
    cfg = getOAuthConfig();
  } catch (e) {
    return fail(e instanceof Error ? e.message : "OAuth config missing", 503);
  }

  const pkceCookie = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE}=`))
    ?.slice(PKCE_COOKIE.length + 1);

  if (!pkceCookie) return fail("PKCE cookie missing or expired. Restart the flow.");

  let pkce: PkceState;
  try {
    pkce = JSON.parse(decodeURIComponent(pkceCookie)) as PkceState;
  } catch {
    return fail("PKCE cookie is malformed. Restart the flow.");
  }

  if (pkce.state !== state) {
    return fail("CSRF state mismatch. Restart the flow.");
  }

  let auth: AuthState;
  try {
    auth = await exchangeCodeForToken({
      code,
      verifier: pkce.verifier,
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Token exchange failed", 502);
  }

  const returnTo = pkce.returnTo && pkce.returnTo.startsWith("/") ? pkce.returnTo : "/";
  const res = NextResponse.redirect(new URL(returnTo, req.url));

  // Set the long-lived auth cookie. maxAge tracks the token's actual lifetime.
  const maxAge = Math.max(60, auth.expiresAt - Math.floor(Date.now() / 1000));
  res.cookies.set(AUTH_COOKIE, JSON.stringify(auth), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge,
  });

  // PKCE cookie has done its job — burn it.
  res.cookies.set(PKCE_COOKIE, "", { path: "/", maxAge: 0 });

  return res;
}
