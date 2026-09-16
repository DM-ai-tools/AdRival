import { NextResponse } from "next/server";
import { toPublicUser, updateUser } from "@/lib/db";
import { errorResponse, requireUser } from "@/lib/authz";
import { getCreditSummary } from "@/lib/accounting/service";
import {
  createSessionToken,
  isSecureRequest,
  sessionCookieOptions,
  SESSION_COOKIE,
} from "@/lib/auth/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const user = await requireUser({ allowPasswordChangePending: true });
    return NextResponse.json({
      user: toPublicUser(user),
      credits: getCreditSummary(user.id),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const current = await requireUser();

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

    // Role is never taken from the request body — a user cannot promote itself.
    const updated = updateUser(current.id, { displayName });
    if (!updated) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const token = await createSessionToken({
      ...toPublicUser(updated),
      sessionEpoch: updated.sessionEpoch,
    });
    const res = NextResponse.json({ ok: true, user: toPublicUser(updated) });
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
