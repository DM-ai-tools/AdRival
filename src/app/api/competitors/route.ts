import { NextResponse } from "next/server";
import { getCompetitorsByRun, getJob, listAllCompetitors } from "@/lib/db";
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
      resolveProjectAccess("search", runId, user, "view");
      const job = getJob(runId);
      const competitors = getCompetitorsByRun(runId);
      return NextResponse.json({ job, competitors });
    }

    // Without a runId this used to return every competitor in the store.
    // It is now restricted to runs the caller can actually see.
    const visible = visibleProjectKeys(user);
    return NextResponse.json({
      competitors: listAllCompetitors(2000).filter((c) =>
        visible.has(`search:${c.runId}`),
      ),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
