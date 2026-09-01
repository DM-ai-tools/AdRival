import type { AppUserPublic } from "../types";

export const SESSION_COOKIE = "adrival_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

export interface SessionPayload {
  sub: string;
  username: string;
  displayName: string;
  exp: number;
}

function sessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "development") {
    return "dev-insecure-session-secret-change-me";
  }
  throw new Error("SESSION_SECRET is not configured");
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return atob(padded + pad);
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return base64UrlEncode(new Uint8Array(sig));
}

export async function createSessionToken(user: AppUserPublic): Promise<string> {
  const payload: SessionPayload = {
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC,
  };
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const sig = await hmacSign(payloadB64, sessionSecret());
  return `${payloadB64}.${sig}`;
}

export async function parseSessionToken(
  token: string | undefined | null,
): Promise<SessionPayload | null> {
  if (!token) return null;

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;

  let secret: string;
  try {
    secret = sessionSecret();
  } catch {
    return null;
  }

  const expected = await hmacSign(payloadB64, secret);
  if (sig !== expected) return null;

  try {
    const json = JSON.parse(base64UrlDecode(payloadB64)) as SessionPayload;
    if (!json.sub || !json.exp || json.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return json;
  } catch {
    return null;
  }
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  return (await parseSessionToken(token)) !== null;
}

export function sessionCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  };
}

export function isSecureRequest(request: Request): boolean {
  return (
    process.env.NODE_ENV === "production" || request.url.startsWith("https://")
  );
}
