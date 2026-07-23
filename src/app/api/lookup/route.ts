import { after } from "next/server";
import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { dispatchPlatformLookup } from "@/lib/pipeline/dispatch";
import { AD_PLATFORMS, type AdPlatform } from "@/lib/platforms";

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

    after(() => {
      void dispatchPlatformLookup(lookupId, name, platform);
    });

    return NextResponse.json({ lookupId, queryName: name, platform });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
