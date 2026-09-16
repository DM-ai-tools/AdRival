import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { errorResponse, requireUser, resolveSpaceAccess } from "@/lib/authz";
import { precheckRun, runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { maskClientFacingText } from "@/lib/clientFacing";
import { saveLookupJob, updateLookupJob } from "@/lib/db";
import { dispatchPlatformLookup } from "@/lib/pipeline/dispatch";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";
import type { LookupPageCandidate } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const user = await requireUser();

    const precheck = precheckRun(user);
    if (!precheck.ok) {
      return NextResponse.json(
        {
          error: precheck.message,
          code: precheck.reason,
          availableSubunits: precheck.availableSubunits,
        },
        { status: precheck.reason === "suspended" ? 403 : 402 },
      );
    }

    const body = await request.json();
    const name = String(body.name ?? body.queryName ?? "").trim();
    if (!name) {
      return NextResponse.json(
        { error: "Competitor name is required" },
        { status: 400 },
      );
    }

    const platformRaw = String(body.platform ?? "facebook").toLowerCase();
    const platform = (
      AD_PLATFORMS.includes(platformRaw as AdPlatform)
        ? platformRaw
        : "facebook"
    ) as AdPlatform;

    const forcedCandidate =
      body.forcedCandidate && typeof body.forcedCandidate === "object"
        ? (body.forcedCandidate as LookupPageCandidate)
        : null;

    if (
      forcedCandidate &&
      (!forcedCandidate.pageId || !forcedCandidate.name)
    ) {
      return NextResponse.json(
        { error: "forcedCandidate requires pageId and name" },
        { status: 400 },
      );
    }

    if (!process.env.SOCIAVAULT_API_KEY) {
      return NextResponse.json(
        { error: "Ad library access is not configured. Please contact support." },
        { status: 500 },
      );
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        {
          error:
            "Competitor verification is not configured. Please contact support.",
        },
        { status: 500 },
      );
    }

    const lookupId = uuidv4();
    const queryName = forcedCandidate?.name || name;
    const businessUrl =
      typeof body.businessUrl === "string" ? body.businessUrl.trim() : "";
    const spaceId =
      typeof body.spaceId === "string" && body.spaceId.trim()
        ? body.spaceId.trim()
        : null;
    if (spaceId) resolveSpaceAccess(spaceId, user, "run");

    // Stamp ownership before dispatching so the row is never world-readable.
    const startedAt = new Date().toISOString();
    saveLookupJob({
      id: lookupId,
      queryName,
      platform,
      status: "running",
      progress: {
        stage: "queued",
        message: "Reserving credits…",
        candidatesFound: 0,
        adsFetched: 0,
        pagesScanned: 0,
      },
      candidates: [],
      adIds: [],
      businessUrl: businessUrl || null,
      ownerUserId: user.id,
      spaceId,
      createdAt: startedAt,
      updatedAt: startedAt,
    });

    after(async () => {
      try {
        await runBillable(
          {
            user,
            operation: "lookup.competitor_ads",
            projectKind: "lookup",
            projectId: lookupId,
            runId: lookupId,
          },
          () =>
            dispatchPlatformLookup(
              lookupId,
              queryName,
              platform,
              forcedCandidate,
              businessUrl ? { businessUrl } : undefined,
            ),
        );
      } catch (err) {
        const message = isCreditError(err)
          ? (err as Error).message
          : maskClientFacingText(`Lookup failed: ${(err as Error).message}`) ||
            "Lookup failed";
        updateLookupJob(lookupId, {
          status: "failed",
          error: message,
          progress: {
            stage: "failed",
            message,
            candidatesFound: 0,
            adsFetched: 0,
            pagesScanned: 0,
          },
        });
      }
    });

    return NextResponse.json({
      lookupId,
      queryName,
      platform,
      businessUrl: businessUrl || null,
      forced: Boolean(forcedCandidate),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
