import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { buildCompetitorsWorkbook } from "@/lib/export/excel";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
  // Downloads are authorized like any other read — a known jobId is not enough.
  const user = await requireUser();
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  resolveProjectAccess("search", jobId, user, "view");

  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const competitors = getCompetitorsByRun(jobId);
  const buffer = await buildCompetitorsWorkbook(job, competitors);
  const safeKeyword = job.keyword.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const date = new Date().toISOString().slice(0, 10);
  const filename = `competitors-${safeKeyword}-${date}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
  } catch (err) {
    return errorResponse(err);
  }
}
