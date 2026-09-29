import { after } from "next/server";
import { NextResponse } from "next/server";
import { clearSearchJobSuppression, getCompetitorsByRun, getJob, saveJob } from "@/lib/db";
import { competitorForList } from "@/lib/competitorView";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { precheckRun, runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { runSearchOffersReportPhase } from "@/lib/pipeline/searchOffersReport";

export const runtime = "nodejs";

/** An offers report with no progress for this long is treated as lost. */
const OFFERS_STALE_MS = 15 * 60 * 1000;
export const maxDuration = 300;

/**
 * Start (or reuse) the offers dashboard for keyword-search competitors.
 * Body: { jobId, force?, refetchAds?, competitorIds?: string[] }
 * competitorIds — when provided, only analyze those competitors.
 * force = re-run offer analysis on stored ads for this run.
 * refetchAds = also re-pull ads from SociaVault (default false).
 * Returns immediately; poll /api/search/status while progress.stage === "analyzing_offers".
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const jobId = String(body.jobId ?? "").trim();
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required" }, { status: 400 });
    }

    // Viewers of a shared project cannot start paid analysis.
    resolveProjectAccess("search", jobId, user, "run");

    const precheck = precheckRun(user);
    if (!precheck.ok) {
      return NextResponse.json(
        {
          error: precheck.message,
          code: precheck.reason,
          availableSubunits: precheck.availableSubunits,
        },
        { status: precheck.reason === "suspended" ? 403 : 402 },
      );
    }

    const job = getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Search job not found" }, { status: 404 });
    }
    const competitors = getCompetitorsByRun(jobId);
    if (!competitors.length) {
      return NextResponse.json(
        { error: "No competitors found for this search run" },
        { status: 400 },
      );
    }

    // Already building: report that, unless it has gone quiet for so long that
    // the work was lost (e.g. the server restarted mid-report). Then allow a
    // fresh start rather than leaving the report stuck forever.
    const quietFor = Date.now() - Date.parse(job.updatedAt || "");
    if (job.progress.stage === "analyzing_offers" && !(quietFor > OFFERS_STALE_MS)) {
      return NextResponse.json({
        job,
        competitors: competitors.map(competitorForList),
        started: true,
      });
    }

    const force = Boolean(body.force);
    const refetchAds = Boolean(body.refetchAds);
    const competitorIds = Array.isArray(body.competitorIds)
      ? (body.competitorIds as unknown[])
          .map((id) => String(id || "").trim())
          .filter(Boolean)
      : null;

    if (competitorIds) {
      const allowed = new Set(competitors.map((c) => c.id));
      const selected = competitorIds.filter((id) => allowed.has(id));
      if (!selected.length) {
        return NextResponse.json(
          { error: "Select at least one competitor to analyze" },
          { status: 400 },
        );
      }
      job.offersCompetitorIds = selected;
    } else {
      job.offersCompetitorIds = null;
    }

    // A Stop pressed earlier (on this report, or anything else in the run)
    // leaves a stop flag that makes the offers phase exit at once. Clear it,
    // unless the competitor search itself is still running.
    if (job.status !== "running") clearSearchJobSuppression(jobId);

    const selectedCount = job.offersCompetitorIds?.length || competitors.length;
    job.progress = {
      ...job.progress,
      stopRequested: job.status !== "running" ? false : job.progress.stopRequested,
      stage: "analyzing_offers",
      offersPhase: "starting",
      offersDone: 0,
      offersTotal: Math.max(selectedCount, 1) + 3,
      offersPct: 2,
      offersCurrentName: null,
      message: refetchAds
        ? `Starting offers dashboard for ${selectedCount} competitor${selectedCount === 1 ? "" : "s"} (re-fetching ads)…`
        : `Starting offers dashboard for ${selectedCount} competitor${selectedCount === 1 ? "" : "s"}…`,
    };
    job.updatedAt = new Date().toISOString();
    saveJob(job);

    after(() => {
      // The run is charged to whoever pressed the button, even inside a project
      // shared by another user.
      void runBillable(
        {
          user,
          operation: "search.offers_report",
          projectKind: "search",
          projectId: jobId,
          runId: jobId,
        },
        () =>
          runSearchOffersReportPhase(jobId, {
            force,
            refetchAds,
            competitorIds: job.offersCompetitorIds || undefined,
          }),
      ).catch((err) => {
        const current = getJob(jobId);
        if (!current) return;
        current.progress = {
          ...current.progress,
          stage: "done",
          offersPhase: "failed",
          offersPct: 100,
          offersCurrentName: null,
          message: `Offers analysis failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
        current.offersReport = {
          status: "failed",
          createdAt: current.offersReport?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          adsAnalyzed: current.offersReport?.adsAnalyzed || 0,
          adCopy: current.offersReport?.adCopy || {
            uniqueCreatives: 0,
            creatives: [],
            uniqueOffers: [],
          },
          landingPages: current.offersReport?.landingPages || {
            uniqueUrls: 0,
            analyzed: 0,
            failed: 0,
            pages: [],
            uniqueOffers: [],
          },
        };
        saveJob(current);
      });
    });

    return NextResponse.json({
      job: getJob(jobId),
      competitors: competitors.map(competitorForList),
      started: true,
      chargedTo: user.username,
    });
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
