import { NextResponse } from "next/server";
import { getCompetitor } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { getRecreationVersionCounts } from "@/lib/data/competitors";
import { maskPageAnalysis, maskRecreatedPage } from "@/lib/clientFacing";
import { analyzeCompetitorLandingPage } from "@/lib/pipeline/landingPageAnalysis";
import {
  ensureLandingPageRecord,
  landingPageRecordsByKey,
} from "@/lib/pipeline/landingRecreateBridge";
import type { CompetitorRecord } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * What the offers dashboard needs about one landing page's record.
 * `versions` is the run's recreations by source page (getRecreationVersionCounts).
 */
function pageView(c: CompetitorRecord, versions: Record<string, number>) {
  const page = maskRecreatedPage(c.recreatedPage ?? null);
  return {
    competitorId: c.id,
    pageName: c.pageName,
    analysis: maskPageAnalysis(c.pageAnalysis ?? null),
    recreatedStatus: page?.status ?? null,
    versionCount: versions[c.id] ?? 0,
    recreatePath: `/recreate/${encodeURIComponent(c.id)}`,
  };
}

/**
 * Landing pages of a search's offers dashboard that already have a record
 * (analysed and/or recreated): GET ?jobId= → { pages: { [matchKey]: view } }.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const jobId = String(searchParams.get("jobId") || "").trim();
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    const access = await resolveProjectAccess("search", jobId, user, "view");
    const pages: Record<string, ReturnType<typeof pageView>> = {};
    const [records, versions] = await Promise.all([landingPageRecordsByKey(jobId), getRecreationVersionCounts(jobId)]);
    for (const [key, c] of records) pages[key] = pageView(c, versions);
    return NextResponse.json({ pages, canRun: access.role !== "viewer" });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Get a landing page from the offers dashboard ready to recreate:
 * POST { jobId, url, force? } finds or creates its record and analyses the
 * page (offer + page architecture) when it has not been analysed yet.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const jobId = String(body.jobId ?? "").trim();
    const url = String(body.url ?? "").trim();
    if (!jobId || !url) {
      return NextResponse.json({ error: "jobId and url are required" }, { status: 400 });
    }
    // Analysing the page spends credits, so viewers cannot do it.
    await resolveProjectAccess("search", jobId, user, "run");

    const { competitor } = await ensureLandingPageRecord(jobId, url);

    if (body.force || competitor.pageAnalysis?.status !== "completed") {
      await runBillable(
        {
          user,
          operation: "competitor.analyze_landing_page",
          projectKind: "search",
          projectId: jobId,
          runId: jobId,
        },
        () => analyzeCompetitorLandingPage(competitor.id),
      );
    }
    const latest = (await getCompetitor(competitor.id)) || competitor;
    return NextResponse.json({ page: pageView(latest, await getRecreationVersionCounts(jobId)) });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    console.error("[search/landing-recreate]", err);
    return errorResponse(err);
  }
}
