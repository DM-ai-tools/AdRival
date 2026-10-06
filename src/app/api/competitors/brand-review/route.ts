import { after, NextResponse } from "next/server";
import {
  clearSearchJobSuppression,
  getCompetitor,
  getCompetitorsByRun,
  getJob,
  saveJob,
  updateJob,
} from "@/lib/db";
import { competitorForList } from "@/lib/competitorView";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { precheckRun, runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import {
  runBrandReviewForCompetitor,
  isBrandReviewRunning,
  markBrandReviewRunning,
  markBrandReviewStopped,
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
        competitor: updated && competitorForList(updated),
      });
    }

    if (body.runId) {
      resolveProjectAccess("search", body.runId, user, "run");
      const job = getJob(body.runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const runId = body.runId;
      // Refuse an unfunded run before anything starts, as the synchronous
      // version did through runBillable.
      const precheck = precheckRun(user);
      if (!precheck.ok) {
        return NextResponse.json(
          { error: precheck.message, code: precheck.reason },
          { status: precheck.reason === "suspended" ? 403 : 402 },
        );
      }
      // Already running in this app: follow it. A saved "brand_review" stage
      // with nothing running was interrupted by a restart and starts again.
      if (job.progress.stage === "brand_review" && isBrandReviewRunning(runId)) {
        return NextResponse.json({ ok: true, mode: "batch", runId, started: true, job });
      }
      markBrandReviewRunning(runId);
      // A batch takes minutes, longer than a request may stay open, so it runs
      // in the background and the panel follows it through the status poll.
      // The stage is set before replying so the first poll already sees it.
      // Like runBrandReviewForJob, a new batch clears an earlier Stop.
      clearSearchJobSuppression(runId);
      job.progress = {
        ...job.progress,
        stopRequested: false,
        stage: "brand_review",
        brandReviewDone: 0,
        brandReviewTotal: getCompetitorsByRun(runId).length,
        brandReviewCurrentName: null,
        message: "Brand review starting…",
      };
      job.updatedAt = new Date().toISOString();
      saveJob(job);
      after(() =>
        runBillable(
          {
            user,
            operation: "search.brand_review_batch",
            projectKind: "search",
            projectId: runId,
            runId,
          },
          () => runBrandReviewForJob(runId, { force: body.force !== false }),
        ).catch((err) => {
          markBrandReviewStopped(runId);
          console.error("[brand-review] batch failed", err);
          const current = getJob(runId);
          updateJob(runId, {
            progress: {
              ...(current?.progress ?? job.progress),
              stage: "done",
              brandReviewCurrentName: null,
              message: `Brand review failed: ${(err as Error).message}`,
            },
          });
        }),
      );
      return NextResponse.json({ ok: true, mode: "batch", runId, started: true, job: getJob(runId) });
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
