import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { buildLookupWorkbook } from "@/lib/export/lookupExcel";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lookupId = searchParams.get("lookupId");
  if (!lookupId) {
    return NextResponse.json({ error: "lookupId is required" }, { status: 400 });
  }

  const job = getLookupJob(lookupId);
  if (!job) {
    return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
  }

  const ads = getLookupAds(lookupId);
  const buffer = await buildLookupWorkbook(job, ads);
  const safeName = (job.selectedPage?.name || job.queryName)
    .replace(/[^\w\-]+/g, "_")
    .slice(0, 40);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="lookup_${safeName}.xlsx"`,
    },
  });
}
