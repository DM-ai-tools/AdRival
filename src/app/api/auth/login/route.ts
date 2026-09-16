import { NextResponse } from "next/server";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/password";
import { validatePassword, validateUsername } from "@/lib/auth/validation";
import {
  clearLoginAttempts,
  isLoginLocked,
  recordFailedLogin,
} from "@/lib/auth/rateLimit";
import { recordAudit } from "@/lib/accounting/records";
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

  const username = String(body.username ?? "");
  const lock = isLoginLocked(username);
  if (lock.locked) {
    return NextResponse.json(
      {
        error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterSec / 60)} minute(s).`,
      },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSec) } },
    );
  }

  const user = getUserByUsername(username);
  const passwordOk =
    !!user &&
    (await verifyPassword(String(body.password ?? ""), user.passwordHash));

  // Suspended and soft-deleted accounts fail with the same generic message as a
  // wrong password so the endpoint does not disclose account state.
  if (!user || !passwordOk || user.status !== "active") {
    recordFailedLogin(username);
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 },
    );
  }

  clearLoginAttempts(username);
  const publicUser = toPublicUser(user);
  const token = await createSessionToken({
    ...publicUser,
    sessionEpoch: user.sessionEpoch,
  });
  recordAudit({
    actorUserId: user.id,
    actorUsername: user.username,
    action: "auth.login",
    targetUserId: user.id,
  });

  const res = NextResponse.json({
    ok: true,
    user: publicUser,
    mustChangePassword: user.mustChangePassword,
  });
  res.cookies.set(
    SESSION_COOKIE,
    token,
    sessionCookieOptions(isSecureRequest(request)),
  );
  return res;
}
