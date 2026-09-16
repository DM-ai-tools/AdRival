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
    const projects = listVisibleProjects(user);

    const shape = (p: (typeof projects)[number]) => ({
      kind: p.kind,
      id: p.id,
      title: p.title,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      archivedAt: p.archivedAt,
      accessRole: p.accessRole,
      ownerDisplayName: p.ownerDisplayName,
      // The caller's own spend on this project, not the owner's.
      creditsCharged: creditsForRun(p.id, user.id).creditsCharged,
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
