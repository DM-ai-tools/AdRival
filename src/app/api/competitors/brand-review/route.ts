import { NextResponse } from "next/server";
import { getCompetitor, getCompetitorsByRun, getJob } from "@/lib/db";
import {
  runBrandReviewForCompetitor,
  runBrandReviewForJob,
} from "@/lib/pipeline/brandReview";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/competitors/brand-review
 * Body: { runId?: string, competitorId?: string, force?: boolean }
 *
 * - competitorId → redo one competitor
 * - runId → batch brand review for the whole search run
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      runId?: string;
      competitorId?: string;
      force?: boolean;
    };

    if (body.competitorId) {
      const competitor = getCompetitor(body.competitorId);
      if (!competitor) {
        return NextResponse.json(
          { error: "Competitor not found" },
          { status: 404 },
        );
      }
      const brand = await runBrandReviewForCompetitor(competitor);
      const updated = getCompetitor(body.competitorId);
      return NextResponse.json({
        ok: true,
        mode: "single",
        competitorId: body.competitorId,
        brand,
        competitor: updated,
      });
    }

    if (body.runId) {
      const job = getJob(body.runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const result = await runBrandReviewForJob(body.runId, {
        force: body.force !== false,
      });
      return NextResponse.json({
        ok: true,
        mode: "batch",
        runId: body.runId,
        ...result,
        competitors: getCompetitorsByRun(body.runId),
        job: getJob(body.runId),
      });
    }

    return NextResponse.json(
      { error: "runId or competitorId is required" },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || "Brand review failed" },
      { status: 500 },
    );
  }
}
