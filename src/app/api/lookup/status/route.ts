import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
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
    const lookupId = searchParams.get("lookupId");
    if (!lookupId) {
      return NextResponse.json({ error: "lookupId is required" }, { status: 400 });
    }

    const access = await resolveProjectAccess("lookup", lookupId, user, "view");

    const job = await getLookupJob(lookupId);
    if (!job) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    const [lookupAds, summary] = await Promise.all([getLookupAds(lookupId), getCreditSummary(user.id)]);
    const ads = lookupAds.map((ad) => ({
      ...ad,
      pageAnalysis: maskPageAnalysis(ad.pageAnalysis),
    }));
    // Users see a generic provider message; administrators also see which provider ran out.
    const masked = (text: string | null | undefined) => maskClientFacingText(redactProviderCreditText(text, false));
    const showsProviderNote = (out: string | null | undefined): out is string =>
      user.role === "admin" && Boolean(out) && out!.includes(USER_PROVIDER_CREDIT_MESSAGE);
    // The provider calls are read only when an admin is shown that message.
    const adminNote = [job.error, job.offersReport?.error, job.progress?.message].some((text) =>
      showsProviderNote(masked(text)),
    )
      ? providerOutOfCreditsNote((await queryProviderCalls({ runId: lookupId, limit: 300 })).rows)
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
      ads,
      access: {
        role: access.role,
        ownerIsSelf: access.project.ownerUserId === user.id,
      },
      credits: {
        ...(await reportRunCredits(user.id, lookupId, summary)),
        lowCredit: summary.lowCredit,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
