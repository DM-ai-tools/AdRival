import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { analyzeBusinessUrl } from "@/lib/openrouter/businessAnalyzer";
import { analyzeServiceArea } from "@/lib/openrouter/serviceArea";
import { prefetchBrandBranding, resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";
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
    const user = await requireUser();

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

    // URL analysis is not attached to a project yet — it is what produces the
    // profile a project is later created from — so it bills the caller directly.
    const profile = await runBillable(
      {
        user,
        operation: "business.analyze_url",
        projectKind: null,
        projectId: null,
        runId: null,
      },
      async () => {
        // Reading the site's branding is slow and needs only the URL, so it
        // starts alongside the profile analysis instead of after it.
        const branding = prefetchBrandBranding(url);
        const base = await analyzeBusinessUrl(url);
        // Location, local-vs-national suggestion and search rings run
        // alongside the brand read; it never fails the analysis.
        const area = analyzeServiceArea(base);

        // Brand identity via site branding (+ links) — colors, fonts, logo, socials
        let bundle: Awaited<ReturnType<typeof resolveBrandBundle>> | null = null;
        try {
          bundle = await resolveBrandBundle({
            businessUrl: base.url || url,
            profile: base,
            prefetched: branding,
          });
        } catch (err) {
          console.warn("[business/analyze] brand bundle failed", err);
        }
        const analyzed = await area;
        if (bundle) {
          analyzed.brandColors = bundle.colors;
          analyzed.brandAssets = bundle.assets;
          analyzed.brandDesign = bundle.design;
          if (bundle.warnings.length) {
            console.warn("[business/analyze] brand warnings", bundle.warnings);
          }
        }
        return analyzed;
      },
    );

    return NextResponse.json({ profile });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    if (err instanceof Error && err.name === "HttpError") {
      return errorResponse(err);
    }
    console.error("[business/analyze]", err);
    return NextResponse.json(
      { error: friendlyAnalyzeError(err) },
      { status: 500 },
    );
  }
}
