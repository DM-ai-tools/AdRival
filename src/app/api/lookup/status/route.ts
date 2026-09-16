import { NextResponse } from "next/server";
import { getLookupAds, getLookupJob } from "@/lib/db";
import { errorResponse, requireUser, resolveProjectAccess } from "@/lib/authz";
import { reportRunCredits } from "@/lib/accounting/run";
import { redactProviderCreditText } from "@/lib/accounting/errors";
import { getCreditSummary } from "@/lib/accounting/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const { searchParams } = new URL(request.url);
    const lookupId = searchParams.get("lookupId");
    if (!lookupId) {
      return NextResponse.json({ error: "lookupId is required" }, { status: 400 });
    }

    const access = resolveProjectAccess("lookup", lookupId, user, "view");

    const job = getLookupJob(lookupId);
    if (!job) {
      return NextResponse.json({ error: "Lookup not found" }, { status: 404 });
    }

    const ads = getLookupAds(lookupId);
    const summary = getCreditSummary(user.id);
    const isAdmin = user.role === "admin";
    return NextResponse.json({
      job: {
        ...job,
        error: redactProviderCreditText(job.error, isAdmin) ?? null,
        progress: job.progress
          ? {
              ...job.progress,
              message:
                redactProviderCreditText(job.progress.message, isAdmin) ??
                job.progress.message,
            }
          : job.progress,
      },
      ads,
      access: {
        role: access.role,
        ownerIsSelf: access.project.ownerUserId === user.id,
      },
      credits: {
        ...reportRunCredits(user.id, lookupId),
        lowCredit: summary.lowCredit,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
