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
    const [projects, credits, periods, providerUsage, runUsage, canStartRun] = await Promise.all([
      listVisibleProjects(user),
      getCreditSummary(user.id),
      listPeriods(user.id),
      usageByProvider({ chargedUserId: user.id }),
      usageByRun({ chargedUserId: user.id }),
      precheckRun(user),
    ]);
    const titleFor = (kind: string | null, id: string | null) =>
      projects.find((p) => p.kind === kind && p.id === id)?.title ?? null;

    return NextResponse.json({
      credits,
      periods: periods.slice(0, 12),
      usageByProvider: providerUsage,
      recentRuns: runUsage
        .slice(0, 20)
        .map((run) => ({
          ...run,
          projectTitle: titleFor(run.projectKind, run.projectId),
        })),
      canStartRun,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
