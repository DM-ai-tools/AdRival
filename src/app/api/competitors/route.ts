import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, listAllCompetitors } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId");

  if (runId) {
    const job = getJob(runId);
    const competitors = getCompetitorsByRun(runId);
    return NextResponse.json({ job, competitors });
  }

  return NextResponse.json({ competitors: listAllCompetitors() });
}
