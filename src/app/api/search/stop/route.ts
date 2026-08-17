import { NextResponse } from "next/server";
import { getJob, listJobs, isSearchWorkInFlight, stopSearchJob } from "@/lib/db";

export const runtime = "nodejs";

/** Stop one search job, or all currently running jobs when stopAll=true. */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const stopAll = Boolean(body.stopAll);
    const jobId = String(body.jobId ?? "").trim();

    if (stopAll) {
      const running = listJobs(200).filter(isSearchWorkInFlight);
      const stopped = running
        .map((j) => stopSearchJob(j.id, "Stopped — search cancelled"))
        .filter(Boolean);
      return NextResponse.json({
        stopped: stopped.length,
        jobIds: stopped.map((j) => j!.id),
      });
    }

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId is required (or stopAll: true)" },
        { status: 400 },
      );
    }
    if (!getJob(jobId)) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const job = stopSearchJob(jobId, "Stopped — search cancelled");
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop search" },
      { status: 500 },
    );
  }
}
