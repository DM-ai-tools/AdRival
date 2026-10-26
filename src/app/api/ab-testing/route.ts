import { NextResponse } from "next/server";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { getIcps } from "@/lib/db";
import { maskIcp } from "@/lib/clientFacing";
import { AWARENESS_STAGES, computeCoverage } from "@/lib/pipeline/awareness/coverage";
import { pickBaseForStage, type AbPage } from "@/lib/pipeline/awareness/abPages";
import { loadAbSource } from "@/lib/pipeline/awareness/abSource";
import { icpProfileReady } from "@/lib/pipeline/awareness/icp";
import type { AwarenessStage, ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const kind: ProjectKind = url.searchParams.get("kind") === "lookup" ? "lookup" : "search";
    const id = (url.searchParams.get("id") ?? "").trim();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await resolveProjectAccess(kind, id, user, "view");

    const source = await loadAbSource(kind, id);
    if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const pages: AbPage[] = source.pages;
    const baseForStage: Partial<Record<AwarenessStage, AbPage | null>> = {};
    for (const stage of AWARENESS_STAGES) baseForStage[stage] = pickBaseForStage(pages, stage);

    return NextResponse.json({
      pages,
      coverage: computeCoverage(pages),
      icps: (await getIcps(kind, id)).map(maskIcp),
      profileReady: icpProfileReady(source.profile),
      businessUrl: source.businessUrl,
      baseForStage,
    });
  } catch (err) {
    console.error("[ab-testing]", err);
    return errorResponse(err);
  }
}
