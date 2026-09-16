import { NextResponse } from "next/server";
import { errorResponse, requireUser, resolveSpaceAccess } from "@/lib/authz";
import {
  createProjectSpace,
  getUserById,
  listProjectSpaces,
  listProjects,
  listSpaceMemberships,
} from "@/lib/db";
import { recordAudit } from "@/lib/accounting/records";

export const runtime = "nodejs";

/**
 * Client spaces the caller owns or that were shared with them. A space is the
 * unit of sharing — every search and lookup inside it travels together.
 */
export async function GET() {
  try {
    const user = await requireUser();
    const memberships = listSpaceMemberships().filter((m) => m.userId === user.id);
    const sharedIds = new Set(memberships.map((m) => m.spaceId));
    const spaces = listProjectSpaces().filter(
      (space) => space.ownerUserId === user.id || sharedIds.has(space.id),
    );
    const runs = listProjects();

    return NextResponse.json({
      spaces: spaces.map((space) => {
        const access = resolveSpaceAccess(space.id, user, "view");
        const owner = getUserById(space.ownerUserId);
        return {
          id: space.id,
          clientName: space.clientName,
          accessRole: access.role,
          ownerDisplayName:
            space.ownerUserId === user.id ? null : owner?.displayName ?? null,
          runCount: runs.filter((run) => run.spaceId === space.id && !run.archivedAt)
            .length,
          updatedAt: space.updatedAt,
        };
      }),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    let body: { clientName?: string } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const clientName = String(body.clientName ?? "").trim();
    if (clientName.length < 2 || clientName.length > 80) {
      return NextResponse.json(
        { error: "Enter a client name (2–80 characters)." },
        { status: 400 },
      );
    }
    const space = createProjectSpace({ clientName, ownerUserId: user.id });
    recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: "space.create",
      details: { clientName, spaceId: space.id },
    });
    return NextResponse.json({
      space: {
        id: space.id,
        clientName: space.clientName,
        accessRole: "owner",
        ownerDisplayName: null,
        runCount: 0,
        updatedAt: space.updatedAt,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
