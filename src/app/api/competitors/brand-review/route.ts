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
  BrandReviewStopped,
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
      const competitor = await getCompetitor(body.competitorId);
      if (!competitor) {
        return NextResponse.json(
          { error: "Competitor not found" },
          { status: 404 },
        );
      }
      await resolveProjectAccess("search", competitor.runId, user, "run");

      let brand;
      try {
        brand = await runBillable(
          {
            user,
            operation: "competitor.brand_review",
            projectKind: "search",
            projectId: competitor.runId,
            runId: competitor.runId,
          },
          // Stops on the Stop button, or when the page stops waiting.
          () => runBrandReviewForCompetitor(competitor, { signal: request.signal }),
        );
      } catch (err) {
        if (err instanceof BrandReviewStopped) {
          return NextResponse.json({ ok: true, mode: "single", competitorId: body.competitorId, stopped: true });
        }
        throw err;
      }
      const updated = await getCompetitor(body.competitorId);
      return NextResponse.json({
        ok: true,
        mode: "single",
        competitorId: body.competitorId,
        brand,
        competitor: updated && competitorForList(updated),
      });
    }

    if (body.runId) {
      await resolveProjectAccess("search", body.runId, user, "run");
      const job = await getJob(body.runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const runId = body.runId;
      // Refuse an unfunded run before anything starts, as the synchronous
      // version did through runBillable.
      const precheck = await precheckRun(user);
      if (!precheck.ok) {
        return NextResponse.json(
          { error: precheck.message, code: precheck.reason },
          { status: precheck.reason === "suspended" ? 403 : 402 },
        );
      }
      // Already running in this app (a batch, or another request starting
      // one): follow it. The in-process mark decides, not the saved stage: a
      // request that read the run before the other one saved its stage would
      // otherwise start a second paid batch. A saved "brand_review" stage with
      // nothing marked was interrupted by a restart and starts again.
      if (isBrandReviewRunning(runId)) {
        return NextResponse.json({ ok: true, mode: "batch", runId, started: true, job });
      }
      // Checked and marked with no await in between, so two requests cannot
      // both start a batch.
      markBrandReviewRunning(runId);
      try {
        // A batch takes minutes, longer than a request may stay open, so it runs
        // in the background and the panel follows it through the status poll.
        // The stage is set before replying so the first poll already sees it.
        // Like runBrandReviewForJob, a new batch clears an earlier Stop.
        const competitorCount = (await getCompetitorsByRun(runId)).length;
        await clearSearchJobSuppression(runId);
        job.progress = {
          ...job.progress,
          stopRequested: false,
          stage: "brand_review",
          brandReviewDone: 0,
          brandReviewTotal: competitorCount,
          brandReviewCurrentName: null,
          message: "Brand review starting…",
        };
        job.updatedAt = new Date().toISOString();
        await saveJob(job);
      } catch (err) {
        // Nothing was started: do not leave the run marked as reviewing.
        markBrandReviewStopped(runId);
        throw err;
      }
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
        ).catch(async (err: unknown) => {
          markBrandReviewStopped(runId);
          console.error("[brand-review] batch failed", err);
          try {
            const current = await getJob(runId);
            await updateJob(runId, {
              progress: {
                ...(current?.progress ?? job.progress),
                stage: "done",
                brandReviewCurrentName: null,
                message: `Brand review failed: ${(err as Error).message}`,
              },
            });
          } catch (writeErr) {
            console.error(`[brand-review] could not record the failure on ${runId}:`, writeErr);
          }
        }),
      );
      return NextResponse.json({ ok: true, mode: "batch", runId, started: true, job: await getJob(runId) });
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
