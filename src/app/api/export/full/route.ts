import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, getRecreateOnlyPagesByRun, getSearchCompetitorAdsByRun } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { buildFullReportWorkbook } from "@/lib/export/fullReportExcel";
import { offerFitsSearchedService, searchedServiceFocus } from "@/lib/pipeline/offerServiceFocus";

export const runtime = "nodejs";

/** The app's public address for links in the file (behind Railway's proxy too). */
function siteOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim().replace(/\/$/, "");
  if (configured && !/localhost|127\.0\.0\.1/.test(configured)) return configured;
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(request.url).origin;
}

/**
 * Excel download of a whole search run: the client's website, the search,
 * competitors, landing page analyses, the offers dashboard and recreated
 * pages, one sheet each. GET ?jobId=…
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const jobId = new URL(request.url).searchParams.get("jobId") || "";
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

    // Downloads are authorized like any other read.
    resolveProjectAccess("search", jobId, user, "view");
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: "Search not found" }, { status: 404 });

    // The same ads the offers dashboard shows: the chosen competitors, on the searched service.
    const keywords = job.keywords?.length ? job.keywords : job.keyword ? [job.keyword] : [];
    const focus = searchedServiceFocus(keywords, job.selectedCategory?.label || null);
    const selected = job.offersCompetitorIds?.length ? new Set(job.offersCompetitorIds) : null;
    const offerAds = job.offersReport?.status === "completed"
      ? getSearchCompetitorAdsByRun(jobId)
          .filter((ad) => !selected || selected.has(ad.competitorId))
          .filter((ad) => offerFitsSearchedService(`${ad.title || ""} ${ad.body || ""} ${ad.ctaText || ""}`, focus))
          .map((ad) => ({ ...ad, competitorName: ad.pageName }))
      : [];

    const buffer = await buildFullReportWorkbook({
      job,
      competitors: getCompetitorsByRun(jobId),
      recreateOnly: getRecreateOnlyPagesByRun(jobId),
      offerAds,
      focus,
      origin: siteOrigin(request),
    });
    const name = (job.businessProfile?.businessName || job.keyword || "search")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
      .slice(0, 50);
    const filename = `full-report-${name}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
