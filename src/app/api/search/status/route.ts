import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, getSearchCompetitorAdsByRun } from "@/lib/db";
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
    const access = resolveProjectAccess("search", jobId, user, "view");

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const competitors = getCompetitorsByRun(jobId).map((competitor) => ({
      ...competitorForList(competitor),
      pageAnalysis: maskPageAnalysis(competitor.pageAnalysis),
    }));
    const ads = getSearchCompetitorAdsByRun(jobId).map((ad) => ({
      ...ad,
      raw: {},
    }));
    const summary = getCreditSummary(user.id);
    // Users see a generic provider message; administrators also see which provider ran out.
    let adminNote: string | null | undefined;
    const visible = (text: string | null | undefined) => {
      const out = maskClientFacingText(redactProviderCreditText(text, false));
      if (user.role !== "admin" || !out || !out.includes(USER_PROVIDER_CREDIT_MESSAGE)) return out;
      if (adminNote === undefined) adminNote = providerOutOfCreditsNote(queryProviderCalls({ runId: jobId, limit: 300 }).rows);
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
      credits: { ...reportRunCredits(user.id, jobId), lowCredit: summary.lowCredit },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
