import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { dispatchPlatformSearch } from "@/lib/pipeline/dispatch";
import { resolveSearchGeoContext } from "@/lib/pipeline/keywordSuggestions";
import { AD_PLATFORMS, parseKeywords, type AdPlatform } from "@/lib/platforms";
import {
  defaultGeoForPlatform,
  geosForPlatform,
} from "@/lib/geo";
import { hasOpenAICompatKey } from "@/lib/openrouter/openaiCompat";
import type {
  BusinessCategory,
  BusinessProfile,
  SearchGeoMode,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const platformRaw = String(body.platform ?? "facebook").toLowerCase();
    const platform = (
      AD_PLATFORMS.includes(platformRaw as AdPlatform)
        ? platformRaw
        : "facebook"
    ) as AdPlatform;

    const keywords = parseKeywords(
      body.keywords ?? body.keyword ?? body.query ?? "",
    );
    if (keywords.length === 0) {
      return NextResponse.json(
        { error: "At least one keyword is required" },
        { status: 400 },
      );
    }

    const geoRaw = String(body.geo ?? body.country ?? "").trim();
    const allowed = new Set(geosForPlatform(platform).map((g) => g.code));
    let geo = allowed.has(geoRaw)
      ? geoRaw
      : defaultGeoForPlatform(platform);

    const businessProfile =
      body.businessProfile && typeof body.businessProfile === "object"
        ? ({ ...body.businessProfile } as BusinessProfile)
        : null;

    // Authoritative keywords from the form — overwrite profile seeds
    if (businessProfile) {
      businessProfile.competitorKeywords = keywords;
    }

    const businessUrlRaw = String(
      body.businessUrl ?? businessProfile?.url ?? "",
    ).trim();
    const businessUrl = businessUrlRaw
      ? /^https?:\/\//i.test(businessUrlRaw)
        ? businessUrlRaw.replace(/\/$/, "")
        : `https://${businessUrlRaw}`.replace(/\/$/, "")
      : null;

    if (businessProfile && businessUrl && !businessProfile.url) {
      businessProfile.url = businessUrl;
    }

    // Default Ad Library market from company primary country when user left default
    if (
      businessProfile?.primaryMarketCountry &&
      allowed.has(businessProfile.primaryMarketCountry) &&
      (!geoRaw || geoRaw === defaultGeoForPlatform(platform))
    ) {
      geo = businessProfile.primaryMarketCountry;
    }

    const requestedGeoMode = String(body.geoMode || "countrywide").trim() as
      | SearchGeoMode
      | string;
    const baseMode: SearchGeoMode =
      requestedGeoMode === "company_locations"
        ? "company_locations"
        : "countrywide";

    const geoCtx = resolveSearchGeoContext({
      keywords,
      profile: businessProfile,
      geoMode: baseMode,
    });

    const selectedCategory =
      body.selectedCategory && typeof body.selectedCategory === "object"
        ? (body.selectedCategory as BusinessCategory)
        : null;

    const skipGuardrails = Boolean(body.skipGuardrails);
    const guardrailOverride =
      body.guardrailOverride && typeof body.guardrailOverride === "object"
        ? {
            enabled: Boolean(body.guardrailOverride.enabled),
            seekCompetitors:
              typeof body.guardrailOverride.seekCompetitors === "string"
                ? body.guardrailOverride.seekCompetitors.trim() || null
                : null,
            notes:
              typeof body.guardrailOverride.notes === "string"
                ? body.guardrailOverride.notes.trim() || null
                : null,
          }
        : null;

    if (!process.env.SOCIAVAULT_API_KEY) {
      return NextResponse.json(
        { error: "SOCIAVAULT_API_KEY is not configured" },
        { status: 500 },
      );
    }
    if (!hasOpenAICompatKey()) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY or OPENAI_API_KEY is not configured" },
        { status: 500 },
      );
    }

    const jobId = uuidv4();

    after(() => {
      void dispatchPlatformSearch(jobId, keywords, platform, {
        geo,
        businessProfile,
        businessUrl,
        geoMode: geoCtx.geoMode,
        selectedCategory,
        targetLocations: geoCtx.targetLocations,
        keywordLocation: geoCtx.keywordLocation,
        skipGuardrails,
        guardrailOverride,
      });
    });

    return NextResponse.json({
      jobId,
      keyword: keywords.join(", "),
      keywords,
      platform,
      geo,
      geoMode: geoCtx.geoMode,
      keywordLocation: geoCtx.keywordLocation,
      businessUrl,
      skipGuardrails,
      guardrailOverride,
      businessProfile: businessProfile
        ? {
            businessName: businessProfile.businessName,
            industry: businessProfile.industry,
            subIndustry: businessProfile.subIndustry,
            url: businessProfile.url || businessUrl,
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
