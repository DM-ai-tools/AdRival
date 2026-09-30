import { NextResponse } from "next/server";
import { getCompetitor, getJob, getLookupJob, updateCompetitor, updateJob, updateLookupJob } from "@/lib/db";
import { repairPackEvidence } from "@/lib/pipeline/content/evidenceIds";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import type {
  CompetitorRecord,
  LandingContentBlock,
  LandingContentDocument,
} from "@/lib/types";
import {
  acceptContentProposal,
  approveRecreationContent,
  confirmContentClaim,
  discardContentProposal,
  refreshBrandColorsForRecreation,
  regenerateContentSection,
  regenerateGeneratedImageForRecreation,
  saveRecreationContentEdits,
  undoContentRevision,
  updateRecreationIntent,
} from "@/lib/pipeline/recreateLandingPage";
import {
  generateMissingUnifiedImages,
  isUnifiedRunActive,
  runUnifiedRecreation,
  stopUnifiedRecreation,
} from "@/lib/pipeline/unified/run";
import { recreationActionPermission } from "@/lib/pipeline/content/permissions";
import { draftIsCurrent } from "@/lib/pipeline/content/pageIntent";
import type { CanonicalContent } from "@/lib/pipeline/content/model";
import { ContentRevisionError } from "@/lib/pipeline/content/revisions";
import { sanitizeClientFacingText, maskRecreatedPage, maskPageAnalysis } from "@/lib/clientFacing";
import { isStyleDirection } from "@/lib/pipeline/skills/playbook";

export const runtime = "nodejs";
/** Landing HTML streams can take well past 10 minutes. */
export const maxDuration = 1800;

const LOOKUP_RECREATE_PREFIX = "lookup-recreate-";

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
 * A page build takes 8-10 minutes, longer than the hosting proxy keeps a
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

function maskCompetitor<T extends {
  recreatedPage?: unknown;
  pageAnalysis?: unknown;
}>(competitor: T): T {
  return {
    ...competitor,
    recreatedPage: maskRecreatedPage(
      (competitor.recreatedPage ?? null) as Parameters<typeof maskRecreatedPage>[0],
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

    const action = String(body.action || "generate_content").trim();
    // Look for the page: match the brand (default), minimal, soft or brutalist.
    const styleDirection = isStyleDirection(body.styleDirection) ? body.styleDirection : undefined;
    const styleChanged = Boolean(styleDirection && styleDirection !== (existing.recreatedPage?.styleDirection || "brand"));

    // save_content only rewrites stored copy, so it needs edit rather than run.
    resolveProjectAccess(
      "search",
      existing.runId,
      user,
      recreationActionPermission(action),
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
      const competitor = stopUnifiedRecreation(competitorId);
      return NextResponse.json({ competitor: maskCompetitor(competitor), stopped: true });
    }

    // Every remaining branch reaches an LLM, Firecrawl, Brandfetch or Runway.
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
    const blocks = Array.isArray(body.blocks)
      ? (body.blocks as LandingContentBlock[])
      : undefined;
    const document =
      body.document && typeof body.document === "object"
        ? (body.document as LandingContentDocument)
        : undefined;

    // Cached completed unified page
    if (
      (action === "generate_content" || action === "generate_page") &&
      !body.force &&
      !userFeedback &&
      !styleChanged &&
      existing.recreatedPage?.pipelineVersion?.startsWith("unified") &&
      existing.recreatedPage.status === "completed" &&
      existing.recreatedPage.html
    ) {
      return NextResponse.json({ competitor: maskCompetitor(existing), cached: true });
    }
    if (
      (action === "generate_content" || action === "generate_page") &&
      !body.force &&
      isUnifiedRunActive(existing.recreatedPage) &&
      existing.recreatedPage?.pipelineVersion?.startsWith("unified")
    ) {
      return NextResponse.json({ competitor: maskCompetitor(existing), cached: true, inFlight: true });
    }

    // Cached completed page with approved content (legacy)
    if (
      action === "generate_content" &&
      !body.force &&
      !userFeedback &&
      existing.recreatedPage?.contentPack &&
      !existing.recreatedPage.contentPack.legacy &&
      existing.recreatedPage.contentPack.canonical.sections.length > 0 &&
      !existing.recreatedPage.pipelineVersion?.startsWith("unified") &&
      draftIsCurrent(existing.recreatedPage.contentPack)
    ) {
      return NextResponse.json({ competitor: maskCompetitor(existing), cached: true });
    }

    if (action === "save_content") {
      const canonical =
        body.canonical && typeof body.canonical === "object"
          ? (body.canonical as CanonicalContent)
          : null;
      const expectedRevision =
        typeof body.expectedRevision === "number" ? body.expectedRevision : null;
      if (!canonical && !blocks?.length && !document?.sections?.length) {
        return NextResponse.json(
          { error: "document or blocks are required to save content edits" },
          { status: 400 },
        );
      }
      const competitor = saveRecreationContentEdits(
        competitorId,
        blocks || existing.recreatedPage?.contentDraft?.blocks || [],
        document,
        canonical,
        expectedRevision,
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "update_intent") {
      const confirmed = Array.isArray(body.confirmedTerms)
        ? body.confirmedTerms.map((item: unknown) => String(item)).filter(Boolean)
        : undefined;
      const competitor = updateRecreationIntent(
        competitorId,
        {
          primaryService: typeof body.primaryService === "string" ? body.primaryService : undefined,
          offerConcept: typeof body.offerConcept === "string" ? body.offerConcept : undefined,
          confirmedTerms: confirmed,
        },
        Number(body.expectedRevision),
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "approve_content") {
      const expectedRevision = Number(body.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
      }
      const competitor = approveRecreationContent(competitorId, expectedRevision);
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "accept_proposal") {
      return NextResponse.json({ competitor: maskCompetitor(acceptContentProposal(competitorId)), cached: false });
    }
    if (action === "discard_proposal") {
      return NextResponse.json({ competitor: maskCompetitor(discardContentProposal(competitorId)), cached: false });
    }
    if (action === "undo_content") {
      const expectedRevision = Number(body.expectedRevision);
      return NextResponse.json({
        competitor: undoContentRevision(competitorId, expectedRevision),
        cached: false,
      });
    }
    if (action === "confirm_fact") {
      const competitor = confirmContentClaim(
        competitorId,
        String(body.sectionId || ""),
        String(body.value || ""),
        user.username,
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "regenerate_section") {
      const competitor = await billed("recreate.generate_content", () =>
        regenerateContentSection(
          competitorId,
          String(body.sectionId || ""),
          userFeedback,
          Number(body.expectedRevision),
        ),
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "refresh_brand_colors") {
      const result = await billed("recreate.refresh_brand_colors", () =>
        refreshBrandColorsForRecreation(competitorId),
      );
      return NextResponse.json({
        competitor: result.competitor,
        warnings: result.warnings,
        cached: false,
      });
    }

    if (action === "regenerate_image") {
      const imageId = String(body.imageId ?? "").trim();
      if (!imageId) {
        return NextResponse.json(
          { error: "imageId is required" },
          { status: 400 },
        );
      }
      const competitor = await billed("recreate.regenerate_image", () =>
        regenerateGeneratedImageForRecreation(
          competitorId,
          imageId,
          typeof body.feedback === "string" ? body.feedback : userFeedback,
        ),
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (action === "generate_missing_images") {
      const competitor = await billed("recreate.regenerate_image", () =>
        generateMissingUnifiedImages(competitorId),
      );
      return NextResponse.json({ competitor: maskCompetitor(competitor), cached: false });
    }

    if (
      action === "approve_and_build" ||
      action === "build_design" ||
      action === "regenerate_design" ||
      action === "revise_page"
    ) {
      // A finished page that only failed validation should be returned, not rebuilt.
      const prior = existing.recreatedPage;
      const priorHtml = prior?.html || "";
      const validationLeftover = Boolean(
        priorHtml &&
          /<\/html>/i.test(priorHtml) &&
          (prior?.error || (prior?.publishBlockers || []).length) &&
          prior?.status !== "pending",
      );
      if (!userFeedback && validationLeftover && (action === "regenerate_design" || action === "revise_page")) {
        return NextResponse.json({ competitor: maskCompetitor(existing), cached: true });
      }
      return startBuild(competitorId, () =>
        billed("recreate.generate_page", () =>
          runUnifiedRecreation(competitorId, {
            force: true,
            userFeedback: userFeedback || undefined,
            styleDirection,
          }),
        ),
      );
    }

    // Default / regenerate_content / generate_content / generate_page → unified
    return startBuild(competitorId, () =>
      billed("recreate.generate_page", () =>
        runUnifiedRecreation(competitorId, {
          force:
            Boolean(body.force) ||
            Boolean(userFeedback) ||
            styleChanged ||
            action === "regenerate_content" ||
            action === "regenerate_page",
          userFeedback: userFeedback || undefined,
          styleDirection,
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
    if (err instanceof ContentRevisionError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
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
    let competitor = getCompetitor(competitorId);
    if (!competitor) {
      return NextResponse.json(
        { error: "Competitor not found" },
        { status: 404 },
      );
    }
    const access = resolveProjectAccess("search", competitor.runId, user, "view");
    const pack = competitor.recreatedPage?.contentPack;
    if (pack) {
      const repaired = repairPackEvidence(pack);
      if (repaired && access.role !== "viewer") {
        competitor = updateCompetitor(competitorId, {
          recreatedPage: { ...competitor.recreatedPage!, contentPack: repaired },
        }) || competitor;
      } else if (repaired) {
        competitor = {
          ...competitor,
          recreatedPage: { ...competitor.recreatedPage!, contentPack: repaired },
        };
      }
    }
    return NextResponse.json({
      competitor: maskCompetitor(competitor),
      recreatedPage: maskRecreatedPage(competitor.recreatedPage ?? null),
      pageAnalysis: maskPageAnalysis(competitor.pageAnalysis ?? null),
      access: { role: access.role, canEdit: access.role !== "viewer" },
      brand: brandFor(competitor.runId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
