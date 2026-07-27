import { NextResponse } from "next/server";
import { getLookupAd } from "@/lib/db";
import { analyzeLookupAdLandingPage } from "@/lib/pipeline/landingPageAnalysis";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const adId = String(body.adId ?? "").trim();
    if (!adId) {
      return NextResponse.json({ error: "adId is required" }, { status: 400 });
    }

    const existing = getLookupAd(adId);
    if (!existing) {
      return NextResponse.json({ error: "Lookup ad not found" }, { status: 404 });
    }

    // Return cached completed analysis unless force=true
    if (
      !body.force &&
      existing.pageAnalysis?.status === "completed" &&
      existing.pageAnalysis.offer
    ) {
      return NextResponse.json({ ad: existing, cached: true });
    }

    const ad = await analyzeLookupAdLandingPage(adId);
    return NextResponse.json({ ad, cached: false });
  } catch (err) {
    console.error("[lookup/analyze-page]", err);
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
