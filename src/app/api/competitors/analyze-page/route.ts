import { NextResponse } from "next/server";
import { getCompetitor } from "@/lib/db";
import { analyzeCompetitorLandingPage } from "@/lib/pipeline/landingPageAnalysis";

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

    if (
      !body.force &&
      existing.pageAnalysis?.status === "completed" &&
      existing.pageAnalysis.offer &&
      existing.pageAnalysis.sameLandingPageAds
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
    }

    const competitor = await analyzeCompetitorLandingPage(competitorId);
    return NextResponse.json({ competitor, cached: false });
  } catch (err) {
    console.error("[competitors/analyze-page]", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
