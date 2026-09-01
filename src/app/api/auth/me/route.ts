import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/server";
import { toPublicUser, updateUser } from "@/lib/db";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ user });
}

export async function PATCH(request: Request) {
  const current = await getCurrentUser();
  if (!current) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { displayName?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const displayName = String(body.displayName ?? "").trim();
  if (!displayName) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (displayName.length > 80) {
    return NextResponse.json(
      { error: "Name must be 80 characters or fewer" },
      { status: 400 },
    );
  }

  const updated = updateUser(current.id, { displayName });
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const token = await createSessionToken(toPublicUser(updated));
  const res = NextResponse.json({ ok: true, user: toPublicUser(updated) });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(isSecureRequest(request)));
  return res;
}
