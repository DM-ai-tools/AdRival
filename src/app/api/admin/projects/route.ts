import { NextResponse } from "next/server";
import { getUsersByIds, listProjects } from "@/lib/db";
import { adminScope, errorResponse, ownerInScope, requireAdmin } from "@/lib/authz";
import { listMemberships } from "@/lib/accounting/records";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

/**
 * All projects, with owner and share list. `?unassigned=1` returns the legacy
 * rows that pre-date multi-user support and are still awaiting an owner.
 */
export async function GET(request: Request) {
  try {
    const admin = await requireAdmin();
    const scope = adminScope(admin);
    const url = new URL(request.url);
    const unassignedOnly = url.searchParams.get("unassigned") === "1";
    const ownerUserId = url.searchParams.get("ownerUserId") || undefined;

    const listed = await listProjects({ unassignedOnly, ownerUserId });
    // Each distinct owner checked once; the check must be awaited (a Promise is truthy).
    const ownerKeys = [...new Set(listed.map((p) => p.ownerUserId ?? ""))];
    const ownerAllowed = new Map(
      await Promise.all(
        ownerKeys.map(async (id) => [id, await ownerInScope(scope, id || null)] as const),
      ),
    );
    const projects = listed.filter((p) => ownerAllowed.get(p.ownerUserId ?? "") === true);
    const memberships = await listMemberships();
    const users = await getUsersByIds([
      ...projects.map((p) => p.ownerUserId),
      ...memberships.map((m) => m.userId),
    ]);
    const unassignedCount =
      scope.kind === "platform" ? (await listProjects({ unassignedOnly: true })).length : 0;

    return NextResponse.json({
      projects: projects.map((project) => {
        const owner = project.ownerUserId
          ? users.get(project.ownerUserId) ?? null
          : null;
        const shares = memberships
          .filter(
            (m) =>
              m.projectKind === (project.kind as ProjectKind) &&
              m.projectId === project.id,
          )
          .map((m) => {
            const user = users.get(m.userId);
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
      // Unowned legacy runs are a platform matter.
      unassignedCount,
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
