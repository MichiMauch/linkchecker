/**
 * Minimal shared-password gate. No users, no provider, no DB.
 *
 * - Auth is ON only when DASHBOARD_PASSWORD is set (local dev stays open).
 * - The session cookie holds an HMAC token derived from a server-only secret,
 *   so it can't be forged. The password is only used at login to issue it.
 *
 * Pure Web Crypto so it works in both the Edge middleware and Node actions.
 */

export const COOKIE_NAME = "lc_auth";

export function authEnabled(): boolean {
  return !!process.env.DASHBOARD_PASSWORD;
}

function secret(): string {
  return process.env.AUTH_SECRET || process.env.DASHBOARD_PASSWORD || "insecure-dev-secret";
}

async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The value a valid session cookie must contain. */
export function sessionToken(): Promise<string> {
  return hmacHex(secret(), "lc-auth-v1");
}

/** Constant-time string comparison (avoids password timing leaks). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
