import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { dispatchPlatformLookup } from "@/lib/pipeline/dispatch";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";
import type { LookupPageCandidate } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
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

    const lookupId = uuidv4();
    const queryName = forcedCandidate?.name || name;

    after(() => {
      void dispatchPlatformLookup(
        lookupId,
        queryName,
        platform,
        forcedCandidate,
      );
    });

    return NextResponse.json({
      lookupId,
      queryName,
      platform,
      forced: Boolean(forcedCandidate),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
