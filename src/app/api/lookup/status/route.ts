import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { reportRunCredits } from "@/lib/accounting/run";
import { redactProviderCreditText } from "@/lib/accounting/errors";
import { maskClientFacingText, maskPageAnalysis } from "@/lib/clientFacing";
import { getCreditSummary } from "@/lib/accounting/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const lookupId = searchParams.get("lookupId");
    if (!lookupId) {
      return NextResponse.json({ error: "lookupId is required" }, { status: 400 });
    }

    const access = resolveProjectAccess("lookup", lookupId, user, "view");

    const job = getLookupJob(lookupId);
    if (!job) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    const ads = getLookupAds(lookupId).map((ad) => ({
      ...ad,
      pageAnalysis: maskPageAnalysis(ad.pageAnalysis),
    }));
    const summary = getCreditSummary(user.id);
    const visible = (text: string | null | undefined) =>
      maskClientFacingText(redactProviderCreditText(text, false));
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
      ads,
      access: {
        role: access.role,
        ownerIsSelf: access.project.ownerUserId === user.id,
      },
      credits: {
        ...reportRunCredits(user.id, lookupId),
        lowCredit: summary.lowCredit,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
