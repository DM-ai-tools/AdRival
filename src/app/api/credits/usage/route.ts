import { NextResponse } from "next/server";
import { errorResponse, listVisibleProjects, requireUser } from "@/lib/authz";
import { queryProviderCalls } from "@/lib/accounting/service";
import { redactProviderCreditText } from "@/lib/accounting/errors";
import { maskClientFacingText } from "@/lib/clientFacing";
import type { ProviderCallStatus, ProviderId } from "@/lib/types";

export const runtime = "nodejs";

/** The user's own usage history, filterable by date, project, provider, status. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url);
    const value = (key: string) => url.searchParams.get(key)?.trim() || undefined;

    const projects = listVisibleProjects(user);
    const requestedProjectId = value("projectId");
    if (
      requestedProjectId &&
      !projects.some((p) => p.id === requestedProjectId)
    ) {
      // Filtering by a project the user cannot see returns nothing rather than
      // leaking whether it exists.
      return NextResponse.json({ rows: [], total: 0, projects });
    }

    const { rows, total } = queryProviderCalls({
      // Always pinned to the caller — the filter cannot be widened by query args.
      chargedUserId: user.id,
      projectId: requestedProjectId,
      provider: value("provider") as ProviderId | undefined,
      status: value("status") as ProviderCallStatus | undefined,
      from: value("from"),
      to: value("to"),
      limit: Math.min(Number(value("limit") ?? 100), 500),
      offset: Number(value("offset") ?? 0),
    });

    return NextResponse.json({
      rows: rows.map((call) => ({
        id: call.id,
        startedAt: call.startedAt,
        completedAt: call.completedAt,
        provider: call.provider,
        model: call.model,
        endpoint: call.endpoint,
        operation: call.operation,
        projectKind: call.projectKind,
        projectId: call.projectId,
        projectTitle:
          projects.find(
            (p) => p.kind === call.projectKind && p.id === call.projectId,
          )?.title ?? null,
        runId: call.runId,
        usage: call.usage,
        usageConfidence: call.usageConfidence,
        creditsCharged: call.creditsCharged,
        status: call.status,
        errorMessage: maskClientFacingText(
          redactProviderCreditText(call.errorMessage, false),
        ),
        // Monetary cost and provider request ids stay in the admin view.
      })),
      total,
      projects: projects.map((p) => ({
        kind: p.kind,
        id: p.id,
        title: p.title,
        accessRole: p.accessRole,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
