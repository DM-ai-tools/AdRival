import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { acknowledgeAdminAlerts, listAdminAlerts, listUsers } from "@/lib/db";
import { getCreditSummary } from "@/lib/accounting/service";
import { recordAudit } from "@/lib/accounting/records";
import { formatCredits } from "@/lib/accounting/units";
import { providerLabel } from "@/lib/credits/display";

export const runtime = "nodejs";

/**
 * Admin alerts: users currently under the low-credit threshold, and provider
 * accounts that ran out of credits while someone was working. Provider alerts
 * stay open until an admin dismisses them; ?all=1 also lists dismissed ones.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const showAll = new URL(request.url).searchParams.get("all") === "1";
    const lowCredit = listUsers()
      .filter((user) => user.status === "active" && user.role !== "admin")
      .map((user) => ({ user, credits: getCreditSummary(user.id) }))
      .filter((row) => row.credits.lowCredit)
      .map((row) => ({
        userId: row.user.id,
        username: row.user.username,
        displayName: row.user.displayName,
        availableCredits: formatCredits(row.credits.availableSubunits),
        allowanceCredits: formatCredits(row.credits.allowanceSubunits),
        warningCredits: formatCredits(row.credits.lowCreditWarningSubunits),
      }));

    const all = listAdminAlerts();
    const open = all.filter((alert) => !alert.acknowledgedAt);
    const providerCredits = (showAll ? all : open).map((alert) => ({
      id: alert.id,
      userId: alert.userId,
      username: alert.username,
      displayName: alert.displayName,
      provider: alert.provider,
      providerLabel: providerLabel(alert.provider, "admin"),
      runId: alert.runId,
      createdAt: alert.createdAt,
      acknowledgedAt: alert.acknowledgedAt ?? null,
    }));

    return NextResponse.json(
      {
        lowCredit,
        providerCredits,
        counts: {
          lowCredit: lowCredit.length,
          providerOpen: open.length,
          providerDismissed: all.length - open.length,
          open: lowCredit.length + open.length,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/** Dismiss provider alerts. Body: { alertIds: string[] } */
export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = (await request.json().catch(() => ({}))) as { alertIds?: unknown };
    const ids = Array.isArray(body.alertIds) ? body.alertIds.map(String).filter(Boolean) : [];
    if (!ids.length) throw new HttpError(400, "Choose at least one alert");
    const dismissed = acknowledgeAdminAlerts(ids, admin.id);
    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.alert.acknowledge",
      details: { dismissed },
    });
    return NextResponse.json({ ok: true, dismissed });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
