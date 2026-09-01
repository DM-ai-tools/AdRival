import { NextResponse } from "next/server";
import {
  createSessionToken,
  isAuthEnabled,
  sessionCookieOptions,
  SESSION_COOKIE,
  verifyLoginPassword,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ ok: true, authDisabled: true });
  }

  let body: { password?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const password = String(body.password ?? "");
  if (!password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  if (!verifyLoginPassword(password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await createSessionToken();
  const secure =
    process.env.NODE_ENV === "production" ||
    request.url.startsWith("https://");

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(secure));
  return res;
}
