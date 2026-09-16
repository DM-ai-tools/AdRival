import { NextResponse } from "next/server";
import {
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

    if (jobId) {
      resolveProjectAccess("search", jobId, user, "edit");
      if (stopSearchJob(jobId, reason)) searchJobIds.push(jobId);
    }
    if (lookupId) {
      resolveProjectAccess("lookup", lookupId, user, "edit");
      if (stopLookupJob(lookupId, reason)) lookupIds.push(lookupId);
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
