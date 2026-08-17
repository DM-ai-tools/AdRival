import { NextResponse } from "next/server";
import { stopAllInFlightWork, stopLookupJob, stopSearchJob } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Kill in-flight work.
 * Body: { all?: true, jobId?: string, lookupId?: string }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const reason = "Stopped by user";
    const all = body.all !== false && !body.jobId && !body.lookupId
      ? true
      : Boolean(body.all);
    const jobId = String(body.jobId ?? "").trim();
    const lookupId = String(body.lookupId ?? "").trim();

    if (all) {
      const stopped = stopAllInFlightWork(reason, {
        jobIds: jobId ? [jobId] : [],
        lookupIds: lookupId ? [lookupId] : [],
      });
      return NextResponse.json({
        stopped: true,
        ...stopped,
      });
    }

    if (jobId) {
      const job = stopSearchJob(jobId, reason);
      return NextResponse.json({ stopped: true, job });
    }

    if (lookupId) {
      const job = stopLookupJob(lookupId, reason);
      return NextResponse.json({ stopped: true, job });
    }

    const stopped = stopAllInFlightWork(reason);
    return NextResponse.json({ stopped: true, ...stopped });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to stop work" },
      { status: 500 },
    );
  }
}
