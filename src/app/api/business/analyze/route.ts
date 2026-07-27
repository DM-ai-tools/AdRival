import { NextResponse } from "next/server";
import { analyzeBusinessUrl } from "@/lib/openrouter/businessAnalyzer";
import { resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";

export const runtime = "nodejs";
export const maxDuration = 120;

function friendlyOpenRouterError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/402|credits|max_tokens/i.test(message)) {
    return "OpenRouter credit limit hit. Add credits at https://openrouter.ai/settings/credits — or retry (we now use a smaller token limit).";
  }
  if (/401|unauthorized|invalid.*key/i.test(message)) {
    return "OpenRouter API key is invalid. Check OPENROUTER_API_KEY in .env.local.";
  }
  if (/OPENROUTER_API_KEY is not set/i.test(message)) {
    return "OPENROUTER_API_KEY is missing from .env.local.";
  }
  return message;
}

export async function POST(request: Request) {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        {
          error:
            "OPENROUTER_API_KEY is not configured. Add it to .env.local to analyze business URLs.",
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

    // Strict brand pull from the user-entered URL (HTML/CSS + fallbacks)
    try {
      const bundle = await resolveBrandBundle({
        businessUrl: profile.url || url,
        profile,
      });
      profile.brandColors = bundle.colors;
      profile.brandAssets = bundle.assets;
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
      { error: friendlyOpenRouterError(err) },
      { status: 500 },
    );
  }
}
