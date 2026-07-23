import { NextResponse } from "next/server";
import {
  clearAllLookupHistory,
  deleteLookupHistoryRun,
  getLookupAds,
  getLookupJob,
  listLookupHistory,
} from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (runId) {
    const job = getLookupJob(runId);
    if (!job) {
      return NextResponse.json({ error: "Lookup run not found" }, { status: 404 });
    }
    return NextResponse.json({
      job,
      ads: getLookupAds(runId),
    });
  }

  return NextResponse.json({ runs: listLookupHistory() });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const all = searchParams.get("all");
  const runId = searchParams.get("runId");

  if (all === "1" || all === "true") {
    const result = clearAllLookupHistory();
    return NextResponse.json({ ok: true, ...result });
  }

  if (!runId) {
    return NextResponse.json(
      { error: "runId or all=1 is required" },
      { status: 400 },
    );
  }

  const result = deleteLookupHistoryRun(runId);
  if (!result.ok) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    runId,
    removedAds: result.removedAds,
  });
}
