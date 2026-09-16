import { NextResponse } from "next/server";
import {
  deleteHistoryRun,
  deleteLookupHistoryRun,
  getCompetitorsByRun,
  getJob,
  getLookupAds,
  getLookupJob,
  getProjectSpace,
  listProjects,
} from "@/lib/db";
import {
  errorResponse,
  HttpError,
  listVisibleProjects,
  requireUser,
  resolveProjectAccess,
} from "@/lib/authz";
import { reportRunCredits } from "@/lib/accounting/run";
import { maskClientFacingText, maskPageAnalysis } from "@/lib/clientFacing";
import { listUnifiedHistory } from "@/lib/historyUnified";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");
    const kind = searchParams.get("kind");

    if (runId && kind === "lookup") {
      resolveProjectAccess("lookup", runId, user, "view");
      const job = getLookupJob(runId);
      if (!job) {
        return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
      }
      return NextResponse.json({
        kind: "lookup",
        job: {
          ...job,
          error: maskClientFacingText(job.error),
          offersReport: job.offersReport
            ? {
                ...job.offersReport,
                error: maskClientFacingText(job.offersReport.error),
              }
            : job.offersReport,
          progress: job.progress
            ? {
                ...job.progress,
                message: maskClientFacingText(job.progress.message) || "",
              }
            : job.progress,
        },
        ads: getLookupAds(runId).map((ad) => ({
          ...ad,
          pageAnalysis: maskPageAnalysis(ad.pageAnalysis),
        })),
        // Credits the caller spent on this run — never the owner's balance.
        credits: reportRunCredits(user.id, runId),
      });
    }

    if (runId && kind === "search") {
      resolveProjectAccess("search", runId, user, "view");
      const job = getJob(runId);
      if (!job) {
        return NextResponse.json({ error: "Search not found" }, { status: 404 });
      }
      return NextResponse.json({
        kind: "search",
        job: {
          ...job,
          error: maskClientFacingText(job.error),
          offersReport: job.offersReport
            ? {
                ...job.offersReport,
                error: maskClientFacingText(job.offersReport.error),
              }
            : job.offersReport,
          progress: job.progress
            ? {
                ...job.progress,
                message: maskClientFacingText(job.progress.message) || "",
              }
            : job.progress,
        },
        competitors: getCompetitorsByRun(runId).map((competitor) => ({
          ...competitor,
          pageAnalysis: maskPageAnalysis(competitor.pageAnalysis),
        })),
        credits: reportRunCredits(user.id, runId),
      });
    }

    // Only projects the caller owns or that were explicitly shared with them.
    // Legacy rows with no owner are excluded until an admin assigns them.
    const visible = new Map(
      listVisibleProjects(user).map((p) => [`${p.kind}:${p.id}`, p]),
    );
    const runs = listUnifiedHistory()
      .map((run) => {
        const project = visible.get(`${run.kind}:${run.id}`);
        if (!project) return null;
        return {
          ...run,
          accessRole: project.accessRole,
          ownerDisplayName:
            project.accessRole === "owner" ? null : project.ownerDisplayName,
          spaceId: project.spaceId ?? null,
          clientName: project.spaceId
            ? getProjectSpace(project.spaceId)?.clientName ?? null
            : null,
        };
      })
      .filter((run): run is NonNullable<typeof run> => run !== null);
    return NextResponse.json({ runs });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Deletions are always scoped to what the caller owns. */
export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all");
    const runId = searchParams.get("runId");
    const kind = searchParams.get("kind");

    if (all === "1" || all === "true") {
      const owned = listProjects({ ownerUserId: user.id });
      let removedSearchRuns = 0;
      let removedLookupRuns = 0;
      for (const project of owned) {
        if (project.kind === "search") {
          deleteHistoryRun(project.id);
          removedSearchRuns += 1;
        } else {
          deleteLookupHistoryRun(project.id);
          removedLookupRuns += 1;
        }
      }
      return NextResponse.json({ ok: true, removedSearchRuns, removedLookupRuns });
    }

    if (!runId || !kind) {
      return NextResponse.json(
        { error: "runId and kind are required (or all=1)" },
        { status: 400 },
      );
    }
    if (kind !== "search" && kind !== "lookup") {
      throw new HttpError(400, "kind must be 'search' or 'lookup'");
    }

    resolveProjectAccess(kind, runId, user, "edit");

    if (kind === "lookup") {
      const result = deleteLookupHistoryRun(runId);
      if (!result.ok) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({
        ok: true,
        kind,
        runId,
        removedAds: result.removedAds,
      });
    }

    const result = deleteHistoryRun(runId);
    if (!result.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      kind: "search",
      runId,
      removedCompetitors: result.removedCompetitors,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
