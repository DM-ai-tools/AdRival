import { NextResponse } from "next/server";
import { getUserById, updateUser } from "@/lib/db";
import { assertUserInScope, errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { newInvite, sendInvite } from "@/lib/auth/invite";
import { recordAudit } from "@/lib/accounting/records";

export const runtime = "nodejs";

/**
 * Send the invitation again, with a new link (the earlier link stops working).
 * Only for people who have not accepted yet.
 */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = await getUserById(userId);
    assertUserInScope(admin, user);
    if (user.status === "deleted") throw new HttpError(409, "Account is deleted", "deleted");
    if (!user.invite) throw new HttpError(409, "This person has already accepted their invitation", "conflict");
    if (!user.email) throw new HttpError(409, "No email address on file for this user", "conflict");

    const { token, invite } = newInvite();
    const updated = await updateUser(userId, { invite });
    if (!updated) throw new HttpError(404, "User not found", "not_found");
    const mail = await sendInvite({ request, user: updated, token, invitedBy: admin.displayName || admin.username });

    await recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.invite_resend",
      targetUserId: userId,
      details: { emailSent: mail.sent },
    });
    return NextResponse.json({
      ok: true,
      emailSent: mail.sent,
      inviteLink: mail.sent ? undefined : mail.link,
      emailError: mail.error,
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
