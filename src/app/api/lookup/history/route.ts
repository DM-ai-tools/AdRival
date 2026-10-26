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
  visibleRunIds,
} from "@/lib/authz";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const runId = searchParams.get("runId");

    if (runId) {
      await resolveProjectAccess("lookup", runId, user, "view");
      const job = await getLookupJob(runId);
      if (!job) {
        return NextResponse.json(
          { error: "Lookup run not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ job, ads: await getLookupAds(runId) });
    }

    // Only the lookups the caller may see are read.
    const visible = await visibleRunIds(user, "lookup");
    return NextResponse.json({
      runs: await listLookupHistory(500, { ids: visible }),
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
      const owned = (await listProjects({ ownerUserId: user.id })).filter(
        (p) => p.kind === "lookup",
      );
      let removedAds = 0;
      for (const project of owned) {
        removedAds += (await deleteLookupHistoryRun(project.id)).removedAds;
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

    await resolveProjectAccess("lookup", runId, user, "edit");
    const result = await deleteLookupHistoryRun(runId);
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
