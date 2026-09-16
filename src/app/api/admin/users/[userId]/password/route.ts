import { NextResponse } from "next/server";
import { getUserById, updateUser } from "@/lib/db";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/bootstrap";
import { recordAudit } from "@/lib/accounting/records";

export const runtime = "nodejs";

/**
 * Reset a password to a freshly generated temporary one. The user must change it
 * at next login, and bumping the session epoch signs out every existing session
 * for that account immediately.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = getUserById(userId);
    if (!user) throw new HttpError(404, "User not found", "not_found");
    if (user.status === "deleted") {
      throw new HttpError(409, "Account is deleted", "deleted");
    }

    const temporaryPassword = generateTemporaryPassword();
    const updated = updateUser(userId, {
      passwordHash: await hashPassword(temporaryPassword),
      mustChangePassword: true,
      bumpSessionEpoch: true,
    });
    if (!updated) throw new HttpError(404, "User not found", "not_found");

    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.password_reset",
      targetUserId: userId,
      // The password itself is deliberately absent from the audit record.
      details: { sessionsInvalidated: true },
    });

    return NextResponse.json({
      ok: true,
      temporaryPassword,
      notice:
        "Share this temporary password with the user now — it is not stored and cannot be shown again. All their existing sessions have been signed out.",
    });
  } catch (err) {
    return errorResponse(err);
  }
}
