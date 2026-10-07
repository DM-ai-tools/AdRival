import { NextResponse } from "next/server";
import { getCompetitor, getJob, getLookupJob, updateCompetitor, updateJob, updateLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import type { CompetitorRecord } from "@/lib/types";
import { sanitizeClientFacingText, maskRecreatedPage, maskPageAnalysis } from "@/lib/clientFacing";
import { isStyleDirection } from "@/lib/pipeline/skills/playbook";
import {
  cleanScreenshots,
  editManusRecreation,
  isManusRunActive,
  resumeManusRecreation,
  runManusRecreation,
  stopManusRecreation,
  undoManusChange,
} from "@/lib/pipeline/manus/run";

export const runtime = "nodejs";
/** A design-agent build runs well past 10 minutes; it continues after the reply. */
export const maxDuration = 1800;

const LOOKUP_RECREATE_PREFIX = "lookup-recreate-";

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

/** "acme.com.au/" → "https://acme.com.au", or null when it is not a website. */
function normalizeWebsite(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** The client's website and name for a competitor's run, if the run has one. */
function brandFor(runId: string): { businessUrl: string | null; businessName: string | null } {
  const job = getJob(runId);
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
  if (early) return NextResponse.json({ competitor: maskCompetitor(early.competitor), cached: false });
  run.catch((err) => {
    // The run saves its own failure on the page; this only covers a crash before it could.
    console.error("[competitors/recreate-page] background build failed", err);
    const latest = getCompetitor(competitorId);
    const page = latest?.recreatedPage;
    if (page && (page.status === "pending" || page.status === "design_pending")) {
      updateCompetitor(competitorId, {
        recreatedPage: {
          ...page,
          status: page.html ? "completed" : "failed",
          error: sanitizeClientFacingText((err as Error)?.message || "Recreation failed"),
          updatedAt: new Date().toISOString(),
          progress: page.progress ? { ...page.progress, phase: "failed", message: "Recreation failed" } : page.progress,
        },
      });
    }
  });
  const latest = getCompetitor(competitorId);
  return NextResponse.json(
    { competitor: latest ? maskCompetitor(latest) : null, cached: false, inFlight: true },
    { status: 202 },
  );
}

/**
 * The page as the browser gets it: the stored previous version (kept for
 * Undo) is replaced by a flag, so polling does not send the page twice.
 */
function pageForClient<T extends { previousHtml?: string | null } | null | undefined>(page: T): T {
  if (!page) return page;
  const { previousHtml, ...rest } = page;
  // The design agent's task state (ids, answer context) stays on the server.
  delete (rest as { manus?: unknown }).manus;
  return { ...rest, canUndo: Boolean(previousHtml) } as unknown as T;
}

function maskCompetitor<T extends {
  recreatedPage?: unknown;
  pageAnalysis?: unknown;
}>(competitor: T): T {
  return {
    ...competitor,
    recreatedPage: pageForClient(
      maskRecreatedPage((competitor.recreatedPage ?? null) as Parameters<typeof maskRecreatedPage>[0]) as { previousHtml?: string | null } | null,
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

    const existing = getCompetitor(competitorId);
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

    const action = String(body.action || "generate_page").trim();
    // Look for the page: match the brand (default), minimal, soft or brutalist.
    const styleDirection = isStyleDirection(body.styleDirection) ? body.styleDirection : undefined;
    const styleChanged = Boolean(styleDirection && styleDirection !== (existing.recreatedPage?.styleDirection || "brand"));

    if (RETIRED_ACTIONS.has(action)) {
      resolveProjectAccess("search", existing.runId, user, "view");
      return NextResponse.json(
        { error: "This option is no longer available. Describe the change in the feedback box and press Apply changes." },
        { status: 410 },
      );
    }

    // Saving the website and going back to the earlier page spend nothing; the rest are runs.
    resolveProjectAccess(
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
      const job = getJob(existing.runId);
      if (!job) return NextResponse.json({ error: "Search job not found for this competitor" }, { status: 404 });
      updateJob(job.id, {
        businessUrl: website,
        ...(job.businessProfile && !job.businessProfile.url
          ? { businessProfile: { ...job.businessProfile, url: website } }
          : {}),
      });
      if (job.id.startsWith(LOOKUP_RECREATE_PREFIX)) {
        const lookupId = job.id.slice(LOOKUP_RECREATE_PREFIX.length);
        if (getLookupJob(lookupId)) updateLookupJob(lookupId, { businessUrl: website });
      }
      return NextResponse.json({ competitor: maskCompetitor(existing), brand: brandFor(existing.runId) });
    }

    if (action === "stop") {
      const competitor = await stopManusRecreation(competitorId);
      return NextResponse.json({ competitor: maskCompetitor(competitor), stopped: true });
    }

    if (action === "undo_edit") {
      return NextResponse.json({ competitor: maskCompetitor(undoManusChange(competitorId)), cached: false });
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

    // Targeted changes: the same agent task makes them on the page it built.
    if (action === "edit_page") {
      const change = userFeedback || (typeof body.request === "string" ? body.request.trim().slice(0, 4000) : "");
      if (!change && !screenshots.length) {
        return NextResponse.json({ error: "Describe the changes you want." }, { status: 400 });
      }
      if (!existing.recreatedPage?.html) {
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

    const force =
      Boolean(body.force) ||
      Boolean(userFeedback) ||
      screenshots.length > 0 ||
      styleChanged ||
      action !== "generate_page" && action !== "generate_content";
    // A running build is followed; a finished page is returned unless a rebuild is asked for.
    if (!force && isManusRunActive(existing.recreatedPage)) {
      return NextResponse.json({ competitor: maskCompetitor(existing), cached: true, inFlight: true });
    }
    if (!force && existing.recreatedPage?.status === "completed" && existing.recreatedPage.html) {
      return NextResponse.json({ competitor: maskCompetitor(existing), cached: true });
    }
    return startBuild(competitorId, () =>
      billed("recreate.generate_page", () =>
        runManusRecreation(competitorId, {
          userFeedback: userFeedback || null,
          styleDirection,
          screenshots,
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
    const competitor = getCompetitor(competitorId);
    if (!competitor) {
      return NextResponse.json(
        { error: "Competitor not found" },
        { status: 404 },
      );
    }
    const access = resolveProjectAccess("search", competitor.runId, user, "view");
    // A design-agent run outlives a restart on the agent's side: follow it again.
    const page = competitor.recreatedPage;
    if (page?.manus?.taskId && (page.status === "pending" || page.status === "design_pending")) {
      resumeManusRecreation(competitorId);
    }
    return NextResponse.json({
      competitor: maskCompetitor(competitor),
      recreatedPage: pageForClient(maskRecreatedPage(competitor.recreatedPage ?? null)),
      pageAnalysis: maskPageAnalysis(competitor.pageAnalysis ?? null),
      access: { role: access.role, canEdit: access.role !== "viewer" },
      brand: brandFor(competitor.runId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
