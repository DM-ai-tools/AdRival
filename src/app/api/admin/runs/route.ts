import { NextResponse } from "next/server";
import { getProjectSpacesByIds, getUsersByIds, listRunOverview } from "@/lib/db";
import { adminScope, errorResponse, requireAdmin, scopedUserIds } from "@/lib/authz";
import { creditsByRun } from "@/lib/accounting/service";

export const runtime = "nodejs";

/**
 * Every search and lookup across all users, newest first, with owner, client
 * space, status and credits used. Query: q (title contains), owner (user id),
 * kind (search|lookup), status, limit (default 300). Pipeline helper records
 * are left out.
 */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const allowed = scopedUserIds(adminScope(admin));
    const p = new URL(request.url).searchParams;
    const limit = Math.min(Math.max(Number(p.get("limit")) || 300, 1), 2000);

    const { rows: runs, total } = await listRunOverview({
      // Organisation admins see only runs owned by their organisation's users.
      ownerUserIds: allowed,
      ownerUserId: p.get("owner") || undefined,
      kind: p.get("kind") || undefined,
      status: p.get("status") || undefined,
      titleContains: (p.get("q") || "").trim() || undefined,
      excludeInternal: true,
      limit,
    });

    const [users, spaces, credits] = await Promise.all([
      getUsersByIds(runs.map((run) => run.ownerUserId)),
      getProjectSpacesByIds(runs.map((run) => run.spaceId)),
      creditsByRun(runs.map((run) => run.id)),
    ]);
    const view = runs.map((run) => {
      const user = run.ownerUserId ? users.get(run.ownerUserId) : null;
      return {
        ...run,
        ownerUsername: user?.username ?? null,
        ownerDisplayName: user?.displayName ?? null,
        clientName: run.spaceId ? spaces.get(run.spaceId)?.clientName ?? null : null,
        creditsCharged: credits.get(run.id) ?? 0,
      };
    });
    return NextResponse.json({ runs: view, total }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
