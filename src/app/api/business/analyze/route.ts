import { NextResponse } from "next/server";
import { analyzeBusinessUrl } from "@/lib/openrouter/businessAnalyzer";
import { resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";
import { sanitizeClientFacingText } from "@/lib/clientFacing";

export const runtime = "nodejs";
export const maxDuration = 180;

function friendlyAnalyzeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/402|credits|max_tokens/i.test(message)) {
    return "URL analysis credit limit reached. Please try again later or contact support.";
  }
  if (/401|unauthorized|invalid.*key/i.test(message)) {
    return "URL analysis is not configured correctly. Please contact support.";
  }
  if (/OPENROUTER_API_KEY is not set|API_KEY is missing/i.test(message)) {
    return "URL analysis is not configured. Please contact support.";
  }
  return sanitizeClientFacingText(message);
}

export async function POST(request: Request) {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        {
          error:
            "URL analysis is not configured. Please contact support.",
        },
        { status: 500 },
      );
    }

    const body = await request.json();
    const url = String(body.url ?? "").trim();
    if (!url) {
      return NextResponse.json(
        { error: "Business URL is required" },
        { status: 400 },
      );
    }

    const profile = await analyzeBusinessUrl(url);

    // Brand identity via site branding (+ links) — colors, fonts, logo, socials
    try {
      const bundle = await resolveBrandBundle({
        businessUrl: profile.url || url,
        profile,
      });
      profile.brandColors = bundle.colors;
      profile.brandAssets = bundle.assets;
      profile.brandDesign = bundle.design;
      if (bundle.warnings.length) {
        console.warn("[business/analyze] brand warnings", bundle.warnings);
      }
    } catch (err) {
      console.warn("[business/analyze] brand bundle failed", err);
    }

    return NextResponse.json({ profile });
  } catch (err) {
    console.error("[business/analyze]", err);
    return NextResponse.json(
      { error: friendlyAnalyzeError(err) },
      { status: 500 },
    );
  }
}
