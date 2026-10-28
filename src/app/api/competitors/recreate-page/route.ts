import { NextResponse } from "next/server";
import { getCompetitor, getIcp, getJob, getRecreatedPage, updateCompetitor } from "@/lib/db";
import { ArchivedPageUnavailableError } from "@/lib/data/archive";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import type { AwarenessStage, CompetitorRecord, RecreatedPageLight } from "@/lib/types";
import { sanitizeClientFacingText, maskRecreatedPage, maskPageAnalysis } from "@/lib/clientFacing";
import { isStyleDirection } from "@/lib/pipeline/skills/playbook";
import {
  cleanScreenshots,
  editManusRecreation,
  isManusRunActive,
  isReadingWebsite,
  expireStaleReading,
  resumeManusRecreation,
  runManusRecreation,
  stopManusRecreation,
  undoManusChange,
} from "@/lib/pipeline/manus/run";
import { cleanAssets } from "@/lib/pipeline/manus/assets";
import { shouldReuseCachedPage } from "@/lib/pipeline/manus/reuse";
import { icpBelongsToRun } from "@/lib/pipeline/awareness/icp";
import { normalizeWebsite, saveRunBusinessUrl } from "@/lib/runBusinessUrl";
import { withoutVersionProfile } from "@/lib/competitorView";

export const runtime = "nodejs";
/** A design-agent build runs well past 10 minutes; it continues after the reply. */
export const maxDuration = 1800;

/** Actions of the earlier built-in pipeline (content review, image slots, colour refresh). */
const RETIRED_ACTIONS = new Set([
  "save_content",
  "update_intent",
  "approve_content",
  "accept_proposal",
  "discard_proposal",
  "undo_content",
  "confirm_fact",
  "regenerate_section",
  "refresh_brand_colors",
  "regenerate_image",
  "generate_missing_images",
]);

/** Every action that builds the whole page. */
const BUILD_ACTIONS = new Set([
  "generate_page",
  "generate_content",
  "regenerate_page",
  "regenerate_content",
  "approve_and_build",
  "build_design",
  "regenerate_design",
  "revise_page",
]);

/** The client's website and name for a competitor's run, if the run has one. */
async function brandFor(runId: string): Promise<{ businessUrl: string | null; businessName: string | null }> {
  const job = await getJob(runId);
  const url = (job?.businessUrl || job?.businessProfile?.url || "").trim();
  return {
    businessUrl: url ? normalizeWebsite(url) : null,
    businessName: job?.businessProfile?.businessName || null,
  };
}

/**
 * A page build takes many minutes, longer than the hosting proxy keeps a
 * request open (it answers "upstream error" and the build result is lost).
 * The build runs on after the response; the page follows it by polling.
 * Errors that happen straight away (credits, missing analysis) still come
 * back on this response.
 */
async function startBuild(
  competitorId: string,
  work: () => Promise<CompetitorRecord>,
): Promise<NextResponse> {
  const run = work();
  const early = await Promise.race([
    run.then(
      (competitor) => ({ competitor }),
      (error: unknown) => ({ error }),
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
  ]);
  if (early && "error" in early) throw early.error;
  if (early) {
    return NextResponse.json({ competitor: maskCompetitor(await withContentIfReadable(early.competitor)), cached: false });
  }
  void run.catch(async (err: unknown) => {
    // The run saves its own failure on the page; this only covers a crash before it could.
    console.error("[competitors/recreate-page] background build failed", err);
    try {
      const latest = await getCompetitor(competitorId);
      const page = latest?.recreatedPage;
      if (page && (page.status === "pending" || page.status === "design_pending")) {
        // A light page: the stored content is kept as it is.
        await updateCompetitor(competitorId, {
          recreatedPage: {
            ...page,
            status: (await hasStoredHtml(competitorId, page)) ? "completed" : "failed",
            error: sanitizeClientFacingText((err as Error)?.message || "Recreation failed"),
            updatedAt: new Date().toISOString(),
            progress: page.progress ? { ...page.progress, phase: "failed", message: "Recreation failed" } : page.progress,
          },
        });
      }
    } catch (writeErr) {
      console.error("[competitors/recreate-page] could not record the failed build", writeErr);
    }
  });
  const latest = await getCompetitor(competitorId);
  return NextResponse.json(
    { competitor: latest ? maskCompetitor(await withContentIfReadable(latest)) : null, cached: false, inFlight: true },
    { status: 202 },
  );
}

/** Shown when a page's archived content cannot be read (Storage unreachable or the file is damaged). */
const ARCHIVE_UNAVAILABLE = "This archived page could not be loaded, try again";

function archiveUnavailableResponse(): NextResponse {
  return NextResponse.json({ error: ARCHIVE_UNAVAILABLE, code: "archive_unavailable" }, { status: 503 });
}

/** The HTML and Undo copy the browser shows; the rest of the stored content stays on the server. */
type PageContent = { html: string | null; previousHtml: string | null };
type CompetitorWithContent = Omit<CompetitorRecord, "recreatedPage"> & {
  recreatedPage?: (RecreatedPageLight & Partial<PageContent>) | null;
};

/** The page's stored HTML and Undo copy, or null without content. Throws ArchivedPageUnavailableError. */
async function pageContent(competitorId: string): Promise<PageContent | null> {
  const heavy = await getRecreatedPage(competitorId);
  return heavy ? { html: heavy.html ?? null, previousHtml: heavy.previousHtml ?? null } : null;
}

/** The competitor with its page's HTML and Undo copy (read separately from the light row). */
async function withContent(
  competitor: CompetitorRecord,
  content?: PageContent | null,
): Promise<CompetitorWithContent> {
  if (!competitor.recreatedPage) return competitor;
  const loaded = content === undefined ? await pageContent(competitor.id) : content;
  return loaded ? { ...competitor, recreatedPage: { ...competitor.recreatedPage, ...loaded } } : competitor;
}

/**
 * withContent for replies to an action that already happened (stop, undo, a
 * build started): an unreadable archive sends the page without its HTML
 * rather than reporting the action as failed.
 */
async function withContentIfReadable(competitor: CompetitorRecord): Promise<CompetitorWithContent> {
  try {
    return await withContent(competitor);
  } catch (err) {
    if (!(err instanceof ArchivedPageUnavailableError)) throw err;
    console.warn(`[competitors/recreate-page] page content of ${competitor.id} unavailable:`, err.message);
    return competitor;
  }
}

/** Whether the page has finished HTML; an unreadable archive counts as the marker says. */
async function hasStoredHtml(competitorId: string, page: RecreatedPageLight): Promise<boolean> {
  try {
    return Boolean((await pageContent(competitorId))?.html);
  } catch (err) {
    if (!(err instanceof ArchivedPageUnavailableError)) throw err;
    return page.hasPage;
  }
}

/**
 * The page as the browser gets it: the stored previous version (kept for
 * Undo) is replaced by a flag, so polling does not send the page twice.
 * `light` (status polling, content not read) leaves the flag out, so the
 * browser keeps the one it has.
 */
function pageForClient<T extends { previousHtml?: string | null } | null | undefined>(
  page: T,
  options: { light?: boolean } = {},
): T {
  if (!page) return page;
  const { previousHtml, ...rest } = page;
  // The design agent's task state (ids, answer context) stays on the server.
  delete (rest as { manus?: unknown }).manus;
  // So does the id of a website read in progress.
  delete (rest as { readingId?: unknown }).readingId;
  if (options.light) return rest as unknown as T;
  return { ...rest, canUndo: Boolean(previousHtml) } as unknown as T;
}

function maskCompetitor<T extends {
  recreatedPage?: unknown;
  pageAnalysis?: unknown;
  recreateOnly?: CompetitorRecord["recreateOnly"];
}>(competitor: T, options: { light?: boolean } = {}): T {
  return {
    // A version's own business profile stays on the server.
    ...withoutVersionProfile(competitor),
    recreatedPage: pageForClient(
      maskRecreatedPage((competitor.recreatedPage ?? null) as Parameters<typeof maskRecreatedPage>[0]) as { previousHtml?: string | null } | null,
      options,
    ),
    pageAnalysis: maskPageAnalysis(
      (competitor.pageAnalysis ?? null) as Parameters<typeof maskPageAnalysis>[0],
    ),
  };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const competitorId = String(body.competitorId ?? "").trim();
    if (!competitorId) {
      return NextResponse.json(
        { error: "competitorId is required" },
        { status: 400 },
      );
    }

    const existing = await getCompetitor(competitorId);
    if (!existing) {
      return NextResponse.json(
        { error: "Competitor not found" },
        { status: 404 },
      );
    }

    const userFeedback =
      typeof body.userFeedback === "string"
        ? body.userFeedback.trim().slice(0, 4000)
        : "";
    // Screenshots pasted with the feedback, sent to the design agent as images.
    const screenshots = cleanScreenshots(body.screenshots);
    // Images the page must use (stats, product photos…), given before a build.
    const assets = cleanAssets(body.assets);

    const action = String(body.action || "generate_page").trim();
    // Look for the page: match the brand (default), minimal, soft or brutalist.
    const styleDirection = isStyleDirection(body.styleDirection) ? body.styleDirection : undefined;
    const styleChanged = Boolean(styleDirection && styleDirection !== (existing.recreatedPage?.styleDirection || "brand"));

    if (RETIRED_ACTIONS.has(action)) {
      await resolveProjectAccess("search", existing.runId, user, "view");
      return NextResponse.json(
        { error: "This option is no longer available. Describe the change in the feedback box and press Apply changes." },
        { status: 410 },
      );
    }

    // Saving the website and going back to the earlier page spend nothing; the rest are runs.
    await resolveProjectAccess(
      "search",
      existing.runId,
      user,
      action === "set_business_url" || action === "undo_edit" ? "edit" : "run",
    );

    // A search run without the client's website: save it so recreation can
    // use the client's brand instead of sending the user back to search again.
    if (action === "set_business_url") {
      const website = normalizeWebsite(body.businessUrl);
      if (!website) {
        return NextResponse.json({ error: "Enter a website address, like yourbusiness.com" }, { status: 400 });
      }
      if (!(await saveRunBusinessUrl(existing.runId, website))) {
        return NextResponse.json({ error: "Search job not found for this competitor" }, { status: 404 });
      }
      // The browser only reads `brand` from this reply, so the page content is not read.
      return NextResponse.json({ competitor: maskCompetitor(existing), brand: await brandFor(existing.runId) });
    }

    if (action === "stop") {
      const competitor = await stopManusRecreation(competitorId);
      return NextResponse.json({ competitor: maskCompetitor(await withContentIfReadable(competitor)), stopped: true });
    }

    if (action === "undo_edit") {
      const undone = await undoManusChange(competitorId);
      return NextResponse.json({ competitor: maskCompetitor(await withContentIfReadable(undone)), cached: false });
    }

    // Every remaining action reaches the design agent and the AI that answers its questions.
    const billed = <T>(operation: string, fn: () => Promise<T>) =>
      runBillable(
        {
          user,
          operation,
          projectKind: "search",
          projectId: existing.runId,
          runId: existing.runId,
        },
        fn,
      );

    // A build that is reading the client's website (paid, minutes) is followed, never started again.
    if ((action === "edit_page" || BUILD_ACTIONS.has(action)) && isReadingWebsite(existing.recreatedPage)) {
      return NextResponse.json(
        { competitor: maskCompetitor(await withContentIfReadable(existing)), cached: true, inFlight: true },
        { status: 202 },
      );
    }

    // Targeted changes: the same agent task makes them on the page it built.
    if (action === "edit_page") {
      const change = userFeedback || (typeof body.request === "string" ? body.request.trim().slice(0, 4000) : "");
      if (!change && !screenshots.length) {
        return NextResponse.json({ error: "Describe the changes you want." }, { status: 400 });
      }
      // The stored-content marker is enough here; editManusRecreation reads the
      // content itself (and rebuilds the page if it has no HTML after all).
      if (!existing.recreatedPage?.hasPage) {
        return NextResponse.json({ error: "There is no finished page to change yet. Create the page first." }, { status: 400 });
      }
      return startBuild(competitorId, () =>
        billed("recreate.edit_page", () =>
          editManusRecreation(competitorId, change || "Make the changes shown in the attached screenshots.", screenshots),
        ),
      );
    }

    if (!BUILD_ACTIONS.has(action)) {
      return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 });
    }

    // A page for a generated ICP: the ICP must belong to this competitor's search.
    let targetIcp: { icpId: string; stage: AwarenessStage } | undefined;
    if (body.icpId !== undefined && body.icpId !== null && body.icpId !== "") {
      const icp = await getIcp(String(body.icpId));
      if (!icp || !icpBelongsToRun(icp, existing.runId)) {
        return NextResponse.json({ error: "That audience profile was not found for this search." }, { status: 400 });
      }
      targetIcp = { icpId: icp.id, stage: icp.stage };
    }
    const force =
      Boolean(body.force) ||
      Boolean(userFeedback) ||
      screenshots.length > 0 ||
      assets.length > 0 ||
      styleChanged ||
      action !== "generate_page" && action !== "generate_content";
    // A running build is followed; a finished page is returned unless a rebuild is asked for
    // or the page was built for a different reader (a new build replaces a running one).
    const reuse = shouldReuseCachedPage({
      force,
      requestedIcpId: targetIcp?.icpId ?? null,
      storedIcpId: existing.recreatedPage?.targetIcp?.icpId ?? null,
    });
    if (reuse && isManusRunActive(existing.recreatedPage)) {
      // The browser keeps showing the current page (if any) while it follows the build.
      return NextResponse.json({
        competitor: maskCompetitor(await withContentIfReadable(existing)),
        cached: true,
        inFlight: true,
      });
    }
    if (reuse && existing.recreatedPage?.status === "completed" && existing.recreatedPage.hasPage) {
      const content = await pageContent(competitorId);
      if (content?.html) {
        return NextResponse.json({ competitor: maskCompetitor(await withContent(existing, content)), cached: true });
      }
    }
    return startBuild(competitorId, () =>
      billed("recreate.generate_page", () =>
        runManusRecreation(competitorId, {
          targetIcp,
          userFeedback: userFeedback || null,
          styleDirection,
          screenshots,
          assets,
        }),
      ),
    );
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    if (err instanceof Error && err.name === "HttpError") {
      return errorResponse(err);
    }
    if (err instanceof ArchivedPageUnavailableError) {
      console.warn("[competitors/recreate-page]", err.message);
      return archiveUnavailableResponse();
    }
    console.error("[competitors/recreate-page]", err);
    return NextResponse.json(
      {
        error: sanitizeClientFacingText(
          (err as Error).message || "Recreation failed",
        ),
      },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const competitorId = String(searchParams.get("competitorId") ?? "").trim();
    if (!competitorId) {
      return NextResponse.json(
        { error: "competitorId is required" },
        { status: 400 },
      );
    }
    // ?light=1 is the progress poll during a build: the page's status and
    // progress only, without reading its content.
    const light = searchParams.get("light") === "1";
    let competitor = await getCompetitor(competitorId);
    if (!competitor) {
      return NextResponse.json(
        { error: "Competitor not found" },
        { status: 404 },
      );
    }
    const access = await resolveProjectAccess("search", competitor.runId, user, "view");
    // A website read a restart cut off would show "Reading…" for ever: it is marked failed.
    if (await expireStaleReading(competitorId)) competitor = (await getCompetitor(competitorId)) ?? competitor;
    // A design-agent run outlives a restart on the agent's side: follow it again.
    const page = competitor.recreatedPage;
    if (page?.manus?.taskId && (page.status === "pending" || page.status === "design_pending")) {
      // Only picks the run up (following it runs in the background); opening the page does not depend on it.
      await resumeManusRecreation(competitorId).catch((err: unknown) =>
        console.error(`[competitors/recreate-page] could not resume the run of ${competitorId}`, err),
      );
    }
    let view: CompetitorWithContent = competitor;
    if (!light) {
      try {
        view = await withContent(competitor);
      } catch (err) {
        if (!(err instanceof ArchivedPageUnavailableError)) throw err;
        console.warn("[competitors/recreate-page]", err.message);
        return archiveUnavailableResponse();
      }
    }
    return NextResponse.json({
      competitor: maskCompetitor(view, { light }),
      recreatedPage: pageForClient(maskRecreatedPage(view.recreatedPage ?? null), { light }),
      pageAnalysis: maskPageAnalysis(competitor.pageAnalysis ?? null),
      access: { role: access.role, canEdit: access.role !== "viewer" },
      brand: await brandFor(competitor.runId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
