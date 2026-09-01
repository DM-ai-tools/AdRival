export const SESSION_COOKIE = "adrival_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 24 * 7;

export function isAuthEnabled(): boolean {
  return Boolean(process.env.LOGIN_PASSWORD?.trim());
}

function sessionSecret(): string {
  return (
    process.env.SESSION_SECRET?.trim() ||
    process.env.LOGIN_PASSWORD?.trim() ||
    ""
  );
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

export async function createSessionToken(): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SEC;
  const payloadB64 = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ exp })),
  );
  const sig = await hmacSign(payloadB64, sessionSecret());
  return `${payloadB64}.${sig}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
): Promise<boolean> {
  if (!isAuthEnabled()) return true;
  if (!token) return false;

  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return false;

  const expected = await hmacSign(payloadB64, sessionSecret());
  if (sig !== expected) return false;

  try {
    const json = JSON.parse(base64UrlDecode(payloadB64)) as { exp?: number };
    if (!json.exp || json.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

export function verifyLoginPassword(password: string): boolean {
  const expected = process.env.LOGIN_PASSWORD?.trim();
  if (!expected) return true;
  return password === expected;
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
