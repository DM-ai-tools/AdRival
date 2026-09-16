import { NextResponse } from "next/server";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/validation";
import { toPublicUser, updateUser } from "@/lib/db";
import { errorResponse, requireUser } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    // Reachable while a forced password change is pending — that is the point.
    const user = await requireUser({ allowPasswordChangePending: true });

    let body: {
      currentPassword?: string;
      newPassword?: string;
      confirmPassword?: string;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const currentPassword = String(body.currentPassword ?? "");
    const newPassword = String(body.newPassword ?? "");
    const confirmPassword = String(body.confirmPassword ?? "");

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return NextResponse.json(
        { error: "Current password is incorrect" },
        { status: 401 },
      );
    }

    const passwordErr = validatePassword(newPassword);
    if (passwordErr) {
      return NextResponse.json({ error: passwordErr }, { status: 400 });
    }
    if (newPassword === currentPassword) {
      return NextResponse.json(
        { error: "New password must be different from the current password" },
        { status: 400 },
      );
    }
    if (newPassword !== confirmPassword) {
      return NextResponse.json(
        { error: "New passwords do not match" },
        { status: 400 },
      );
    }

    // Bumping the session epoch invalidates every other session for this user.
    const updated = updateUser(user.id, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      bumpSessionEpoch: true,
    });
    if (!updated) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: "auth.password_changed",
      targetUserId: user.id,
    });

    // Re-issue this session with the new epoch so the caller stays signed in.
    const token = await createSessionToken({
      ...toPublicUser(updated),
      sessionEpoch: updated.sessionEpoch,
    });
    const res = NextResponse.json({ ok: true });
    res.cookies.set(
      SESSION_COOKIE,
      token,
      sessionCookieOptions(isSecureRequest(request)),
    );
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}
