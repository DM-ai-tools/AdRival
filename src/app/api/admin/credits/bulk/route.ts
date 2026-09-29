import { NextResponse } from "next/server";
import { getUserById } from "@/lib/db";
import { adminScope, errorResponse, HttpError, requireAdmin, userInScope } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import { addCredits, getCreditSummary } from "@/lib/accounting/service";
import { parseCreditsInput } from "@/lib/accounting/units";

export const runtime = "nodejs";

/**
 * Add the same number of credits to several users at once, e.g. topping up
 * everyone who is low. Deleted accounts are skipped. Each user gets their own
 * ledger entry and audit entry, exactly as a single top-up would.
 * Body: { userIds: string[], credits: number|string, reason: string }
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    let body: { userIds?: unknown; credits?: string | number; reason?: string } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const reason = String(body.reason ?? "").trim();
    if (!reason) throw new HttpError(400, "A reason is required", "reason_required");
    const subunits = parseCreditsInput(body.credits);
    if (subunits === null || subunits <= 0) {
      throw new HttpError(400, "Amount must be greater than zero");
    }
    const ids = Array.isArray(body.userIds)
      ? [...new Set(body.userIds.map((id) => String(id)).filter(Boolean))]
      : [];
    if (!ids.length) throw new HttpError(400, "Choose at least one user");
    if (ids.length > 500) throw new HttpError(400, "Choose at most 500 users at a time");

    const updated: Array<{ userId: string; availableSubunits: number }> = [];
    const skipped: Array<{ userId: string; reason: string }> = [];
    for (const userId of ids) {
      const user = getUserById(userId);
      if (!user || !userInScope(adminScope(admin), user)) {
        skipped.push({ userId, reason: "not found" });
        continue;
      }
      if (user.status === "deleted") {
        skipped.push({ userId, reason: "deleted" });
        continue;
      }
      addCredits({ userId, actorUserId: admin.id, reason, amountSubunits: subunits });
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.credits.add",
        targetUserId: userId,
        details: { amountSubunits: subunits, reason, bulk: true },
      });
      updated.push({ userId, availableSubunits: getCreditSummary(userId).availableSubunits });
    }
    return NextResponse.json({ ok: true, updated, skipped }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
