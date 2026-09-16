import { NextResponse } from "next/server";
import { getJob, listJobs, isSearchWorkInFlight, stopSearchJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";

export const runtime = "nodejs";

/** Stop one of the caller's search jobs, or all of their running jobs. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => ({}));
    const stopAll = Boolean(body.stopAll);
    const jobId = String(body.jobId ?? "").trim();

    if (stopAll) {
      // Scoped to the caller's own runs.
      const running = listJobs(500).filter(
        (job) => job.ownerUserId === user.id && isSearchWorkInFlight(job),
      );
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
    resolveProjectAccess("search", jobId, user, "edit");
    if (!getJob(jobId)) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const job = stopSearchJob(jobId, "Stopped — search cancelled");
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}
