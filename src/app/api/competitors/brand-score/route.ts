import { NextResponse } from "next/server";
import { getCompetitor, getCompetitorsByRun, getJob, updateCompetitor } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { applyBrandScoresForJob, withBrandScore } from "@/lib/pipeline/brandScore";

export const runtime = "nodejs";

/**
 * POST /api/competitors/brand-score
 * Body: { runId?: string, competitorId?: string }
 *
 * Recomputes brand scores from follower and size metrics already on the record.
 * Does not run brand review or spend scrape credits.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      runId?: string;
      competitorId?: string;
    };

    if (body.competitorId) {
      const competitor = getCompetitor(body.competitorId);
      if (!competitor) {
        return NextResponse.json({ error: "Competitor not found" }, { status: 404 });
      }
      resolveProjectAccess("search", competitor.runId, user, "run");
      const updated = updateCompetitor(competitor.id, {
        brand: withBrandScore(competitor.brand || {}),
      });
      return NextResponse.json({
        ok: true,
        mode: "single",
        competitor: updated,
      });
    }

    if (body.runId) {
      resolveProjectAccess("search", body.runId, user, "run");
      if (!getJob(body.runId)) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const result = applyBrandScoresForJob(body.runId);
      return NextResponse.json({
        ok: true,
        mode: "batch",
        runId: body.runId,
        ...result,
        competitors: getCompetitorsByRun(body.runId),
      });
    }

    return NextResponse.json(
      { error: "runId or competitorId is required" },
      { status: 400 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
