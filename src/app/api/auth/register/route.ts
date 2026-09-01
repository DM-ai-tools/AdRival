import { NextResponse } from "next/server";
import { hashPassword } from "@/lib/auth/password";
import {
  normalizeUsername,
  validateDisplayName,
  validatePassword,
  validateUsername,
} from "@/lib/auth/validation";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";
import { createUser, getUserByUsername, toPublicUser } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: {
    username?: string;
    displayName?: string;
    password?: string;
    confirmPassword?: string;
  } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const usernameErr = validateUsername(String(body.username ?? ""));
  if (usernameErr) {
    return NextResponse.json({ error: usernameErr }, { status: 400 });
  }
  const nameErr = validateDisplayName(String(body.displayName ?? ""));
  if (nameErr) {
    return NextResponse.json({ error: nameErr }, { status: 400 });
  }
  const passwordErr = validatePassword(String(body.password ?? ""));
  if (passwordErr) {
    return NextResponse.json({ error: passwordErr }, { status: 400 });
  }
  if (String(body.password) !== String(body.confirmPassword ?? "")) {
    return NextResponse.json({ error: "Passwords do not match" }, { status: 400 });
  }

  const username = normalizeUsername(String(body.username ?? ""));
  if (getUserByUsername(username)) {
    return NextResponse.json({ error: "Username already taken" }, { status: 409 });
  }

  try {
    const user = createUser({
      username,
      displayName: String(body.displayName ?? "").trim(),
      passwordHash: await hashPassword(String(body.password ?? "")),
    });
    const token = await createSessionToken(toPublicUser(user));
    const res = NextResponse.json({ ok: true, user: toPublicUser(user) });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isSecureRequest(request)));
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Registration failed" },
      { status: 400 },
    );
  }
}
