import { NextResponse } from "next/server";
import { getUserByInviteHash, updateUser } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { hashInviteToken } from "@/lib/auth/invite";
import { validatePassword } from "@/lib/auth/validation";
import { recordAudit } from "@/lib/accounting/records";
import { errorResponse } from "@/lib/authz";

export const runtime = "nodejs";

const GONE = "This invitation link is no longer valid. Ask your administrator to send a new one.";

async function findInvited(token: string) {
  if (!token) return null;
  const user = await getUserByInviteHash(hashInviteToken(token));
  if (!user?.invite || user.status !== "active") return null;
  if (new Date(user.invite.expiresAt).getTime() < Date.now()) return null;
  return user;
}

/** Who an invitation link is for, so the page can greet them. */
export async function GET(request: Request) {
  try {
    const user = await findInvited(new URL(request.url).searchParams.get("token") ?? "");
    if (!user) return NextResponse.json({ error: GONE }, { status: 410 });
    return NextResponse.json({ displayName: user.displayName, username: user.username, email: user.email ?? null });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Accepts the invitation: sets the password the invited person chose. */
export async function POST(request: Request) {
  try {
    let body: { token?: string; password?: string; confirmPassword?: string } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const password = String(body.password ?? "");
    const passwordErr = validatePassword(password);
    if (passwordErr) return NextResponse.json({ error: passwordErr }, { status: 400 });
    if (password !== String(body.confirmPassword ?? "")) {
      return NextResponse.json({ error: "Passwords do not match" }, { status: 400 });
    }
    const user = await findInvited(String(body.token ?? ""));
    if (!user) return NextResponse.json({ error: GONE }, { status: 410 });

    await updateUser(user.id, {
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      invite: null,
      bumpSessionEpoch: true,
    });
    await recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: "auth.invite.accept",
      targetUserId: user.id,
      details: {},
    });
    return NextResponse.json({ ok: true, username: user.username });
  } catch (err) {
    return errorResponse(err);
  }
}
