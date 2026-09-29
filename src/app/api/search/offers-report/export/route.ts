import { NextResponse } from "next/server";
import { getJob, getSearchCompetitorAdsByRun } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { buildOffersWorkbook, type OffersExportPart } from "@/lib/export/offersExcel";
import { offerFitsSearchedService, searchedServiceFocus } from "@/lib/pipeline/offerServiceFocus";

export const runtime = "nodejs";

const PARTS: OffersExportPart[] = ["all", "ads", "creatives", "ladders", "pages"];
const PART_NAME: Record<OffersExportPart, string> = {
  all: "offers-report",
  ads: "ads-by-competitor",
  creatives: "creatives-and-offers",
  ladders: "offer-ladders",
  pages: "landing-pages",
};

/**
 * Excel download of a keyword search's offers dashboard.
 * ?jobId=…&part=all|ads|creatives|ladders|pages
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get("jobId") || "";
    const partParam = (searchParams.get("part") || "all") as OffersExportPart;
    const part = PARTS.includes(partParam) ? partParam : "all";
    if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

    // Downloads are authorized like any other read.
    resolveProjectAccess("search", jobId, user, "view");
    const job = getJob(jobId);
    if (!job) return NextResponse.json({ error: "Search not found" }, { status: 404 });
    const report = job.offersReport;
    if (!report || report.status !== "completed") {
      return NextResponse.json({ error: "Generate the offers dashboard first." }, { status: 409 });
    }

    const keywords = job.keywords?.length ? job.keywords : job.keyword ? [job.keyword] : [];
    const focus = searchedServiceFocus(keywords, job.selectedCategory?.label || null);
    const selected = job.offersCompetitorIds?.length ? new Set(job.offersCompetitorIds) : null;
    // The same ads the dashboard shows: the chosen competitors, on the searched service.
    const ads = getSearchCompetitorAdsByRun(jobId)
      .filter((ad) => !selected || selected.has(ad.competitorId))
      .filter((ad) => offerFitsSearchedService(`${ad.title || ""} ${ad.body || ""} ${ad.ctaText || ""}`, focus))
      .map((ad) => ({ ...ad, competitorName: ad.pageName }));

    const buffer = await buildOffersWorkbook({
      title: `Competitor offers — ${job.keyword}`,
      subtitle: [job.selectedCategory?.label, job.geo].filter(Boolean).join(" · "),
      platform: job.platform ?? null,
      report,
      ads,
      focus,
      part,
    });
    const safe = (job.keyword || "search").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 50);
    const filename = `${PART_NAME[part]}-${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
