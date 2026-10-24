import { NextResponse } from "next/server";
import { countUsers, getUsersByIds } from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, scopedUserIds } from "@/lib/authz";
import {
  currentPeriodTotals,
  listPendingReconciliation,
  queryProviderCalls,
  summarizeUsageByDate,
  summarizeUsageByProvider,
} from "@/lib/accounting/service";
import { queryAudit } from "@/lib/accounting/records";
import { getProviderBalances } from "@/lib/accounting/providerBalances";
import { UNIT_LIST_PRICES, summarizeTrackedSpend, unitListPrice } from "@/lib/accounting/priceBook";
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
    const admin = await requireAdmin();
    const url = new URL(request.url);
    // null = platform admin (everything); otherwise one organisation's users.
    const scoped = await scopedUserIds(adminScope(admin));

    if (url.searchParams.get("part") === "balances") {
      // Vendor account balances belong to the platform, not to a client organisation.
      if (scoped) return NextResponse.json({ providerBalances: [], checkedAt: null, hidden: true });
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

    const [users, credits, failed, timedOut, pending, audit, calls] = await Promise.all([
      countUsers(scoped),
      currentPeriodTotals(scoped),
      // Search every call by status, not just the newest few.
      queryProviderCalls({ status: "failed", from, limit: 25, chargedUserIds: scoped }),
      queryProviderCalls({ status: "timeout", from, limit: 25, chargedUserIds: scoped }),
      // Billing checks against vendor dashboards are a platform task.
      scoped ? Promise.resolve([]) : listPendingReconciliation(),
      queryAudit({ limit: 25, excludeActions: ROUTINE_AUDIT_ACTIONS, userIds: scoped }),
      // Every call in range, loaded once for the provider/date breakdowns and tracked spend.
      queryProviderCalls({ from, limit: Number.MAX_SAFE_INTEGER, chargedUserIds: scoped }),
    ]);
    const byProvider = summarizeUsageByProvider(calls.rows);
    const byDate = summarizeUsageByDate(calls.rows);

    const recentFailures = [...failed.rows, ...timedOut.rows]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 25);

    const named = await getUsersByIds([...pending.map((r) => r.userId), ...audit.map((e) => e.targetUserId)]);
    const username = (id?: string | null) => (id ? named.get(id)?.username ?? null : null);

    return NextResponse.json({
      range: { days, from: from ?? null },
      users,
      credits: {
        ...credits,
        remainingSubunits: credits.allocatedSubunits - credits.consumedSubunits - credits.reservedSubunits,
      },
      usageByProvider: byProvider,
      usageByDate: byDate.slice(0, days ?? 90),
      recentFailures,
      pendingReconciliation: pending.map((r) => ({
        ...r,
        username: username(r.userId),
      })),
      recentAudit: audit.map((e) => ({
        ...e,
        actionLabel: auditActionLabel(e.action),
        targetUsername: username(e.targetUserId),
        detailsText: auditDetailsText(e),
      })),
      /**
       * Local running total: tokens stored on each call, priced from the
       * documented per-million rate for that model. Not a live vendor balance.
       */
      trackedSpend: summarizeTrackedSpend(calls.rows),
      /** Prices for providers billed per credit or request (env overrides applied). */
      unitPrices: UNIT_LIST_PRICES.map((p) => unitListPrice(p.provider)!).map((p) => ({
        provider: p.provider,
        unit: p.unit,
        usdPerUnit: p.usdPerUnit,
        source: p.source,
        env: p.env,
      })),
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
