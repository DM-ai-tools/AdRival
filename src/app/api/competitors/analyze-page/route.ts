import { NextResponse } from "next/server";
import { getCompetitor } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { analyzeCompetitorLandingPage } from "@/lib/pipeline/landingPageAnalysis";

export const runtime = "nodejs";
export const maxDuration = 300;

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

    // Competitors are reached through their run, so authorization is checked on
    // the owning project rather than the competitor id.
    const access = resolveProjectAccess("search", existing.runId, user, "run");

    if (
      !body.force &&
      existing.pageAnalysis?.status === "completed" &&
      existing.pageAnalysis.offer &&
      existing.pageAnalysis.sameLandingPageAds
    ) {
      // Cached: no provider call, so nothing to charge.
      return NextResponse.json({ competitor: existing, cached: true });
    }

    const competitor = await runBillable(
      {
        user,
        operation: "competitor.analyze_landing_page",
        projectKind: "search",
        projectId: existing.runId,
        runId: existing.runId,
      },
      () => analyzeCompetitorLandingPage(competitorId),
    );
    return NextResponse.json({
      competitor,
      cached: false,
      chargedTo: user.username,
      sharedProject: access.role !== "owner",
    });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    console.error("[competitors/analyze-page]", err);
    return errorResponse(err);
  }
}
