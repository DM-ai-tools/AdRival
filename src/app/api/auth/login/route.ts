import { NextResponse } from "next/server";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { validatePassword, validateUsername } from "@/lib/auth/validation";
import { getUserByUsername, toPublicUser } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { username?: string; password?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const usernameErr = validateUsername(String(body.username ?? ""));
  if (usernameErr) {
    return NextResponse.json({ error: usernameErr }, { status: 400 });
  }
  const passwordErr = validatePassword(String(body.password ?? ""));
  if (passwordErr) {
    return NextResponse.json({ error: passwordErr }, { status: 400 });
  }

  const user = getUserByUsername(String(body.username ?? ""));
  if (!user || !(await verifyPassword(String(body.password ?? ""), user.passwordHash))) {
    return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
  }

  const token = await createSessionToken(toPublicUser(user));
  const res = NextResponse.json({ ok: true, user: toPublicUser(user) });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isSecureRequest(request)));
  return res;
}
