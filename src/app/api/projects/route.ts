import { NextResponse } from "next/server";
import { errorResponse, listVisibleProjects, requireUser } from "@/lib/authz";
import { creditsForRun } from "@/lib/accounting/service";

export const runtime = "nodejs";

/**
 * "My Projects" and "Shared With Me". Shared entries expose only the owner's
 * display name and the caller's permission level — never the owner's other
 * projects, settings or credit balance.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const projects = await listVisibleProjects(user);
    // The caller's own spend on each project, not the owner's.
    const spent = new Map(
      await Promise.all(
        projects.map(async (p) => [p.id, (await creditsForRun(p.id, user.id)).creditsCharged] as const),
      ),
    );

    const shape = (p: (typeof projects)[number]) => ({
      kind: p.kind,
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      archivedAt: p.archivedAt,
      accessRole: p.accessRole,
      ownerDisplayName: p.ownerDisplayName,
      creditsCharged: spent.get(p.id) ?? 0,
    });

    return NextResponse.json({
      mine: projects.filter((p) => p.accessRole === "owner").map(shape),
      sharedWithMe: projects
        .filter((p) => p.accessRole !== "owner")
        .map(shape),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
