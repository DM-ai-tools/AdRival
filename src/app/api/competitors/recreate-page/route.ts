import { NextResponse } from "next/server";
import { getCompetitor, updateCompetitor } from "@/lib/db";
import { repairPackEvidence } from "@/lib/pipeline/content/evidenceIds";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import type {
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
} from "@/lib/pipeline/unified/run";
import { recreationActionPermission } from "@/lib/pipeline/content/permissions";
import { draftIsCurrent } from "@/lib/pipeline/content/pageIntent";
import type { CanonicalContent } from "@/lib/pipeline/content/model";
import { ContentRevisionError } from "@/lib/pipeline/content/revisions";
import { sanitizeClientFacingText } from "@/lib/clientFacing";

export const runtime = "nodejs";
export const maxDuration = 600;

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

    // save_content only rewrites stored copy, so it needs edit rather than run.
    resolveProjectAccess(
      "search",
      existing.runId,
      user,
      recreationActionPermission(action),
    );

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
      existing.recreatedPage?.pipelineVersion?.startsWith("unified") &&
      existing.recreatedPage.status === "completed" &&
      existing.recreatedPage.html
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
    }
    if (
      (action === "generate_content" || action === "generate_page") &&
      !body.force &&
      isUnifiedRunActive(existing.recreatedPage) &&
      existing.recreatedPage?.pipelineVersion?.startsWith("unified")
    ) {
      return NextResponse.json({ competitor: existing, cached: true, inFlight: true });
    }

    // Cached completed page with approved content (legacy)
    if (
      action === "generate_content" &&
      !body.force &&
      !userFeedback &&
      existing.recreatedPage?.contentPack &&
      !existing.recreatedPage.contentPack.legacy &&
      existing.recreatedPage.contentPack.canonical.sections.length > 0 &&
      existing.recreatedPage.pipelineVersion !== "unified-1" &&
      draftIsCurrent(existing.recreatedPage.contentPack)
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
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
      return NextResponse.json({ competitor, cached: false });
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
      return NextResponse.json({ competitor, cached: false });
    }

    if (action === "approve_content") {
      const expectedRevision = Number(body.expectedRevision);
      if (!Number.isFinite(expectedRevision)) {
        return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
      }
      const competitor = approveRecreationContent(competitorId, expectedRevision);
      return NextResponse.json({ competitor, cached: false });
    }

    if (action === "accept_proposal") {
      return NextResponse.json({ competitor: acceptContentProposal(competitorId), cached: false });
    }
    if (action === "discard_proposal") {
      return NextResponse.json({ competitor: discardContentProposal(competitorId), cached: false });
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
      return NextResponse.json({ competitor, cached: false });
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
      return NextResponse.json({ competitor, cached: false });
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
      return NextResponse.json({ competitor, cached: false });
    }

    if (action === "generate_missing_images") {
      const competitor = await billed("recreate.regenerate_image", () =>
        generateMissingUnifiedImages(competitorId),
      );
      return NextResponse.json({ competitor, cached: false });
    }

    if (
      action === "approve_and_build" ||
      action === "build_design" ||
      action === "regenerate_design" ||
      action === "revise_page"
    ) {
      const competitor = await billed("recreate.generate_page", () =>
        runUnifiedRecreation(competitorId, {
          force: true,
          userFeedback: userFeedback || undefined,
        }),
      );
      return NextResponse.json({ competitor, cached: false });
    }

    // Default / regenerate_content / generate_content / generate_page → unified
    const competitor = await billed("recreate.generate_page", () =>
      runUnifiedRecreation(competitorId, {
        force:
          Boolean(body.force) ||
          Boolean(userFeedback) ||
          action === "regenerate_content" ||
          action === "regenerate_page",
        userFeedback: userFeedback || undefined,
      }),
    );
    return NextResponse.json({ competitor, cached: false });
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
      competitor,
      recreatedPage: competitor.recreatedPage ?? null,
      pageAnalysis: competitor.pageAnalysis ?? null,
      access: { role: access.role, canEdit: access.role !== "viewer" },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
