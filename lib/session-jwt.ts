/**
 * Tiny HS256 JWT implementation shared by the Next.js app and the ws-server.
 *
 * We use it to pass authenticated-session credentials from the Next.js SSR
 * layer (which owns the NextAuth session) onto the WebSocket channel (which
 * runs in a separate process and cannot read NextAuth cookies directly).
 *
 * The flow:
 *   1. `/doc/[id]/page.tsx` confirms the caller's session and their access
 *      role for this document.
 *   2. It mints a short-lived session token (~10 min) containing {sub, doc,
 *      role, exp} signed with the shared `WS_SESSION_SECRET`.
 *   3. The token is passed into `DocClient`, which appends it as a query
 *      parameter on the WS URL.
 *   4. ws-server verifies the HMAC, confirms the doc matches, and grants the
 *      connection the claimed role.
 *
 * We hand-roll this rather than pull in `jsonwebtoken` to keep the ws-server
 * bundle small and avoid dependency drift between the two processes. HS256
 * with a constant-time compare is sufficient for a short-lived server-to-
 * server assertion — we're not minting user-facing auth tokens.
 */
import crypto from "crypto";

/** Access levels carried in session tokens. */
export type SessionRole = "owner" | "editor" | "commenter" | "viewer";

export interface SessionClaims {
  /** Subject — user email, or `__bridge__` for internal REST bridge traffic. */
  sub: string;
  /** Document id the token is scoped to. Rejected if WS path disagrees. */
  doc: string;
  role: SessionRole;
  /** Unix seconds expiry. */
  exp: number;
}

function b64urlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function hmacB64(secret: string, data: string): string {
  return b64urlEncode(crypto.createHmac("sha256", secret).update(data).digest());
}

// Pre-computed header — constant across every token we mint.
const HEADER = b64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));

/**
 * Mint a signed session token. `ttlSeconds` defaults to 10 min — long enough
 * for a page load + a few reconnects, short enough that a leaked token from
 * the browser network tab isn't interesting to an attacker.
 */
export function mintSessionToken(
  claims: Omit<SessionClaims, "exp"> & { exp?: number },
  secret: string,
  ttlSeconds: number = 600
): string {
  if (!secret) throw new Error("mintSessionToken: secret is empty");
  const payload: SessionClaims = {
    sub: claims.sub,
    doc: claims.doc,
    role: claims.role,
    exp: claims.exp ?? Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = hmacB64(secret, `${HEADER}.${body}`);
  return `${HEADER}.${body}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: SessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "no_secret" };

/**
 * Verify + decode a token. Returns the claims or a structured failure so the
 * caller can distinguish "misconfigured server" (no_secret) from "bogus token".
 */
export function verifySessionToken(token: string, secret: string): VerifyResult {
  if (!secret) return { ok: false, reason: "no_secret" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, body, sig] = parts;
  if (h !== HEADER) return { ok: false, reason: "malformed" };

  const expected = hmacB64(secret, `${h}.${body}`);
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return { ok: false, reason: "bad_signature" };
  if (!crypto.timingSafeEqual(expectedBuf, sigBuf)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: SessionClaims;
  try {
    claims = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.sub !== "string" ||
    typeof claims.doc !== "string" ||
    typeof claims.role !== "string" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/** Sentinel subject used by the REST bridge (`lib/yjs-api-bridge.ts`) when it
 *  needs to write into a Yjs document on behalf of a checked-elsewhere caller.
 *  The bridge itself has no session — it's the Next.js route handler calling
 *  it that does the auth check. ws-server trusts this subject unconditionally,
 *  so the token must only ever be minted from server-side code. */
export const BRIDGE_SUBJECT = "__bridge__";
