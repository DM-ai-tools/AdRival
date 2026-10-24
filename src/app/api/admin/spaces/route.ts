import { NextResponse } from "next/server";
import {
  adminScope,
  errorResponse,
  HttpError,
  requireAdmin,
  scopedUserIds,
  userInScope,
} from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import {
  archiveProjectSpace,
  assignRunsToSpace,
  createProjectSpace,
  getProject,
  getProjectSpace,
  getUserById,
  getUsersByIds,
  listProjectSpaces,
  listRunOverview,
  listSpaceMemberships,
  listUsers,
  removeSpaceMembership,
  renameProjectSpace,
  restoreProjectSpace,
  setProjectSpaceOwner,
  upsertSpaceMembership,
} from "@/lib/db";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

/**
 * Runs and spaces belong to their owner's organisation; unowned rows are
 * platform-only (authz ownerInScope, checked against the scope's user ids).
 */
function ownerCheck(allowed: Set<string> | null): (ownerUserId: string | null | undefined) => boolean {
  return (ownerUserId) => !allowed || (Boolean(ownerUserId) && allowed.has(ownerUserId as string));
}

export async function GET() {
  try {
    const admin = await requireAdmin();
    const scope = adminScope(admin);
    const allowed = scopedUserIds(scope);
    const inScope = ownerCheck(allowed);
    const users = (await listUsers()).filter((u) => u.status === "active" && userInScope(scope, u));
    const memberships = await listSpaceMemberships();
    // Archived runs are listed nowhere on this page.
    const { rows: runs } = await listRunOverview({ ownerUserIds: allowed, activeOnly: true });
    const spaceList = (await listProjectSpaces({ includeArchived: true })).filter((space) =>
      inScope(space.ownerUserId),
    );
    const named = await getUsersByIds([
      ...spaceList.map((space) => space.ownerUserId),
      ...memberships.map((m) => m.userId),
      ...runs.map((run) => run.ownerUserId),
    ]);

    const spaces = spaceList.map((space) => {
      const owner = named.get(space.ownerUserId);
      const spaceRuns = runs.filter((run) => run.spaceId === space.id);
      return {
        id: space.id,
        clientName: space.clientName,
        ownerUserId: space.ownerUserId,
        ownerDisplayName: owner?.displayName ?? null,
        ownerUsername: owner?.username ?? null,
        archivedAt: space.archivedAt ?? null,
        updatedAt: space.updatedAt,
        runCount: spaceRuns.length,
        // Newest first, as listRunOverview returns them.
        runs: spaceRuns.map((run) => ({
          kind: run.kind,
          id: run.id,
          title: run.title,
          status: run.status,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        })),
        shares: memberships
          .filter((m) => m.spaceId === space.id)
          .map((m) => {
            const user = named.get(m.userId);
            return {
              userId: m.userId,
              username: user?.username ?? null,
              displayName: user?.displayName ?? null,
              role: m.role,
            };
          }),
      };
    });

    const unassigned = runs
      .filter((run) => !run.spaceId)
      .map((run) => {
        const owner = run.ownerUserId ? named.get(run.ownerUserId) : null;
        return {
          kind: run.kind,
          id: run.id,
          title: run.title,
          status: run.status,
          ownerUserId: run.ownerUserId ?? null,
          ownerDisplayName: owner?.displayName ?? null,
          ownerUsername: owner?.username ?? null,
          updatedAt: run.updatedAt,
        };
      });

    return NextResponse.json({
      spaces: spaces.filter((space) => !space.archivedAt),
      archivedCount: spaces.filter((space) => space.archivedAt).length,
      archived: spaces
        .filter((space) => space.archivedAt)
        .map((space) => ({
          id: space.id,
          clientName: space.clientName,
          ownerDisplayName: space.ownerDisplayName,
          ownerUsername: space.ownerUsername,
          archivedAt: space.archivedAt,
        })),
      unassigned,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
      })),
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const scope = adminScope(admin);
    const inScope = ownerCheck(scopedUserIds(scope));
    let body: {
      action?: string;
      clientName?: string;
      ownerUserId?: string;
      spaceId?: string;
      userId?: string;
      role?: "viewer" | "editor";
      runs?: Array<{ kind?: string; id?: string }>;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (body.action === "create") {
      const clientName = String(body.clientName ?? "").trim();
      const owner = await getUserById(String(body.ownerUserId ?? ""));
      if (!owner || owner.status !== "active" || !userInScope(scope, owner)) {
        throw new HttpError(400, "Choose an active owner");
      }
      if (clientName.length < 2) {
        throw new HttpError(400, "Enter a client name");
      }
      const space = await createProjectSpace({ clientName, ownerUserId: owner.id });
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.create",
        targetUserId: owner.id,
        details: { spaceId: space.id, clientName },
      });
      return NextResponse.json({ ok: true, spaceId: space.id });
    }

    const space = await getProjectSpace(String(body.spaceId ?? ""));
    if (!space || !inScope(space.ownerUserId)) {
      throw new HttpError(404, "Client space not found", "not_found");
    }

    if (body.action === "restore") {
      const result = await restoreProjectSpace(space.id);
      if (!result.ok) throw new HttpError(409, "This client space is not archived");
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.restore",
        targetUserId: space.ownerUserId,
        details: { spaceId: space.id, clientName: space.clientName, runsRestored: result.runsRestored },
      });
      return NextResponse.json({ ok: true, runsRestored: result.runsRestored });
    }
    // Everything else works on live spaces only.
    if (space.archivedAt) {
      throw new HttpError(409, "This client space is archived. Restore it first.", "space_archived");
    }

    if (body.action === "rename") {
      const clientName = String(body.clientName ?? "").trim();
      if (clientName.length < 2) throw new HttpError(400, "Enter a client name");
      await renameProjectSpace(space.id, clientName);
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.rename",
        targetUserId: space.ownerUserId,
        details: { spaceId: space.id, from: space.clientName, to: clientName },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "share") {
      const target = await getUserById(String(body.userId ?? ""));
      if (!target || target.status !== "active" || !userInScope(scope, target)) {
        throw new HttpError(400, "Choose an active user to share with");
      }
      if (target.id === space.ownerUserId) {
        throw new HttpError(400, "The owner already has this space");
      }
      const role = body.role === "editor" ? "editor" : "viewer";
      await upsertSpaceMembership({
        spaceId: space.id,
        userId: target.id,
        role,
        grantedByUserId: admin.id,
      });
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.share",
        targetUserId: target.id,
        details: { spaceId: space.id, clientName: space.clientName, role },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "revoke") {
      const removed = await removeSpaceMembership(space.id, String(body.userId ?? ""));
      if (!removed) {
        throw new HttpError(404, "That user did not have access to this space", "not_found");
      }
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.revoke",
        targetUserId: body.userId ?? null,
        details: { spaceId: space.id, clientName: space.clientName },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "transfer") {
      const target = await getUserById(String(body.ownerUserId ?? ""));
      if (!target || target.status !== "active" || !userInScope(scope, target)) {
        throw new HttpError(400, "Choose an active user");
      }
      await setProjectSpaceOwner(space.id, target.id);
      // The new owner no longer needs a separate sharing entry.
      await removeSpaceMembership(space.id, target.id);
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.transfer",
        targetUserId: target.id,
        details: {
          spaceId: space.id,
          clientName: space.clientName,
          previousOwnerUserId: space.ownerUserId,
        },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "delete") {
      const result = await archiveProjectSpace(space.id);
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.delete",
        targetUserId: space.ownerUserId,
        details: {
          spaceId: space.id,
          clientName: space.clientName,
          runsArchived: result.runsArchived,
        },
      });
      return NextResponse.json({ ok: true, runsArchived: result.runsArchived });
    }

    if (body.action === "move-runs") {
      const requested = (body.runs ?? [])
        .filter((run) => run.kind === "search" || run.kind === "lookup")
        .map((run) => ({
          kind: run.kind as ProjectKind,
          id: String(run.id ?? ""),
        }))
        .filter((run) => run.id);
      // Only runs the admin may manage.
      const runs: typeof requested = [];
      for (const run of requested) {
        if (inScope((await getProject(run.kind, run.id))?.ownerUserId)) runs.push(run);
      }
      const moved = await assignRunsToSpace(space.id, runs);
      await recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.move_runs",
        details: { spaceId: space.id, moved },
      });
      return NextResponse.json({ ok: true, moved });
    }

    throw new HttpError(400, "Unknown action");
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
