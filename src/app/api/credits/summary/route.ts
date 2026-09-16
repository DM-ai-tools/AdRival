import { NextResponse } from "next/server";
import { errorResponse, listVisibleProjects, requireUser } from "@/lib/authz";
import {
  getCreditSummary,
  listPeriods,
  usageByProvider,
  usageByRun,
} from "@/lib/accounting/service";
import { precheckRun } from "@/lib/accounting/run";

export const runtime = "nodejs";

/**
 * The signed-in user's own credit dashboard. Scoped to their id, so it cannot
 * be used to read anyone else's balance.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const projects = listVisibleProjects(user);
    const titleFor = (kind: string | null, id: string | null) =>
      projects.find((p) => p.kind === kind && p.id === id)?.title ?? null;

    return NextResponse.json({
      credits: getCreditSummary(user.id),
      periods: listPeriods(user.id).slice(0, 12),
      usageByProvider: usageByProvider({ chargedUserId: user.id }),
      recentRuns: usageByRun({ chargedUserId: user.id })
        .slice(0, 20)
        .map((run) => ({
          ...run,
          projectTitle: titleFor(run.projectKind, run.projectId),
        })),
      canStartRun: precheckRun(user),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
