import { NextResponse } from "next/server";
import {
  getJob,
  getLookupJob,
  isLookupWorkInFlight,
  isSearchWorkInFlight,
  listJobs,
  listLookupJobs,
  stopLookupJob,
  stopSearchJob,
} from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";

export const runtime = "nodejs";

/**
 * Kill in-flight work.
 * Body: { all?: true, jobId?: string, lookupId?: string }
 *
 * "all" means "all of mine": it never stops another user's runs, so a suspended
 * or malicious account cannot disrupt other workspaces.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json().catch(() => ({}));
    const reason = "Stopped by user";
    const jobId = String(body.jobId ?? "").trim();
    const lookupId = String(body.lookupId ?? "").trim();
    const all =
      body.all !== false && !jobId && !lookupId ? true : Boolean(body.all);

    const searchJobIds: string[] = [];
    const lookupIds: string[] = [];

    // Only stop a run that is actually working. Stopping a finished run would
    // leave a stop flag on it that blocks re-running its offers report later.
    if (jobId) {
      resolveProjectAccess("search", jobId, user, "edit");
      const job = getJob(jobId);
      if (job && isSearchWorkInFlight(job) && stopSearchJob(jobId, reason)) {
        searchJobIds.push(jobId);
      }
    }
    if (lookupId) {
      resolveProjectAccess("lookup", lookupId, user, "edit");
      const job = getLookupJob(lookupId);
      if (job && isLookupWorkInFlight(job) && stopLookupJob(lookupId, reason)) {
        lookupIds.push(lookupId);
      }
    }

    if (all) {
      for (const job of listJobs(500)) {
        if (job.ownerUserId !== user.id) continue;
        if (!isSearchWorkInFlight(job)) continue;
        if (stopSearchJob(job.id, reason)) searchJobIds.push(job.id);
      }
      for (const job of listLookupJobs(500)) {
        if (job.ownerUserId !== user.id) continue;
        if (!isLookupWorkInFlight(job)) continue;
        if (stopLookupJob(job.id, reason)) lookupIds.push(job.id);
      }
    }

    return NextResponse.json({
      stopped: true,
      searchJobIds: [...new Set(searchJobIds)],
      lookupIds: [...new Set(lookupIds)],
    });
  } catch (err) {
    return errorResponse(err);
  }
}
