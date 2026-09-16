import { NextResponse } from "next/server";
import { listUsers, readDb } from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
import { listPendingReconciliation,
  queryProviderCalls,
  usageByDate,
  usageByProvider,
} from "@/lib/accounting/service";
import { queryAudit } from "@/lib/accounting/records";
import { getProviderBalances } from "@/lib/accounting/providerBalances";
import { summarizeTrackedSpend } from "@/lib/accounting/priceBook";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    const db = readDb();
    const users = listUsers({ includeDeleted: true });
    const periods = (db.creditPeriods ?? []).filter((p) => p.status === "current");

    const allocated = periods.reduce((s, p) => s + p.allowanceSubunits, 0);
    const consumed = periods.reduce((s, p) => s + p.consumedSubunits, 0);
    const reserved = periods.reduce((s, p) => s + p.reservedSubunits, 0);

    const recentFailures = queryProviderCalls({ limit: 25 }).rows.filter(
      (c) => c.status === "failed" || c.status === "timeout",
    );

    return NextResponse.json({
      users: {
        total: users.filter((u) => u.status !== "deleted").length,
        active: users.filter((u) => u.status === "active").length,
        suspended: users.filter((u) => u.status === "suspended").length,
        deleted: users.filter((u) => u.status === "deleted").length,
        admins: users.filter((u) => u.role === "admin" && u.status === "active")
          .length,
      },
      credits: {
        allocatedSubunits: allocated,
        consumedSubunits: consumed,
        reservedSubunits: reserved,
        remainingSubunits: allocated - consumed - reserved,
      },
      usageByProvider: usageByProvider(),
      usageByDate: usageByDate().slice(0, 30),
      recentFailures,
      pendingReconciliation: listPendingReconciliation(),
      recentAudit: queryAudit({ limit: 25 }),
      /**
       * Local running total: tokens stored on each call, priced from the
       * documented per-million rate for that model. Not a live vendor balance.
       */
      trackedSpend: summarizeTrackedSpend(
        queryProviderCalls({ limit: Number.MAX_SAFE_INTEGER }).rows,
      ),
      providerBalances: await getProviderBalances(),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
