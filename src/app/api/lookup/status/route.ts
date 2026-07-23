import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lookupId = searchParams.get("lookupId");
  if (!lookupId) {
    return NextResponse.json({ error: "lookupId is required" }, { status: 400 });
  }

  const job = getLookupJob(lookupId);
  if (!job) {
    return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
  }

  const ads = getLookupAds(lookupId);
  return NextResponse.json({ job, ads });
}
