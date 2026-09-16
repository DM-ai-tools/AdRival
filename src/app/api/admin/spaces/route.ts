import { NextResponse } from "next/server";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { recordAudit } from "@/lib/accounting/records";
import {
  archiveProjectSpace,
  assignRunsToSpace,
  createProjectSpace,
  getProjectSpace,
  getUserById,
  listProjectSpaces,
  listSpaceMemberships,
  listUsers,
  readDb,
  removeSpaceMembership,
  setProjectSpaceOwner,
  upsertSpaceMembership,
} from "@/lib/db";
import type { ProjectKind } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireAdmin();
    const users = listUsers().filter((u) => u.status === "active");
    const db = readDb();
    const memberships = listSpaceMemberships();
    const runs = [
      ...db.jobs.map((job) => ({
        kind: "search" as const,
        id: job.id,
        title: job.keyword || "Keyword search",
        status: job.status,
        ownerUserId: job.ownerUserId ?? null,
        spaceId: job.spaceId ?? null,
        archivedAt: job.archivedAt ?? null,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
      })),
      ...(db.lookupJobs ?? []).map((job) => ({
        kind: "lookup" as const,
        id: job.id,
        title: job.queryName || "Competitor lookup",
        status: job.status,
        ownerUserId: job.ownerUserId ?? null,
        spaceId: job.spaceId ?? null,
        archivedAt: job.archivedAt ?? null,
        updatedAt: job.updatedAt,
        createdAt: job.createdAt,
      })),
    ];

    const spaces = listProjectSpaces({ includeArchived: true }).map((space) => {
      const owner = getUserById(space.ownerUserId);
      const spaceRuns = runs.filter(
        (run) => run.spaceId === space.id && !run.archivedAt,
      );
      return {
        id: space.id,
        clientName: space.clientName,
        ownerUserId: space.ownerUserId,
        ownerDisplayName: owner?.displayName ?? null,
        ownerUsername: owner?.username ?? null,
        archivedAt: space.archivedAt ?? null,
        updatedAt: space.updatedAt,
        runCount: spaceRuns.length,
        runs: spaceRuns
          .slice()
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((run) => ({
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
            const user = getUserById(m.userId);
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
      .filter((run) => !run.spaceId && !run.archivedAt)
      .map((run) => {
        const owner = run.ownerUserId ? getUserById(run.ownerUserId) : null;
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
      unassigned,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
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
      const owner = getUserById(String(body.ownerUserId ?? ""));
      if (!owner || owner.status !== "active") {
        throw new HttpError(400, "Choose an active owner");
      }
      if (clientName.length < 2) {
        throw new HttpError(400, "Enter a client name");
      }
      const space = createProjectSpace({ clientName, ownerUserId: owner.id });
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.create",
        targetUserId: owner.id,
        details: { spaceId: space.id, clientName },
      });
      return NextResponse.json({ ok: true, spaceId: space.id });
    }

    const space = getProjectSpace(String(body.spaceId ?? ""));
    if (!space) throw new HttpError(404, "Client space not found", "not_found");

    if (body.action === "share") {
      const target = getUserById(String(body.userId ?? ""));
      if (!target || target.status !== "active") {
        throw new HttpError(400, "Choose an active user to share with");
      }
      if (target.id === space.ownerUserId) {
        throw new HttpError(400, "The owner already has this space");
      }
      const role = body.role === "editor" ? "editor" : "viewer";
      upsertSpaceMembership({
        spaceId: space.id,
        userId: target.id,
        role,
        grantedByUserId: admin.id,
      });
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.share",
        targetUserId: target.id,
        details: { spaceId: space.id, clientName: space.clientName, role },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "revoke") {
      removeSpaceMembership(space.id, String(body.userId ?? ""));
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.revoke",
        targetUserId: body.userId ?? null,
        details: { spaceId: space.id, clientName: space.clientName },
      });
      return NextResponse.json({ ok: true });
    }

    if (body.action === "transfer") {
      const target = getUserById(String(body.ownerUserId ?? ""));
      if (!target || target.status !== "active") {
        throw new HttpError(400, "Choose an active user");
      }
      setProjectSpaceOwner(space.id, target.id);
      recordAudit({
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
      const result = archiveProjectSpace(space.id);
      recordAudit({
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
      const runs = (body.runs ?? [])
        .filter((run) => run.kind === "search" || run.kind === "lookup")
        .map((run) => ({
          kind: run.kind as ProjectKind,
          id: String(run.id ?? ""),
        }))
        .filter((run) => run.id);
      const moved = assignRunsToSpace(space.id, runs);
      recordAudit({
        actorUserId: admin.id,
        actorUsername: admin.username,
        action: "admin.space.move_runs",
        details: { spaceId: space.id, moved },
      });
      return NextResponse.json({ ok: true, moved });
    }

    throw new HttpError(400, "Unknown action");
  } catch (err) {
    return errorResponse(err);
  }
}
