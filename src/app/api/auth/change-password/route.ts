import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { validatePassword } from "@/lib/auth/validation";
import { getUserById, toPublicUser, updateUser } from "@/lib/db";
import {
  createSessionToken,
  isSecureRequest,
  parseSessionToken,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const jar = await cookies();
  const session = await parseSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = getUserById(session.sub);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
  }

  const passwordErr = validatePassword(newPassword);
  if (passwordErr) {
    return NextResponse.json({ error: passwordErr }, { status: 400 });
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: "New passwords do not match" }, { status: 400 });
  }

  const updated = updateUser(user.id, {
    passwordHash: await hashPassword(newPassword),
  });
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const token = await createSessionToken(toPublicUser(updated));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isSecureRequest(request)));
  return res;
}
