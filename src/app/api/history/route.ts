import { NextResponse } from "next/server";
import {
  clearAllHistory,
  deleteHistoryRun,
  getCompetitorsByRun,
  getJob,
  listHistoryRuns,
} from "@/lib/db";

export const runtime = "nodejs";

/** GET /api/history — list all past runs, or one run with competitors */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (runId) {
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

  const runs = listHistoryRuns(100);
  return NextResponse.json({ runs });
}

/** DELETE /api/history?runId=... — delete one run (and free its pageIds for rediscovery)
 *  DELETE /api/history?all=1 — clear all history
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all");
  const runId = searchParams.get("runId");

  if (all === "1" || all === "true") {
    const result = clearAllHistory();
    return NextResponse.json({ ok: true, ...result });
  }

  if (!runId) {
    return NextResponse.json(
      { error: "runId is required (or all=1 to clear everything)" },
      { status: 400 },
    );
  }

  const result = deleteHistoryRun(runId);
  if (!result.ok) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    runId,
    removedCompetitors: result.removedCompetitors,
  });
}
