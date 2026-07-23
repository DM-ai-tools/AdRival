import { NextResponse } from "next/server";
import {
  clearAllHistory,
  clearAllLookupHistory,
  deleteHistoryRun,
  deleteLookupHistoryRun,
  getCompetitorsByRun,
  getJob,
  getLookupAds,
  getLookupJob,
} from "@/lib/db";
import { listUnifiedHistory } from "@/lib/historyUnified";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");
  const kind = searchParams.get("kind");

  if (runId && kind === "lookup") {
    const job = getLookupJob(runId);
    if (!job) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }
    return NextResponse.json({ kind: "lookup", job, ads: getLookupAds(runId) });
  }

  if (runId && kind === "search") {
    const job = getJob(runId);
    if (!job) {
      return NextResponse.json({ error: "Search not found" }, { status: 404 });
    }
    return NextResponse.json({
      kind: "search",
      job,
      competitors: getCompetitorsByRun(runId),
    });
  }

  return NextResponse.json({ runs: listUnifiedHistory() });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all");
  const runId = searchParams.get("runId");
  const kind = searchParams.get("kind");

  if (all === "1" || all === "true") {
    const searches = clearAllHistory();
    const lookups = clearAllLookupHistory();
    return NextResponse.json({
      ok: true,
      removedSearchRuns: searches.removedRuns,
      removedLookupRuns: lookups.removedRuns,
    });
  }

  if (!runId || !kind) {
    return NextResponse.json(
      { error: "runId and kind are required (or all=1)" },
      { status: 400 },
    );
  }

  if (kind === "lookup") {
    const result = deleteLookupHistoryRun(runId);
    if (!result.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      kind,
      runId,
      removedAds: result.removedAds,
    });
  }

  const result = deleteHistoryRun(runId);
  if (!result.ok) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    kind: "search",
    runId,
    removedCompetitors: result.removedCompetitors,
  });
}
