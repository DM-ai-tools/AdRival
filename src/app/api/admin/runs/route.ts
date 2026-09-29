import { NextResponse } from "next/server";
import { getProjectSpace, getUserById, readDb } from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, scopedUserIds } from "@/lib/authz";
import { usageByRun } from "@/lib/accounting/service";

export const runtime = "nodejs";

/** Internal helper records created by the pipelines, not user runs. */
function isInternalRun(id: string): boolean {
  return /^(search-offers:|lookup-recreate-|lookup-ad-)/.test(id);
}

/**
 * Every search and lookup across all users, newest first, with owner, client
 * space, status and credits used. Query: q (title contains), owner (user id),
 * kind (search|lookup), status, limit (default 300).
 */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const allowed = scopedUserIds(adminScope(admin));
    const p = new URL(request.url).searchParams;
    const q = (p.get("q") || "").trim().toLowerCase();
    const owner = p.get("owner") || "";
    const kind = p.get("kind") || "";
    const status = p.get("status") || "";
    const limit = Math.min(Math.max(Number(p.get("limit")) || 300, 1), 2000);

    const credits = new Map<string, number>();
    for (const row of usageByRun()) {
      if (row.runId) credits.set(row.runId, (credits.get(row.runId) ?? 0) + row.creditsCharged);
    }

    const db = readDb();
    const runs = [
      ...db.jobs.map((job) => ({
        kind: "search" as const,
        id: job.id,
        title: job.keyword || "Keyword search",
        platform: job.platform ?? null,
        status: job.status,
        stage: job.progress?.stage ?? null,
        ownerUserId: job.ownerUserId ?? null,
        spaceId: job.spaceId ?? null,
        archivedAt: job.archivedAt ?? null,
        results: job.competitorIds?.length ?? 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      })),
      ...(db.lookupJobs ?? [])
        .filter((job) => !job.internalOnly)
        .map((job) => ({
          kind: "lookup" as const,
          id: job.id,
          title: job.queryName || "Competitor lookup",
          platform: job.platform ?? null,
          status: job.status,
          stage: job.progress?.stage ?? null,
          ownerUserId: job.ownerUserId ?? null,
          spaceId: job.spaceId ?? null,
          archivedAt: job.archivedAt ?? null,
          results: job.adIds?.length ?? 0,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        })),
    ]
      .filter((run) => !isInternalRun(run.id))
      // Organisation admins see only runs owned by their organisation's users.
      .filter((run) => !allowed || (run.ownerUserId !== null && allowed.has(run.ownerUserId)))
      .filter((run) => !kind || run.kind === kind)
      .filter((run) => !status || run.status === status)
      .filter((run) => !owner || run.ownerUserId === owner)
      .filter((run) => !q || run.title.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const view = runs.slice(0, limit).map((run) => {
      const user = run.ownerUserId ? getUserById(run.ownerUserId) : null;
      return {
        ...run,
        ownerUsername: user?.username ?? null,
        ownerDisplayName: user?.displayName ?? null,
        clientName: run.spaceId ? getProjectSpace(run.spaceId)?.clientName ?? null : null,
        creditsCharged: credits.get(run.id) ?? 0,
      };
    });
    return NextResponse.json({ runs: view, total: runs.length }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
