import { NextResponse } from "next/server";
import { getLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { resolveBrandDisplayName } from "@/lib/pipeline/brandDisplayName";
import { setLookupBusinessBrand } from "@/lib/pipeline/lookupRecreateBridge";
import { resolveBrandBundle } from "@/lib/pipeline/resolveBrandBundle";

export const runtime = "nodejs";
export const maxDuration = 90;

/** Attach / refresh brand website on a lookup job. */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
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

    resolveProjectAccess("lookup", lookupId, user, "run");

    const lookup = getLookupJob(lookupId);
    if (!lookup) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    let profile = lookup.businessProfile || null;
    const warnings: string[] = [];
    try {
      const brand = await runBillable(
        {
          user,
          operation: "lookup.resolve_brand",
          projectKind: "lookup",
          projectId: lookupId,
          runId: lookupId,
        },
        () => resolveBrandBundle({ businessUrl, profile }),
      );
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
      // Credit failures must not be swallowed into a soft warning.
      if (isCreditError(err)) throw err;
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
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    return errorResponse(err);
  }
}
