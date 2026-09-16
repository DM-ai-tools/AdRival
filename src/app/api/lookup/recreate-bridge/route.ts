import { NextResponse } from "next/server";
import { getLookupAd, getLookupJob } from "@/lib/db";
import {
  errorResponse,
  requireUser,
  resolveProjectAccess,
  visibleRunIds,
} from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { resolveBrandDisplayName } from "@/lib/pipeline/brandDisplayName";
import {
  ensureLookupRecreationCompetitor,
  findExistingRecreationsForUrl,
  setLookupBusinessBrand,
} from "@/lib/pipeline/lookupRecreateBridge";
import { resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * Bridge a lookup ad into the shared recreate pipeline.
 * Body: { adId, businessUrl?, force?, confirmRedesign? }
 * - Without confirmRedesign, returns needsConfirm when same LP was already recreated.
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const adId = String(body.adId ?? "").trim();
    if (!adId) {
      return NextResponse.json({ error: "adId is required" }, { status: 400 });
    }

    const ad = getLookupAd(adId);
    if (!ad) {
      return NextResponse.json({ error: "Lookup ad not found" }, { status: 404 });
    }

    resolveProjectAccess("lookup", ad.lookupId, user, "run");

    const lookup = getLookupJob(ad.lookupId);
    if (!lookup) {
      return NextResponse.json({ error: "Lookup job not found" }, { status: 404 });
    }

    const businessUrlRaw =
      typeof body.businessUrl === "string"
        ? body.businessUrl.trim()
        : (lookup.businessUrl || lookup.businessProfile?.url || "").trim();

    if (businessUrlRaw) {
      const needsAnalyze =
        !lookup.businessProfile?.brandColors ||
        (lookup.businessUrl || "").replace(/\/$/, "") !==
          (businessUrlRaw.startsWith("http")
            ? businessUrlRaw
            : `https://${businessUrlRaw}`
          ).replace(/\/$/, "");

      if (needsAnalyze || body.refreshBrand) {
        try {
          const brand = await runBillable(
            {
              user,
              operation: "lookup.recreate_bridge.resolve_brand",
              projectKind: "lookup",
              projectId: ad.lookupId,
              runId: ad.lookupId,
            },
            () =>
              resolveBrandBundle({
                businessUrl: businessUrlRaw,
                profile: lookup.businessProfile || null,
              }),
          );
          const businessName = resolveBrandDisplayName({
            businessUrl: brand.finalUrl || businessUrlRaw,
            siteName: brand.assets?.siteName,
            profileName: lookup.businessProfile?.businessName,
            competitorName: lookup.queryName,
          });
          setLookupBusinessBrand(ad.lookupId, {
            businessUrl: brand.finalUrl || businessUrlRaw,
            businessProfile: {
              ...(lookup.businessProfile || {
                url: brand.finalUrl || businessUrlRaw,
                businessName,
                industry: "",
                description: "",
                offerings: [],
                competitorKeywords: [],
                positioningSummary: "",
              }),
              url: brand.finalUrl || businessUrlRaw,
              businessName,
              brandColors: brand.colors,
              brandAssets:
                brand.assets || lookup.businessProfile?.brandAssets || null,
              brandDesign:
                brand.design || lookup.businessProfile?.brandDesign || null,
              analyzedAt: new Date().toISOString(),
            },
          });
        } catch (err) {
          if (isCreditError(err)) throw err;
          // Still store the URL so recreate can retry brand resolve later
          setLookupBusinessBrand(ad.lookupId, {
            businessUrl: businessUrlRaw,
            businessProfile: lookup.businessProfile || null,
          });
          console.warn("[lookup recreate-bridge] brand analyze failed", err);
        }
      } else if (!lookup.businessUrl) {
        setLookupBusinessBrand(ad.lookupId, {
          businessUrl: businessUrlRaw,
          businessProfile: lookup.businessProfile || null,
        });
      }
    }

    const landingUrl =
      ad.pageAnalysis?.analyzedUrl ||
      ad.landingPageUrl ||
      ad.youtubeUrl ||
      null;

    const prior = findExistingRecreationsForUrl(landingUrl, {
      visibleRunIds: visibleRunIds(user, "search"),
    });
    const confirmRedesign = Boolean(body.confirmRedesign || body.force);
    const alreadyDone = prior.filter(
      (h) =>
        h.status === "completed" ||
        h.status === "content_ready" ||
        h.status === "design_pending",
    );

    if (alreadyDone.length > 0 && !confirmRedesign) {
      return NextResponse.json({
        needsConfirm: true,
        message:
          "A recreation for this landing page URL already exists. Confirm to redesign, or open the existing draft.",
        existing: alreadyDone[0],
        allExisting: alreadyDone.slice(0, 5),
        landingUrl,
        lookupJob: getLookupJob(ad.lookupId),
      });
    }

    const bridged = ensureLookupRecreationCompetitor(adId);

    return NextResponse.json({
      needsConfirm: false,
      competitorId: bridged.competitorId,
      created: bridged.created,
      existingSameUrl: bridged.existingSameUrl,
      recreatePath: `/recreate/${encodeURIComponent(bridged.competitorId)}`,
      lookupJob: getLookupJob(ad.lookupId),
      ad: getLookupAd(adId),
    });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    return errorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const adId = String(searchParams.get("adId") || "").trim();
    if (!adId) {
      return NextResponse.json({ error: "adId is required" }, { status: 400 });
    }
    const ad = getLookupAd(adId);
    if (!ad) {
      return NextResponse.json({ error: "Lookup ad not found" }, { status: 404 });
    }
    resolveProjectAccess("lookup", ad.lookupId, user, "view");
    const landingUrl =
      ad.pageAnalysis?.analyzedUrl ||
      ad.landingPageUrl ||
      ad.youtubeUrl ||
      null;
    const existing = findExistingRecreationsForUrl(landingUrl, {
      visibleRunIds: visibleRunIds(user, "search"),
    });
    return NextResponse.json({
      adId,
      landingUrl,
      recreationCompetitorId: ad.recreationCompetitorId || null,
      existing,
      lookupJob: getLookupJob(ad.lookupId),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
