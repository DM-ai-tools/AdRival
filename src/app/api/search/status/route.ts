import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, getSearchCompetitorAdsByRun, updateJob } from "@/lib/db";
import { isBrandReviewRunning } from "@/lib/pipeline/brandReview";
import { competitorForList } from "@/lib/competitorView";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { reportRunCredits } from "@/lib/accounting/run";
import { providerOutOfCreditsNote, redactProviderCreditText, USER_PROVIDER_CREDIT_MESSAGE } from "@/lib/accounting/errors";
import { queryProviderCalls } from "@/lib/accounting/service";
import { maskClientFacingText, maskPageAnalysis } from "@/lib/clientFacing";
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
    const access = await resolveProjectAccess("search", jobId, user, "view");

    let job = await getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }
    // Light rows only (no page HTML): this is the polling hot path.
    const [records, runAds, summary] = await Promise.all([
      getCompetitorsByRun(jobId),
      getSearchCompetitorAdsByRun(jobId),
      getCreditSummary(user.id),
    ]);
    // A brand review this app is not running was cut off by a restart or
    // redeploy. Say so, so it can be started again instead of looking stuck.
    if (
      job.progress?.stage === "brand_review" &&
      !isBrandReviewRunning(jobId) &&
      Date.now() - Date.parse(job.updatedAt) > 30_000
    ) {
      const done = job.progress.brandReviewDone ?? 0;
      const total = job.progress.brandReviewTotal ?? records.length;
      job =
        (await updateJob(jobId, {
          progress: {
            ...job.progress,
            stage: "done",
            brandReviewCurrentName: null,
            message: `Brand review stopped after ${done} of ${total} competitors because the app restarted. Run brand review again to finish it.`,
          },
        })) || job;
    }

    const competitors = records.map((competitor) => ({
      ...competitorForList(competitor),
      pageAnalysis: maskPageAnalysis(competitor.pageAnalysis),
    }));
    const ads = runAds.map((ad) => ({
      ...ad,
      raw: {},
    }));
    // Users see a generic provider message; administrators also see which provider ran out.
    const masked = (text: string | null | undefined) => maskClientFacingText(redactProviderCreditText(text, false));
    const showsProviderNote = (out: string | null | undefined): out is string =>
      user.role === "admin" && Boolean(out) && out!.includes(USER_PROVIDER_CREDIT_MESSAGE);
    // The provider calls are read only when an admin is shown that message.
    const adminNote = [job.error, job.offersReport?.error, job.progress?.message].some((text) =>
      showsProviderNote(masked(text)),
    )
      ? providerOutOfCreditsNote((await queryProviderCalls({ runId: jobId, limit: 300 })).rows)
      : null;
    const visible = (text: string | null | undefined) => {
      const out = masked(text);
      if (!showsProviderNote(out)) return out;
      return adminNote ? `${out} ${adminNote}` : out;
    };
    return NextResponse.json({
      job: {
        ...job,
        error: visible(job.error),
        offersReport: job.offersReport
          ? { ...job.offersReport, error: visible(job.offersReport.error) }
          : job.offersReport,
        progress: job.progress
          ? { ...job.progress, message: visible(job.progress.message) || "" }
          : job.progress,
      },
      competitors,
      ads,
      access: { role: access.role, ownerIsSelf: access.project.ownerUserId === user.id },
      // Drives "This run used X credits. You have Y credits available."
      credits: { ...(await reportRunCredits(user.id, jobId, summary)), lowCredit: summary.lowCredit },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
