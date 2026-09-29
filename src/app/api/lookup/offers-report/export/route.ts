import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { buildOffersWorkbook, type OffersExportPart } from "@/lib/export/offersExcel";

export const runtime = "nodejs";

const PARTS: OffersExportPart[] = ["all", "ads", "creatives", "ladders", "pages"];

/**
 * Excel download of a competitor lookup's offers dashboard.
 * ?lookupId=…&part=all|ads|creatives|ladders|pages
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const lookupId = searchParams.get("lookupId") || "";
    const partParam = (searchParams.get("part") || "all") as OffersExportPart;
    const part = PARTS.includes(partParam) ? partParam : "all";
    if (!lookupId) return NextResponse.json({ error: "lookupId is required" }, { status: 400 });

    resolveProjectAccess("lookup", lookupId, user, "view");
    const job = getLookupJob(lookupId);
    if (!job) return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    const report = job.offersReport;
    if (!report || report.status !== "completed") {
      return NextResponse.json({ error: "Generate the offers dashboard first." }, { status: 409 });
    }

    const brand = job.selectedPage?.name || job.queryName;
    const buffer = await buildOffersWorkbook({
      title: `Competitor offers — ${brand}`,
      subtitle: "",
      platform: job.platform ?? null,
      report,
      ads: getLookupAds(lookupId).map((ad) => ({ ...ad, competitorName: ad.pageName || brand })),
      // The lookup dashboard shows the whole report, without a service filter.
      focus: null,
      part,
    });
    const safe = (brand || "lookup").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 50);
    const filename = `offers-${part === "all" ? "report" : part}-${safe}-${new Date().toISOString().slice(0, 10)}.xlsx`;
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
