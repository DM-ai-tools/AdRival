import { NextResponse } from "next/server";
import { getLookupAd } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { analyzeLookupAdLandingPage } from "@/lib/pipeline/landingPageAnalysis";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const adId = String(body.adId ?? "").trim();
    if (!adId) {
      return NextResponse.json({ error: "adId is required" }, { status: 400 });
    }

    const existing = getLookupAd(adId);
    if (!existing) {
      return NextResponse.json({ error: "Lookup ad not found" }, { status: 404 });
    }
    resolveProjectAccess("lookup", existing.lookupId, user, "run");

    // Return cached completed analysis unless force=true or missing same-LP ads
    if (
      !body.force &&
      existing.pageAnalysis?.status === "completed" &&
      existing.pageAnalysis.offer &&
      existing.pageAnalysis.sameLandingPageAds
    ) {
      return NextResponse.json({ ad: existing, cached: true });
    }

    const ad = await runBillable(
      {
        user,
        operation: "lookup.analyze_landing_page",
        projectKind: "lookup",
        projectId: existing.lookupId,
        runId: existing.lookupId,
      },
      () => analyzeLookupAdLandingPage(adId),
    );
    return NextResponse.json({ ad, cached: false, chargedTo: user.username });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    console.error("[lookup/analyze-page]", err);
    return errorResponse(err);
  }
}
