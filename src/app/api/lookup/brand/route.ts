import { NextResponse } from "next/server";
import { getLookupJob } from "@/lib/db";
import { resolveBrandDisplayName } from "@/lib/pipeline/brandDisplayName";
import { setLookupBusinessBrand } from "@/lib/pipeline/lookupRecreateBridge";
import { resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";

export const runtime = "nodejs";
export const maxDuration = 90;

/** Attach / refresh brand website on a lookup job. */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const lookupId = String(body.lookupId ?? "").trim();
    const businessUrl = String(body.businessUrl ?? "").trim();
    if (!lookupId) {
      return NextResponse.json(
        { error: "lookupId is required" },
        { status: 400 },
      );
    }
    if (!businessUrl) {
      return NextResponse.json(
        { error: "businessUrl is required" },
        { status: 400 },
      );
    }

    const lookup = getLookupJob(lookupId);
    if (!lookup) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    let profile = lookup.businessProfile || null;
    const warnings: string[] = [];
    try {
      const brand = await resolveBrandBundle({
        businessUrl,
        profile,
      });
      const businessName = resolveBrandDisplayName({
        businessUrl: brand.finalUrl || businessUrl,
        siteName: brand.assets?.siteName,
        profileName: profile?.businessName,
        competitorName: lookup.queryName,
      });
      profile = {
        ...(profile || {
          url: brand.finalUrl || businessUrl,
          businessName,
          industry: "",
          description: "",
          offerings: [],
          competitorKeywords: [],
          positioningSummary: "",
        }),
        url: brand.finalUrl || businessUrl,
        businessName,
        brandColors: brand.colors,
        brandAssets: brand.assets || profile?.brandAssets || null,
        brandDesign: brand.design || profile?.brandDesign || null,
        analyzedAt: new Date().toISOString(),
      };
      warnings.push(...brand.warnings);
    } catch (err) {
      warnings.push(
        `Brand analyze deferred: ${(err as Error).message || String(err)}`,
      );
    }

    const job = setLookupBusinessBrand(lookupId, {
      businessUrl,
      businessProfile: profile,
    });

    return NextResponse.json({ job, warnings });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save brand" },
      { status: 500 },
    );
  }
}
