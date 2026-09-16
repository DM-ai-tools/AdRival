import { NextResponse } from "next/server";
import { getUserById, listProjects } from "@/lib/db";
import { errorResponse, requireAdmin } from "@/lib/authz";
import { listMemberships } from "@/lib/accounting/records";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

/**
 * All projects, with owner and share list. `?unassigned=1` returns the legacy
 * rows that pre-date multi-user support and are still awaiting an owner.
 */
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const unassignedOnly = url.searchParams.get("unassigned") === "1";
    const ownerUserId = url.searchParams.get("ownerUserId") || undefined;

    const projects = listProjects({ unassignedOnly, ownerUserId });
    const memberships = listMemberships();

    return NextResponse.json({
      projects: projects.map((project) => {
        const owner = project.ownerUserId
          ? getUserById(project.ownerUserId)
          : null;
        const shares = memberships
          .filter(
            (m) =>
              m.projectKind === (project.kind as ProjectKind) &&
              m.projectId === project.id,
          )
          .map((m) => {
            const user = getUserById(m.userId);
            return {
              userId: m.userId,
              username: user?.username ?? null,
              displayName: user?.displayName ?? null,
              role: m.role,
              grantedAt: m.createdAt,
            };
          });
        return {
          ...project,
          ownerUsername: owner?.username ?? null,
          ownerDisplayName: owner?.displayName ?? null,
          shares,
        };
      }),
      unassignedCount: listProjects({ unassignedOnly: true }).length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
