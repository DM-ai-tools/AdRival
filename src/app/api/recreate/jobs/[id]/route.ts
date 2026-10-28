import { NextResponse } from "next/server";
import { getRecreateJob } from "@/lib/data/recreateJobs";
import { HttpError, errorResponse, requireUser } from "@/lib/authz";
import { RecreateJobNotFoundError, stopRecreateJob } from "@/lib/pipeline/recreateQueue";
import { toJobDto } from "@/lib/recreateList";

export const runtime = "nodejs";

/**
 * Stop a running recreation or remove a queued one (with its empty version).
 * Only the user who added it can. → { job } (null once removed).
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    await stopRecreateJob(id, user.id);
    const job = await getRecreateJob(id);
    return NextResponse.json({ job: job ? toJobDto(job) : null });
  } catch (err) {
    if (err instanceof RecreateJobNotFoundError) {
      return errorResponse(new HttpError(404, err.message, "not_found"));
    }
    console.error("[recreate/jobs/:id]", err);
    return errorResponse(err);
  }
}
