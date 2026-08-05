import { NextResponse } from "next/server";
import { getCompetitor } from "@/lib/db";
import type {
  LandingContentBlock,
  LandingContentDocument,
} from "@/lib/types";
import {
  buildRecreationDesign,
  generateRecreationContent,
  refreshBrandColorsForRecreation,
  regenerateGeneratedImageForRecreation,
  saveRecreationContentEdits,
} from "@/lib/pipeline/recreateLandingPage";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
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
    const blocks = Array.isArray(body.blocks)
      ? (body.blocks as LandingContentBlock[])
      : undefined;
    const document =
      body.document && typeof body.document === "object"
        ? (body.document as LandingContentDocument)
        : undefined;

    // Cached completed page with approved content
    if (
      action === "generate_content" &&
      !body.force &&
      !userFeedback &&
      existing.recreatedPage?.status === "completed" &&
      existing.recreatedPage.html &&
      existing.recreatedPage.contentDraft?.status === "approved"
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
    }

    if (
      action === "generate_content" &&
      !body.force &&
      !userFeedback &&
      existing.recreatedPage?.status === "content_ready" &&
      existing.recreatedPage.contentDraft?.blocks?.length
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
    }

    if (action === "save_content") {
      if (!blocks?.length && !document?.sections?.length) {
        return NextResponse.json(
          { error: "document or blocks are required to save content edits" },
          { status: 400 },
        );
      }
      const competitor = saveRecreationContentEdits(
        competitorId,
        blocks || existing.recreatedPage?.contentDraft?.blocks || [],
        document,
      );
      return NextResponse.json({ competitor, cached: false });
    }

    if (action === "refresh_brand_colors") {
      const result = await refreshBrandColorsForRecreation(competitorId);
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
      const competitor = await regenerateGeneratedImageForRecreation(
        competitorId,
        imageId,
        typeof body.feedback === "string" ? body.feedback : userFeedback,
      );
      return NextResponse.json({ competitor, cached: false });
    }

    if (
      action === "approve_and_build" ||
      action === "build_design" ||
      action === "regenerate_design"
    ) {
      const competitor = await buildRecreationDesign(competitorId, {
        blocks,
        document,
        userFeedback: userFeedback || undefined,
      });
      return NextResponse.json({ competitor, cached: false });
    }

    // Default / regenerate_content / generate_content
    const competitor = await generateRecreationContent(competitorId, {
      force:
        Boolean(body.force) ||
        Boolean(userFeedback) ||
        action === "regenerate_content",
      userFeedback: userFeedback || undefined,
    });
    return NextResponse.json({ competitor, cached: false });
  } catch (err) {
    console.error("[competitors/recreate-page]", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function GET(request: Request) {
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
  return NextResponse.json({
    competitor,
    recreatedPage: competitor.recreatedPage ?? null,
    pageAnalysis: competitor.pageAnalysis ?? null,
  });
}
