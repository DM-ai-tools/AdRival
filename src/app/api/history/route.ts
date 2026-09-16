import { NextResponse } from "next/server";
import {
  deleteHistoryRun,
  getCompetitorsByRun,
  getJob,
  listHistoryRuns,
} from "@/lib/db";
import {
  errorResponse,
  requireUser,
  resolveProjectAccess,
  visibleProjectKeys,
} from "@/lib/authz";

export const runtime = "nodejs";

/** GET /api/history — the caller's own runs, or one run with competitors */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");

    if (runId) {
      resolveProjectAccess("search", runId, user, "view");
      const job = getJob(runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const competitors = getCompetitorsByRun(runId);
      return NextResponse.json({
        job,
        competitors,
        competitorCount: competitors.length,
      });
    }

    // Own + shared only. Legacy rows with no owner never appear here.
    const visible = visibleProjectKeys(user);
    const runs = listHistoryRuns(500).filter((run) =>
      visible.has(`search:${run.id}`),
    );
    return NextResponse.json({ runs: runs.slice(0, 100) });
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
      const owned = listHistoryRuns(1000).filter(
        (run) => run.ownerUserId === user.id,
      );
      let removedCompetitors = 0;
      for (const run of owned) {
        removedCompetitors += deleteHistoryRun(run.id).removedCompetitors;
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
    resolveProjectAccess("search", runId, user, "edit");
    const result = deleteHistoryRun(runId);
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
