import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, getSearchCompetitorAdsByRun } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { reportRunCredits } from "@/lib/accounting/run";
import { redactProviderCreditText } from "@/lib/accounting/errors";
import { getCreditSummary } from "@/lib/accounting/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId");
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }

    // 404s for a run the caller doesn't own or have shared, so polling another
    // user's job id reveals nothing.
    const access = resolveProjectAccess("search", jobId, user, "view");

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const competitors = getCompetitorsByRun(jobId);
    const ads = getSearchCompetitorAdsByRun(jobId).map((ad) => ({
      ...ad,
      raw: {},
    }));
    const summary = getCreditSummary(user.id);
    const isAdmin = user.role === "admin";
    return NextResponse.json({
      job: {
        ...job,
        error: redactProviderCreditText(job.error, isAdmin) ?? null,
        progress: job.progress
          ? {
              ...job.progress,
              message:
                redactProviderCreditText(job.progress.message, isAdmin) ??
                job.progress.message,
            }
          : job.progress,
      },
      competitors,
      ads,
      access: { role: access.role, ownerIsSelf: access.project.ownerUserId === user.id },
      // Drives "This run used X credits. You have Y credits available."
      credits: { ...reportRunCredits(user.id, jobId), lowCredit: summary.lowCredit },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
