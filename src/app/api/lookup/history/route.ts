import { NextResponse } from "next/server";
import {
  deleteLookupHistoryRun,
  getLookupAds,
  getLookupJob,
  listLookupHistory,
  listProjects,
} from "@/lib/db";
import {
  errorResponse,
  requireUser,
  resolveProjectAccess,
  visibleProjectKeys,
} from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");

    if (runId) {
      resolveProjectAccess("lookup", runId, user, "view");
      const job = getLookupJob(runId);
      if (!job) {
        return NextResponse.json(
          { error: "Lookup run not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ job, ads: getLookupAds(runId) });
    }

    const visible = visibleProjectKeys(user);
    return NextResponse.json({
      runs: listLookupHistory(500).filter((run) =>
        visible.has(`lookup:${run.id}`),
      ),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const all = searchParams.get("all");
    const runId = searchParams.get("runId");

    if (all === "1" || all === "true") {
      const owned = listProjects({ ownerUserId: user.id }).filter(
        (p) => p.kind === "lookup",
      );
      let removedAds = 0;
      for (const project of owned) {
        removedAds += deleteLookupHistoryRun(project.id).removedAds;
      }
      return NextResponse.json({
        ok: true,
        removedRuns: owned.length,
        removedAds,
      });
    }

    if (!runId) {
      return NextResponse.json(
        { error: "runId or all=1 is required" },
        { status: 400 },
      );
    }

    resolveProjectAccess("lookup", runId, user, "edit");
    const result = deleteLookupHistoryRun(runId);
    if (!result.ok) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      runId,
      removedAds: result.removedAds,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
