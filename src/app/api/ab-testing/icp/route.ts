import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { upsertIcp } from "@/lib/db";
import { maskIcp } from "@/lib/clientFacing";
import { AWARENESS_STAGES } from "@/lib/pipeline/awareness/coverage";
import { generateIcp, icpProfileReady } from "@/lib/pipeline/awareness/icp";
import { loadAbSource } from "@/lib/pipeline/awareness/abSource";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const kind: ProjectKind = body.kind === "lookup" ? "lookup" : "search";
    const id = String(body.id ?? "").trim();
    const stage = AWARENESS_STAGES.find((s) => s === body.stage);
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    if (!stage) return NextResponse.json({ error: "Unknown awareness stage" }, { status: 400 });
    await resolveProjectAccess(kind, id, user, "run");

    const source = await loadAbSource(kind, id);
    if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const profile = source.profile;
    // Refuse before any billing or AI call.
    if (!profile || !icpProfileReady(profile)) {
      return NextResponse.json({ error: "Add your business website first" }, { status: 400 });
    }

    const competitorPages = source.pages
      .filter((p) => p.levels)
      .map((p) => ({
        brand: p.brand,
        headline: p.headline,
        awarenessStage: p.levels!.awarenessStage,
        audienceLevel: p.levels!.audienceLevel,
      }));

    const content = await runBillable(
      {
        user,
        operation: "icp.generate",
        projectKind: kind,
        projectId: id,
        runId: id,
      },
      () => generateIcp({ profile, stage, keywords: source.keywords, competitorPages }),
    );
    const icp = await upsertIcp({
      ...content,
      id: randomUUID(),
      source: { kind, id },
      stage,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ icp: maskIcp(icp) });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    console.error("[ab-testing/icp]", err);
    return errorResponse(err);
  }
}
