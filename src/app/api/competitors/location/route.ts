import { NextResponse } from "next/server";
import { getCompetitor, getCompetitorsByRun, getJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import {
  enrichCompetitorFirecrawlLocation,
  enrichRunFirecrawlLocations,
} from "@/lib/pipeline/competitorLocation";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/competitors/location
 * Body: { runId?: string, competitorId?: string, onlyUnknown?: boolean }
 *
 * Firecrawl web-search address lookup for the Location column (on-demand).
 */
export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as {
      runId?: string;
      competitorId?: string;
      onlyUnknown?: boolean;
    };

    if (body.competitorId) {
      const competitor = getCompetitor(body.competitorId);
      if (!competitor) {
        return NextResponse.json(
          { error: "Competitor not found" },
          { status: 404 },
        );
      }
      resolveProjectAccess("search", competitor.runId, user, "run");
      const job = getJob(competitor.runId);

      const location = await runBillable(
        {
          user,
          operation: "competitor.location_refresh",
          projectKind: "search",
          projectId: competitor.runId,
          runId: competitor.runId,
        },
        () =>
          enrichCompetitorFirecrawlLocation({
            competitorId: competitor.id,
            pageName: competitor.pageName,
            website: competitor.brand?.website || null,
            landingPageUrl: competitor.sampleAd?.landingPageUrl || null,
            domain: competitor.sampleAd?.domain || null,
            countryHint:
              typeof competitor.country === "string" ? competitor.country : null,
            geoMode: job?.geoMode || "countrywide",
            targetLocations: job?.targetLocations || [],
          }),
      );

      const updated = getCompetitor(body.competitorId);
      return NextResponse.json({
        ok: true,
        mode: "single",
        competitorId: body.competitorId,
        location,
        competitor: updated,
      });
    }

    if (body.runId) {
      resolveProjectAccess("search", body.runId, user, "run");
      const job = getJob(body.runId);
      if (!job) {
        return NextResponse.json({ error: "Run not found" }, { status: 404 });
      }
      const runId = body.runId;
      const result = await runBillable(
        {
          user,
          operation: "search.location_refresh_batch",
          projectKind: "search",
          projectId: runId,
          runId,
        },
        () =>
          enrichRunFirecrawlLocations(runId, {
            onlyUnknown: body.onlyUnknown !== false,
          }),
      );
      return NextResponse.json({
        ok: true,
        mode: "batch",
        runId,
        ...result,
        competitors: getCompetitorsByRun(runId),
      });
    }

    return NextResponse.json(
      { error: "runId or competitorId is required" },
      { status: 400 },
    );
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        {
          error: (err as Error).message,
          code: (err as { code?: string }).code,
        },
        { status: 402 },
      );
    }
    return errorResponse(err);
  }
}
