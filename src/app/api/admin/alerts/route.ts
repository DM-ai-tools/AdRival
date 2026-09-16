import { NextResponse } from "next/server";
import { errorResponse, requireAdmin } from "@/lib/authz";
import { listAdminAlerts, listUsers } from "@/lib/db";
import { getCreditSummary } from "@/lib/accounting/service";
import { formatCredits } from "@/lib/accounting/units";
import { providerLabel } from "@/lib/credits/display";

export const runtime = "nodejs";

/**
 * Admin alerts: users currently under the low-credit threshold, and provider
 * accounts that ran out of credits while someone was working.
 */
export async function GET() {
  try {
    await requireAdmin();
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

    const providerCredits = listAdminAlerts().map((alert) => ({
      id: alert.id,
      userId: alert.userId,
      username: alert.username,
      displayName: alert.displayName,
      provider: alert.provider,
      providerLabel: providerLabel(alert.provider, "admin"),
      runId: alert.runId,
      createdAt: alert.createdAt,
    }));

    return NextResponse.json(
      { lowCredit, providerCredits },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
