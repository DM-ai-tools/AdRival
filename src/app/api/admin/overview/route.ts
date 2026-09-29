import { NextResponse } from "next/server";
import { getUserById, listUsers, readDb } from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
import {
  listPendingReconciliation,
  queryProviderCalls,
  usageByDate,
  usageByProvider,
} from "@/lib/accounting/service";
import { queryAudit } from "@/lib/accounting/records";
import { getProviderBalances } from "@/lib/accounting/providerBalances";
import { summarizeTrackedSpend } from "@/lib/accounting/priceBook";
import {
  ROUTINE_AUDIT_ACTIONS,
  auditActionLabel,
  auditDetailsText,
} from "@/lib/admin/auditView";

export const runtime = "nodejs";

/** Live vendor balances take seconds each; reuse them for a few minutes. */
const BALANCE_CACHE_MS = 5 * 60 * 1000;
let balanceCache: { at: number; value: Awaited<ReturnType<typeof getProviderBalances>> } | null = null;

/**
 * Admin overview. ?days=7|30|90|all (default 30) limits usage and spend to
 * that period. ?part=balances returns only the live provider balances (slow,
 * cached for five minutes; ?refresh=1 skips the cache).
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);

    if (url.searchParams.get("part") === "balances") {
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh || !balanceCache || Date.now() - balanceCache.at > BALANCE_CACHE_MS) {
        balanceCache = { at: Date.now(), value: await getProviderBalances() };
      }
      return NextResponse.json({
        providerBalances: balanceCache.value,
        checkedAt: new Date(balanceCache.at).toISOString(),
      });
    }

    const daysParam = url.searchParams.get("days") ?? "30";
    const days = daysParam === "all" ? null : Math.max(1, Math.min(Number(daysParam) || 30, 3650));
    const from = days ? new Date(Date.now() - days * 86_400_000).toISOString() : undefined;

    const db = readDb();
    const users = listUsers({ includeDeleted: true });
    const periods = (db.creditPeriods ?? []).filter((p) => p.status === "current");

    const allocated = periods.reduce((s, p) => s + p.allowanceSubunits, 0);
    const consumed = periods.reduce((s, p) => s + p.consumedSubunits, 0);
    const reserved = periods.reduce((s, p) => s + p.reservedSubunits, 0);

    // Search every call by status, not just the newest few.
    const recentFailures = [
      ...queryProviderCalls({ status: "failed", from, limit: 25 }).rows,
      ...queryProviderCalls({ status: "timeout", from, limit: 25 }).rows,
    ]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 25);

    const username = (id?: string | null) => (id ? getUserById(id)?.username ?? null : null);

    return NextResponse.json({
      range: { days, from: from ?? null },
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
      usageByProvider: usageByProvider({ from }),
      usageByDate: usageByDate({ from }).slice(0, days ?? 90),
      recentFailures,
      pendingReconciliation: listPendingReconciliation().map((r) => ({
        ...r,
        username: username(r.userId),
      })),
      recentAudit: queryAudit({ limit: 25, excludeActions: ROUTINE_AUDIT_ACTIONS }).map((e) => ({
        ...e,
        actionLabel: auditActionLabel(e.action),
        targetUsername: username(e.targetUserId),
        detailsText: auditDetailsText(e),
      })),
      /**
       * Local running total: tokens stored on each call, priced from the
       * documented per-million rate for that model. Not a live vendor balance.
       */
      trackedSpend: summarizeTrackedSpend(
        queryProviderCalls({ from, limit: Number.MAX_SAFE_INTEGER }).rows,
      ),
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
