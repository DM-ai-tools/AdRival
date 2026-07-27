import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { dispatchPlatformSearch } from "@/lib/pipeline/dispatch";
import { AD_PLATFORMS, parseKeywords, type AdPlatform } from "@/lib/platforms";
import {
  defaultGeoForPlatform,
  geosForPlatform,
} from "@/lib/geo";
import type { BusinessProfile } from "@/lib/types";

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
    const geo = allowed.has(geoRaw)
      ? geoRaw
      : defaultGeoForPlatform(platform);

    const businessProfile =
      body.businessProfile && typeof body.businessProfile === "object"
        ? (body.businessProfile as BusinessProfile)
        : null;

    const businessUrlRaw = String(
      body.businessUrl ?? businessProfile?.url ?? "",
    ).trim();
    const businessUrl = businessUrlRaw
      ? /^https?:\/\//i.test(businessUrlRaw)
        ? businessUrlRaw.replace(/\/$/, "")
        : `https://${businessUrlRaw}`.replace(/\/$/, "")
      : null;

    // Prefer explicit URL on the profile when both exist
    if (businessProfile && businessUrl && !businessProfile.url) {
      businessProfile.url = businessUrl;
    }

    if (!process.env.SOCIAVAULT_API_KEY) {
      return NextResponse.json(
        { error: "SOCIAVAULT_API_KEY is not configured" },
        { status: 500 },
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not configured" },
        { status: 500 },
      );
    }
    if (businessProfile && !process.env.OPENROUTER_API_KEY) {
      // Profile may have been analyzed earlier; still allow search with provided profile
    }

    const jobId = uuidv4();

    after(() => {
      void dispatchPlatformSearch(jobId, keywords, platform, {
        geo,
        businessProfile,
        businessUrl,
      });
    });

    return NextResponse.json({
      jobId,
      keyword: keywords.join(", "),
      keywords,
      platform,
      geo,
      businessUrl,
      businessProfile: businessProfile
        ? {
            businessName: businessProfile.businessName,
            industry: businessProfile.industry,
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
