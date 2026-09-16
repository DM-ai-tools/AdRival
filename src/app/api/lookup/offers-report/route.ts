import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { reportRunCredits, runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { runLookupOffersReportPhase } from "@/lib/pipeline/lookupOffersReport";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Build or refresh the unique ad-copy + landing-page offers report for a lookup.
 * Body: { lookupId: string, force?: boolean }
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const lookupId = String(body.lookupId ?? "").trim();
    if (!lookupId) {
      return NextResponse.json(
        { error: "lookupId is required" },
        { status: 400 },
      );
    }

    resolveProjectAccess("lookup", lookupId, user, "run");

    const job = getLookupJob(lookupId);
    if (!job) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    const ads = getLookupAds(lookupId);
    if (ads.length === 0) {
      return NextResponse.json(
        { error: "No ads on this lookup to analyze" },
        { status: 400 },
      );
    }

    const force = Boolean(body.force);
    if (
      !force &&
      job.offersReport?.status === "completed" &&
      job.offersReport.adsAnalyzed === ads.length
    ) {
      return NextResponse.json({ job, ads, cached: true });
    }

    const updated = await runBillable(
      {
        user,
        operation: "lookup.offers_report",
        projectKind: "lookup",
        projectId: lookupId,
        runId: lookupId,
      },
      () =>
        runLookupOffersReportPhase(lookupId, {
          force,
          finalStatus: ads.length > 0 ? "completed" : "partial",
        }),
    );

    return NextResponse.json({
      job: updated || getLookupJob(lookupId),
      ads: getLookupAds(lookupId),
      cached: false,
      credits: reportRunCredits(user.id, lookupId),
    });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    return errorResponse(err);
  }
}
