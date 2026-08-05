import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { runLookupOffersReportPhase } from "@/lib/pipeline/lookupOffersReport";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Build or refresh the unique ad-copy + landing-page offers report for a lookup.
 * Body: { lookupId: string, force?: boolean }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const lookupId = String(body.lookupId ?? "").trim();
    if (!lookupId) {
      return NextResponse.json(
        { error: "lookupId is required" },
        { status: 400 },
      );
    }

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
      return NextResponse.json({
        job,
        ads,
        cached: true,
      });
    }

    const updated = await runLookupOffersReportPhase(lookupId, {
      force,
      finalStatus: ads.length > 0 ? "completed" : "partial",
    });

    return NextResponse.json({
      job: updated || getLookupJob(lookupId),
      ads: getLookupAds(lookupId),
      cached: false,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Offers report failed" },
      { status: 500 },
    );
  }
}
