import { NextResponse } from "next/server";
import { getJob, listJobs, isSearchWorkInFlight, stopSearchJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import type { SearchJob } from "@/lib/types";

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
      const running: SearchJob[] = [];
      for (const job of await listJobs(500)) {
        if (job.ownerUserId === user.id && (await isSearchWorkInFlight(job))) running.push(job);
      }
      const stopped: SearchJob[] = [];
      for (const j of running) {
        const result = await stopSearchJob(j.id, "Stopped — search cancelled");
        if (result) stopped.push(result);
      }
      return NextResponse.json({
        stopped: stopped.length,
        jobIds: stopped.map((j) => j.id),
      });
    }

    if (!jobId) {
      return NextResponse.json(
        { error: "jobId is required (or stopAll: true)" },
        { status: 400 },
      );
    }
    await resolveProjectAccess("search", jobId, user, "edit");
    if (!(await getJob(jobId))) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    const job = await stopSearchJob(jobId, "Stopped — search cancelled");
    return NextResponse.json({ job });
  } catch (err) {
    return errorResponse(err);
  }
}
