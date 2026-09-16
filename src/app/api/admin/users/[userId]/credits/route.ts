import { NextResponse } from "next/server";
import { getUserById } from "@/lib/db";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import {
  addCredits,
  getCreditSummary,
  recordAdjustment,
  setAllowance,
  setResetCadence,
} from "@/lib/accounting/service";
import { parseCreditsInput } from "@/lib/accounting/units";
import type { ResetCadence } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Credit administration. Every action requires a reason and appends a ledger
 * entry; nothing here edits an existing charge.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = getUserById(userId);
    if (!user) throw new HttpError(404, "User not found", "not_found");

    let body: {
      action?: "set_allowance" | "add_credits" | "adjustment" | "set_reset_cadence";
      credits?: string | number;
      cadence?: ResetCadence;
      reason?: string;
      providerCallId?: string | null;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const reason = String(body.reason ?? "").trim();
    if (!reason) {
      throw new HttpError(400, "A reason is required", "reason_required");
    }

    switch (body.action) {
      case "set_allowance": {
        const subunits = parseCreditsInput(body.credits);
        if (subunits === null || subunits < 0) {
          throw new HttpError(400, "Allowance must be a non-negative number");
        }
        setAllowance({ userId, actorUserId: admin.id, reason, allowanceSubunits: subunits });
        recordAudit({
          actorUserId: admin.id,
          actorUsername: admin.username,
          action: "admin.credits.set_allowance",
          targetUserId: userId,
          details: { allowanceSubunits: subunits, reason },
        });
        break;
      }
      case "add_credits": {
        const subunits = parseCreditsInput(body.credits);
        if (subunits === null || subunits <= 0) {
          throw new HttpError(400, "Amount must be greater than zero");
        }
        addCredits({ userId, actorUserId: admin.id, reason, amountSubunits: subunits });
        recordAudit({
          actorUserId: admin.id,
          actorUsername: admin.username,
          action: "admin.credits.add",
          targetUserId: userId,
          details: { amountSubunits: subunits, reason },
        });
        break;
      }
      case "adjustment": {
        // Positive refunds the user, negative bills them.
        const subunits = parseCreditsInput(body.credits);
        if (subunits === null || subunits === 0) {
          throw new HttpError(400, "Adjustment must be a non-zero number");
        }
        recordAdjustment({
          userId,
          actorUserId: admin.id,
          reason,
          amountSubunits: subunits,
          providerCallId: body.providerCallId ?? null,
        });
        recordAudit({
          actorUserId: admin.id,
          actorUsername: admin.username,
          action: "admin.credits.adjustment",
          targetUserId: userId,
          details: { amountSubunits: subunits, reason },
        });
        break;
      }
      case "set_reset_cadence": {
        const cadence: ResetCadence = body.cadence === "monthly" ? "monthly" : "none";
        setResetCadence({ userId, actorUserId: admin.id, reason, cadence });
        recordAudit({
          actorUserId: admin.id,
          actorUsername: admin.username,
          action: "admin.credits.set_reset_cadence",
          targetUserId: userId,
          details: { cadence, reason },
        });
        break;
      }
      default:
        throw new HttpError(400, "Unknown action");
    }

    return NextResponse.json(
      { ok: true, credits: getCreditSummary(userId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
