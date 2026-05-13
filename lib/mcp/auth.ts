// OAuth 2.1 + PKCE helpers for Swiggy MCP.
//
// Swiggy MCP uses OAuth 2.1 with PKCE S256 (no refresh tokens in v1 — the
// 5-day access token IS the session; re-auth on 401). All state during the
// authorize → callback roundtrip lives in HttpOnly cookies so it can never
// be read from client JS. The access token, once minted, lives in another
// HttpOnly cookie until expiry or logout.
//
// Endpoints (per https://mcp.swiggy.com/builders/docs/start/authenticate.md):
//   GET  /auth/authorize  — kicks off the flow (PKCE S256, scope=mcp:tools)
//   POST /auth/token      — JSON body, grant_type=authorization_code

import crypto from "node:crypto";

export const SWIGGY_BASE = "https://mcp.swiggy.com";
export const SWIGGY_AUTHORIZE_URL = `${SWIGGY_BASE}/auth/authorize`;
export const SWIGGY_TOKEN_URL = `${SWIGGY_BASE}/auth/token`;
export const SWIGGY_LOGOUT_URL = `${SWIGGY_BASE}/auth/logout`;

/** Per docs, v1 scope model is server-level. Request all three. */
export const SWIGGY_SCOPES = "mcp:tools mcp:resources mcp:prompts";

// ---- Cookie names ---------------------------------------------------------
//
// `swiggy_pkce` is short-lived (10 min) — set when authorize starts, cleared
// when the callback succeeds. Holds the code verifier + CSRF state.
//
// `swiggy_auth` is long-lived (matches token expiry) — set on successful
// token exchange. Cleared on logout.
export const PKCE_COOKIE = "swiggy_pkce";
export const AUTH_COOKIE = "swiggy_auth";

// ---- PKCE math -----------------------------------------------------------

/** Generate a 32-byte random code verifier, base64url-encoded (no padding). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Derive the S256 challenge from a verifier (sha256 → base64url, no padding). */
export function deriveCodeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/** CSRF state — small, opaque, single-use. */
export function generateState(): string {
  return crypto.randomBytes(16).toString("base64url");
}

// ---- Auth-flow state -----------------------------------------------------

export interface PkceState {
  verifier: string;
  state: string;
  /** Optional path to return to after successful auth (defaults to "/"). */
  returnTo?: string;
}

export interface AuthState {
  accessToken: string;
  /** Unix seconds. */
  expiresAt: number;
  scope: string;
}

/**
 * Build the authorize URL the user gets redirected to.
 * The returned object also carries the PKCE state we need to round-trip
 * via cookie so callback can finish the exchange.
 */
export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  scope?: string;
  returnTo?: string;
}): { url: string; pkce: PkceState } {
  const verifier = generateCodeVerifier();
  const challenge = deriveCodeChallenge(verifier);
  const state = generateState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: args.scope ?? SWIGGY_SCOPES,
  });

  return {
    url: `${SWIGGY_AUTHORIZE_URL}?${params.toString()}`,
    pkce: { verifier, state, returnTo: args.returnTo },
  };
}

/**
 * Exchange the authorization code for an access token.
 * Per docs: JSON body, NOT form-encoded.
 */
export async function exchangeCodeForToken(args: {
  code: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
}): Promise<AuthState> {
  const res = await fetch(SWIGGY_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: args.code,
      code_verifier: args.verifier,
      client_id: args.clientId,
      redirect_uri: args.redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Swiggy token exchange failed: ${res.status} ${body || res.statusText}`);
  }

  const json = (await res.json()) as {
    access_token: string;
    token_type?: string;
    expires_in: number;
    scope?: string;
  };

  return {
    accessToken: json.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + json.expires_in,
    scope: json.scope ?? SWIGGY_SCOPES,
  };
}

/**
 * Revoke the current session server-side. Best-effort — caller should always
 * also clear local cookies regardless of whether this succeeds.
 */
export async function revokeToken(accessToken: string): Promise<void> {
  try {
    await fetch(SWIGGY_LOGOUT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* swallow — local cookies clear regardless */
  }
}

// ---- Config helpers ------------------------------------------------------

export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
}

/**
 * Read OAuth config from env. Throws with a helpful message if either is
 * missing — used by the API routes to short-circuit cleanly when the user
 * tries to authenticate before applying for credentials.
 */
export function getOAuthConfig(): OAuthConfig {
  const clientId = process.env.SWIGGY_CLIENT_ID;
  const redirectUri = process.env.SWIGGY_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    throw new Error(
      "Swiggy OAuth is not configured. Apply at https://mcp.swiggy.com/access " +
        "and set SWIGGY_CLIENT_ID + SWIGGY_REDIRECT_URI in .env.local.",
    );
  }
  return { clientId, redirectUri };
}

/** Returns true once the access token has fewer than 60 seconds remaining. */
export function isExpiringSoon(state: AuthState, nowSec = Math.floor(Date.now() / 1000)): boolean {
  return state.expiresAt - nowSec < 60;
}
