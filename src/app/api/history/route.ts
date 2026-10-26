import { NextResponse } from "next/server";
import {
  deleteHistoryRun,
  getCompetitorsByRun,
  getJob,
  listHistoryRuns,
  listProjects,
} from "@/lib/db";
import { competitorForList } from "@/lib/competitorView";
import {
  errorResponse,
  requireUser,
  resolveProjectAccess,
  visibleRunIds,
} from "@/lib/authz";

export const runtime = "nodejs";

/** GET /api/history — the caller's own runs, or one run with competitors */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");

    if (runId) {
      await resolveProjectAccess("search", runId, user, "view");
      const job = await getJob(runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const competitors = (await getCompetitorsByRun(runId)).map(competitorForList);
      return NextResponse.json({
        job,
        competitors,
        competitorCount: competitors.length,
      });
    }

    // Own + shared only. Legacy rows with no owner never appear here. Only
    // the visible runs are read, newest first.
    const visible = await visibleRunIds(user, "search");
    const runs = await listHistoryRuns(100, { ids: visible });
    return NextResponse.json({ runs });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/history?runId=... — delete one of the caller's runs.
 * DELETE /api/history?all=1 — delete every run the caller owns.
 *
 * "all" is scoped to the caller; it never touches another user's history.
 */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all");
    const runId = searchParams.get("runId");

    if (all === "1" || all === "true") {
      const owned = (await listProjects({ ownerUserId: user.id })).filter(
        (p) => p.kind === "search",
      );
      let removedCompetitors = 0;
      for (const run of owned) {
        removedCompetitors += (await deleteHistoryRun(run.id)).removedCompetitors;
      }
      return NextResponse.json({
        ok: true,
        removedRuns: owned.length,
        removedCompetitors,
      });
    }

    if (!runId) {
      return NextResponse.json(
        { error: "runId is required (or all=1 to clear your history)" },
        { status: 400 },
      );
    }

    // Deleting is an edit, so shared viewers are rejected.
    await resolveProjectAccess("search", runId, user, "edit");
    const result = await deleteHistoryRun(runId);
    if (!result.ok) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      runId,
      removedCompetitors: result.removedCompetitors,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
