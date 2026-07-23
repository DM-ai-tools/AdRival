import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { dispatchPlatformSearch } from "@/lib/pipeline/dispatch";
import { AD_PLATFORMS, parseKeywords, type AdPlatform } from "@/lib/platforms";

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

    const jobId = uuidv4();

    after(() => {
      void dispatchPlatformSearch(jobId, keywords, platform);
    });

    return NextResponse.json({
      jobId,
      keyword: keywords.join(", "),
      keywords,
      platform,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
