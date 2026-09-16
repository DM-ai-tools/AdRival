import { NextResponse } from "next/server";
import { getCompetitor, getCompetitorsByRun, getJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
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
    const user = await requireUser();
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
      resolveProjectAccess("search", competitor.runId, user, "run");

      const brand = await runBillable(
        {
          user,
          operation: "competitor.brand_review",
          projectKind: "search",
          projectId: competitor.runId,
          runId: competitor.runId,
        },
        () => runBrandReviewForCompetitor(competitor),
      );
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
      resolveProjectAccess("search", body.runId, user, "run");
      const job = getJob(body.runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const runId = body.runId;
      const result = await runBillable(
        {
          user,
          operation: "search.brand_review_batch",
          projectKind: "search",
          projectId: runId,
          runId,
        },
        () => runBrandReviewForJob(runId, { force: body.force !== false }),
      );
      return NextResponse.json({
        ok: true,
        mode: "batch",
        runId,
        ...result,
        competitors: getCompetitorsByRun(runId),
        job: getJob(runId),
      });
    }

    return NextResponse.json(
      { error: "runId or competitorId is required" },
      { status: 400 },
    );
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
