import { NextResponse } from "next/server";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { runBillable } from "@/lib/accounting/run";
import { isCreditError } from "@/lib/accounting/errors";
import { loadAbSource } from "@/lib/pipeline/awareness/abSource";
import { mapPool } from "@/lib/pipeline/pool";
import { labelCompetitorLevels, labelLookupAdLevels } from "@/lib/pipeline/landingPageAnalysis";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    const body = await request.json();
    const kind: ProjectKind = body.kind === "lookup" ? "lookup" : "search";
    const id = String(body.id ?? "").trim();
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const confirm = body.confirm === true;
    await resolveProjectAccess(kind, id, user, confirm ? "run" : "view");

    const source = await loadAbSource(kind, id);
    if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const todo = source.pages.filter((p) => p.status === "completed" && !p.levels);
    if (!confirm) return NextResponse.json({ count: todo.length });
    if (!todo.length) return NextResponse.json({ labelled: 0, failed: 0 });

    const results = await runBillable(
      {
        user,
        operation: "page.label_levels",
        projectKind: kind,
        projectId: id,
        runId: id,
      },
      async () => {
        const settled = await mapPool(todo, 4, async (page) => {
          if (page.source === "competitor") await labelCompetitorLevels(page.id);
          else await labelLookupAdLevels(page.id);
        });
        const credit = settled.find((r) => r.status === "rejected" && isCreditError(r.reason));
        if (credit && credit.status === "rejected") throw credit.reason;
        return settled;
      },
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    return NextResponse.json({ labelled: results.length - failed, failed });
  } catch (err) {
    if (isCreditError(err)) {
      return NextResponse.json(
        { error: (err as Error).message, code: (err as { code?: string }).code },
        { status: 402 },
      );
    }
    console.error("[ab-testing/label]", err);
    return errorResponse(err);
  }
}
