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
import {
  createUser,
  getAppSettings,
  getUserByUsername,
  toPublicUser,
} from "@/lib/db";
import { initializeUserCredits } from "@/lib/accounting/service";
import { recordAudit } from "@/lib/accounting/records";

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

  const settings = await getAppSettings();
  if (!settings.publicSignupEnabled) {
    return NextResponse.json(
      {
        error:
          "Public sign-up is currently disabled. Ask your administrator for an account.",
      },
      { status: 403 },
    );
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
  if (await getUserByUsername(username)) {
    return NextResponse.json({ error: "Username already taken" }, { status: 409 });
  }

  try {
    // Public sign-up always creates a regular user. The role is not read from
    // the request body, so it cannot be self-assigned.
    const user = await createUser({
      username,
      displayName: String(body.displayName ?? "").trim(),
      passwordHash: await hashPassword(String(body.password ?? "")),
      role: "user",
      status: "active",
    });

    // Zero credits unless an admin configured a default allowance.
    await initializeUserCredits(user.id, {
      allowanceSubunits: settings.defaultAllowanceSubunits,
      resetCadence: settings.defaultResetCadence,
      reason: "Default allowance on sign-up",
    });
    await recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: "auth.register",
      targetUserId: user.id,
      details: { allowanceSubunits: settings.defaultAllowanceSubunits },
    });

    const publicUser = toPublicUser(user);
    const token = await createSessionToken({
      ...publicUser,
      sessionEpoch: user.sessionEpoch,
    });
    const res = NextResponse.json({ ok: true, user: publicUser });
    res.cookies.set(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(isSecureRequest(request)),
    );
    return res;
  } catch (err) {
    // A sign-up that raced another for the same name: user-facing, as before.
    if (err instanceof Error && err.message === "Username already taken") {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    // Anything else (database or unexpected) stays server-side: this route is
    // public, and a raw database message can name hosts, tables or SQL.
    console.error("[auth/register] account creation failed:", err);
    return NextResponse.json(
      { error: "Could not create the account. Please try again." },
      { status: 500 },
    );
  }
}
