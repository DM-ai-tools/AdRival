import { NextResponse } from "next/server";
import { getAppSettings, getCompetitor, getIcp, getJob } from "@/lib/db";
import { listRecreationsForUser } from "@/lib/data/competitors";
import {
  countQueuedAhead,
  getRecreateJob,
  insertJob,
  listJobs,
  type RecreateJobOptions,
} from "@/lib/data/recreateJobs";
import { errorResponse, requireUser, resolveProjectAccess, type ProjectAccess } from "@/lib/authz";
import { TooManyConcurrentRunsError, runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { maskClientFacingText } from "@/lib/clientFacing";
import { analyzeCompetitorLandingPage } from "@/lib/pipeline/landingPageAnalysis";
import { createRecreationVersion, ensureLandingPageRecord } from "@/lib/pipeline/landingRecreateBridge";
import { icpBelongsToRun } from "@/lib/pipeline/awareness/icp";
import { isStyleDirection } from "@/lib/pipeline/skills/playbook";
import { dispatchRecreateQueue, sweepRecreateQueue } from "@/lib/pipeline/recreateQueue";
import { buildRecreateList, toJobDto, type RecreateRunInfo } from "@/lib/recreateList";
import { normalizeWebsite, runBusinessUrl, saveRunBusinessUrl } from "@/lib/runBusinessUrl";
import type { CompetitorRecord } from "@/lib/types";

export const runtime = "nodejs";
/** Adding a page may analyse it first (a few minutes at most); the build itself runs in the queue. */
export const maxDuration = 300;

/**
 * Requests being added right now, by user, source page and details, so a
 * double click cannot pass the duplicate check twice before either job is
 * saved. Kept on globalThis like the queue's own state (one copy per process).
 */
const ADDING_KEY = "__adrivalRecreateAdding";
function addingNow(): Set<string> {
  const g = globalThis as typeof globalThis & { [ADDING_KEY]?: Set<string> };
  return (g[ADDING_KEY] ??= new Set<string>());
}

function json(body: unknown, status: number) {
  return NextResponse.json(body, { status });
}

/**
 * The page a version was made from: every version of a page is made from the
 * analysed page itself, so adding "again" from a version means the same page.
 */
async function rootOf(record: CompetitorRecord): Promise<CompetitorRecord> {
  let current = record;
  for (let hops = 0; hops < 5; hops += 1) {
    const parentId = current.recreateOnly?.variantOf;
    if (!parentId) break;
    const parent = await getCompetitor(parentId);
    if (!parent || parent.runId !== current.runId) break;
    current = parent;
  }
  return current;
}

/**
 * What makes two requests "the same": the business website, the look (no
 * choice = the default "brand"), the notes (spacing ignored) and the reader.
 */
function optionsKey(options: RecreateJobOptions): string {
  return JSON.stringify([
    options.businessUrl.toLowerCase(),
    options.styleDirection ?? "brand",
    (options.userFeedback ?? "").replace(/\s+/g, " ").trim(),
    options.targetIcp?.icpId ?? null,
  ]);
}

/** Whether the user already has this source page with these details queued or running. */
async function hasActiveDuplicate(
  ownerUserId: string,
  spaceId: string | null,
  source: CompetitorRecord,
  key: string,
): Promise<boolean> {
  const active = (await listJobs(ownerUserId, spaceId)).filter(
    (j) => (j.status === "queued" || j.status === "running") && j.runId === source.runId && optionsKey(j.options) === key,
  );
  for (const job of active) {
    const version = await getCompetitor(job.competitorId);
    if ((version?.recreateOnly?.variantOf ?? job.competitorId) === source.id) return true;
  }
  return false;
}

/**
 * Add a page to the Recreate queue: POST { competitorId } or { jobId, url }
 * (a landing page of a search's offers dashboard), plus { businessUrl?,
 * styleDirection?, userFeedback?, icpId? }. Analyses the page first when it
 * has not been analysed (billed as before), makes a new version of it and
 * queues the build, which starts now when a slot is free. The build is billed
 * when it starts, by the queue. → 202 { job, queuedAhead }.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as Record<string, unknown>;
    const competitorId = String(body.competitorId ?? "").trim();
    const runId = String(body.jobId ?? "").trim();
    const url = String(body.url ?? "").trim();
    if (!competitorId && !(runId && url)) {
      return json({ error: "competitorId, or jobId and url, are required" }, 400);
    }

    // Access first (a build spends credits, so viewers cannot add one), then the page.
    let source: CompetitorRecord;
    let access: ProjectAccess;
    if (competitorId) {
      const found = await getCompetitor(competitorId);
      if (!found) return json({ error: "Competitor not found" }, 404);
      access = await resolveProjectAccess("search", found.runId, user, "run");
      source = await rootOf(found);
    } else {
      access = await resolveProjectAccess("search", runId, user, "run");
      source = (await ensureLandingPageRecord(runId, url)).competitor;
    }

    // Every detail is fixed now: a queued job starts with nobody present.
    let targetIcp: RecreateJobOptions["targetIcp"] = null;
    if (body.icpId !== undefined && body.icpId !== null && body.icpId !== "") {
      const icp = await getIcp(String(body.icpId));
      if (!icp || !icpBelongsToRun(icp, source.runId)) {
        return json({ error: "That audience profile was not found for this search." }, 400);
      }
      targetIcp = { icpId: icp.id, stage: icp.stage };
    }
    const savedUrl = await runBusinessUrl(source.runId);
    let businessUrl = savedUrl;
    if (typeof body.businessUrl === "string" && body.businessUrl.trim()) {
      businessUrl = normalizeWebsite(body.businessUrl);
      if (!businessUrl) return json({ error: "Enter a website address, like yourbusiness.com" }, 400);
    }
    if (!businessUrl) {
      return json(
        { error: "Add your business website so the page can use your brand.", code: "business_url_required" },
        400,
      );
    }
    const options: RecreateJobOptions = {
      businessUrl,
      styleDirection: isStyleDirection(body.styleDirection) ? body.styleDirection : null,
      userFeedback: typeof body.userFeedback === "string" ? body.userFeedback.trim().slice(0, 4000) || null : null,
      targetIcp,
    };

    const key = optionsKey(options);
    const spaceId = access.project.spaceId ?? null;
    const adding = addingNow();
    const addingKey = JSON.stringify([user.id, source.id, key]);
    const inProgress = () =>
      json({ error: "This page is already in progress with these details.", code: "already_in_progress" }, 409);
    if (adding.has(addingKey)) return inProgress();
    adding.add(addingKey);
    let jobId: string;
    try {
      if (await hasActiveDuplicate(user.id, spaceId, source, key)) return inProgress();

      if (source.pageAnalysis?.status !== "completed") {
        await runBillable(
          {
            user,
            operation: "competitor.analyze_landing_page",
            projectKind: "search",
            projectId: source.runId,
            runId: source.runId,
          },
          () => analyzeCompetitorLandingPage(source.id),
        );
        source = (await getCompetitor(source.id)) || source;
        if (source.pageAnalysis?.status !== "completed") {
          return json(
            {
              error:
                maskClientFacingText(source.pageAnalysis?.error) ||
                "This page could not be analysed, so it cannot be recreated.",
            },
            422,
          );
        }
      }

      if (businessUrl !== savedUrl) await saveRunBusinessUrl(source.runId, businessUrl);
      const version = await createRecreationVersion(source);
      jobId = (
        await insertJob({ ownerUserId: user.id, competitorId: version.id, runId: source.runId, spaceId, options })
      ).id;
    } finally {
      adding.delete(addingKey);
    }

    // Starts it now when a slot is free; otherwise it waits its turn.
    await dispatchRecreateQueue(user.id).catch((err: unknown) =>
      console.error("[recreate/jobs] could not start the queue", err),
    );
    const job = await getRecreateJob(jobId);
    if (!job) return json({ error: "The recreation could not be added." }, 500);
    return json({ job: toJobDto(job), queuedAhead: job.status === "queued" ? await countQueuedAhead(job.id) : 0 }, 202);
  } catch (err) {
    if (isCreditError(err)) {
      return json({ error: (err as Error).message, code: (err as { code?: string }).code }, 402);
    }
    if (err instanceof TooManyConcurrentRunsError) {
      return json({ error: err.message, code: err.code }, 429);
    }
    if (!(err instanceof Error && err.name === "HttpError")) console.error("[recreate/jobs]", err);
    return errorResponse(err);
  }
}

/**
 * The user's recreations in one client space (?spaceId=; none = runs with no
 * space): queue jobs and recreated pages, newest first, with the recreate limit.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const spaceId = (searchParams.get("spaceId") || "").trim() || null;

    // Picks the queue up (builds to follow again, queued jobs to start); the list does not depend on it.
    await sweepRecreateQueue(user.id).catch((err: unknown) =>
      console.error("[recreate/jobs] queue sweep failed", err),
    );

    const [jobs, pages, settings] = await Promise.all([
      listJobs(user.id, spaceId),
      listRecreationsForUser(user.id, spaceId),
      getAppSettings(),
    ]);
    // A job's version without a page yet (queued), or on a run another user owns.
    const known = new Set(pages.map((p) => p.id));
    const missing = [...new Set(jobs.map((j) => j.competitorId))].filter((id) => !known.has(id));
    const versions = (await Promise.all(missing.map((id) => getCompetitor(id)))).filter(
      (c): c is CompetitorRecord => Boolean(c),
    );
    const records = [...pages, ...versions];

    // The run tells the business and keyword of a job whose page is not built yet.
    const unbuilt = new Set(versions.filter((v) => !v.recreatedPage).map((v) => v.id));
    const runIds = [...new Set(jobs.filter((j) => unbuilt.has(j.competitorId)).map((j) => j.runId))];
    const runs = new Map<string, RecreateRunInfo>();
    for (const run of await Promise.all(runIds.map((id) => getJob(id)))) {
      if (run) runs.set(run.id, { keyword: run.keyword || null, businessName: run.businessProfile?.businessName || null });
    }

    return NextResponse.json({
      // Settings saved before the field existed have no value.
      limit: settings.maxConcurrentRecreationsPerUser ?? 3,
      items: buildRecreateList({ jobs, records, runs, now: new Date() }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
