import { NextResponse } from "next/server";
import { getCompetitor } from "@/lib/db";
import { recreateCompetitorLandingPage } from "@/lib/pipeline/recreateLandingPage";

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

    if (
      !body.force &&
      !userFeedback &&
      existing.recreatedPage?.status === "completed" &&
      existing.recreatedPage.html
    ) {
      return NextResponse.json({ competitor: existing, cached: true });
    }

    const competitor = await recreateCompetitorLandingPage(competitorId, {
      force: Boolean(body.force) || Boolean(userFeedback),
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
