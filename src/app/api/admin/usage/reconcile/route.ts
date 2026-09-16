import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import {
  listPendingReconciliation,
  resolveReconciliation,
} from "@/lib/accounting/service";
import { parseCreditsInput } from "@/lib/accounting/units";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json({ pending: listPendingReconciliation() });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/**
 * Close out a reservation whose provider billing outcome was unknown. The admin
 * decides how much of the hold to charge; the remainder is released.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();

    let body: {
      reservationId?: string;
      chargeCredits?: string | number;
      reason?: string;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const reservationId = String(body.reservationId ?? "");
    const reason = String(body.reason ?? "").trim();
    if (!reservationId) throw new HttpError(400, "reservationId is required");
    if (!reason) throw new HttpError(400, "A reason is required");

    const charge = parseCreditsInput(body.chargeCredits ?? 0);
    if (charge === null || charge < 0) {
      throw new HttpError(400, "Charge must be a non-negative number");
    }

    const ok = resolveReconciliation({
      reservationId,
      actorUserId: admin.id,
      chargeSubunits: charge,
      reason,
    });
    if (!ok) {
      throw new HttpError(
        404,
        "No pending reservation with that id",
        "not_found",
      );
    }

    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.usage.reconcile",
      details: { reservationId, chargeSubunits: charge, reason },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
