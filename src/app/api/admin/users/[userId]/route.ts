import { NextResponse } from "next/server";
import {
  countActiveAdmins,
  getUserById,
  listProjects,
  setProjectArchived,
  setProjectOwner,
  toPublicUser,
  updateUser,
} from "@/lib/db";
import { errorResponse, HttpError, requireAdmin } from "@/lib/authz";
import { recordAudit, listMemberships, removeMembership } from "@/lib/accounting/records";
import {
  getCreditSummary,
  listPeriods,
  queryProviderCalls,
  usageByProvider,
  usageByRun,
} from "@/lib/accounting/service";
import type { UserRole } from "@/lib/types";

export const runtime = "nodejs";

/** Guard the "last active admin" invariant for demotion, suspension, deletion. */
function assertNotLastActiveAdmin(userId: string) {
  const user = getUserById(userId);
  if (!user || user.role !== "admin" || user.status !== "active") return;
  if (countActiveAdmins() <= 1) {
    throw new HttpError(
      409,
      "This is the last active administrator. Promote another admin first.",
      "last_admin",
    );
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    await requireAdmin();
    const { userId } = await params;
    const user = getUserById(userId);
    if (!user) throw new HttpError(404, "User not found", "not_found");

    return NextResponse.json({
      user: toPublicUser(user),
      limits: {
        maxConcurrentRuns: user.maxConcurrentRuns ?? null,
        allowedProviders: user.allowedProviders ?? null,
        blockedModels: user.blockedModels ?? null,
      },
      credits: getCreditSummary(user.id),
      periods: listPeriods(user.id),
      usageByProvider: usageByProvider({ chargedUserId: user.id }),
      recentRuns: usageByRun({ chargedUserId: user.id }).slice(0, 25),
      recentCalls: queryProviderCalls({ chargedUserId: user.id, limit: 25 }).rows,
      projects: listProjects({ ownerUserId: user.id }),
      sharedWithThisUser: listMemberships({ userId: user.id }),
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = getUserById(userId);
    if (!user) throw new HttpError(404, "User not found", "not_found");

    let body: {
      displayName?: string;
      role?: UserRole;
      status?: "active" | "suspended";
      maxConcurrentRuns?: number | null;
      allowedProviders?: string[] | null;
      blockedModels?: string[] | null;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    const patch: Parameters<typeof updateUser>[1] = {};
    const details: Record<string, string | number | boolean | null> = {};

    if (body.displayName !== undefined) {
      const displayName = String(body.displayName).trim();
      if (!displayName || displayName.length > 80) {
        return NextResponse.json({ error: "Invalid name" }, { status: 400 });
      }
      patch.displayName = displayName;
      details.displayName = displayName;
    }

    if (body.role !== undefined && body.role !== user.role) {
      if (body.role !== "admin" && body.role !== "user") {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      if (body.role === "user") assertNotLastActiveAdmin(userId);
      patch.role = body.role;
      // A role change must not keep working with an old session.
      patch.bumpSessionEpoch = true;
      details.role = body.role;
    }

    if (body.status !== undefined && body.status !== user.status) {
      if (body.status !== "active" && body.status !== "suspended") {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      if (body.status === "suspended") {
        assertNotLastActiveAdmin(userId);
        patch.suspendedAt = new Date().toISOString();
        // Suspension takes effect immediately, including for open sessions.
        patch.bumpSessionEpoch = true;
      } else {
        patch.suspendedAt = null;
      }
      patch.status = body.status;
      details.status = body.status;
    }

    if (body.maxConcurrentRuns !== undefined) {
      const value =
        body.maxConcurrentRuns === null ? null : Number(body.maxConcurrentRuns);
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 50)) {
        return NextResponse.json(
          { error: "Concurrent run limit must be between 1 and 50" },
          { status: 400 },
        );
      }
      patch.maxConcurrentRuns = value;
      details.maxConcurrentRuns = value;
    }

    if (body.allowedProviders !== undefined) {
      patch.allowedProviders = body.allowedProviders as
        | Parameters<typeof updateUser>[1]["allowedProviders"]
        | null;
      details.allowedProviders = (body.allowedProviders ?? []).join(",") || null;
    }
    if (body.blockedModels !== undefined) {
      patch.blockedModels = body.blockedModels ?? null;
      details.blockedModels = (body.blockedModels ?? []).join(",") || null;
    }

    const updated = updateUser(userId, patch);
    if (!updated) throw new HttpError(404, "User not found", "not_found");

    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.update",
      targetUserId: userId,
      details,
    });
    return NextResponse.json({ ok: true, user: toPublicUser(updated) });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}

/**
 * Soft-delete an account. Billing and audit history are preserved; the admin
 * must say explicitly what happens to the account's projects.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = getUserById(userId);
    if (!user) throw new HttpError(404, "User not found", "not_found");
    if (user.id === admin.id) {
      throw new HttpError(409, "You cannot delete your own account", "self_delete");
    }
    assertNotLastActiveAdmin(userId);

    const url = new URL(request.url);
    const projectAction = url.searchParams.get("projects") ?? "";
    const transferToUserId = url.searchParams.get("transferTo") ?? "";

    if (!["archive", "transfer", "unassign"].includes(projectAction)) {
      throw new HttpError(
        400,
        "Specify what to do with this user's projects: archive, transfer or unassign.",
        "projects_action_required",
      );
    }
    if (projectAction === "transfer") {
      const target = getUserById(transferToUserId);
      if (!target || target.status !== "active") {
        throw new HttpError(
          400,
          "Transfer target must be an active user",
          "invalid_transfer_target",
        );
      }
    }

    const projects = listProjects({ ownerUserId: userId });
    for (const project of projects) {
      if (projectAction === "archive") {
        setProjectArchived(project.kind, project.id, true);
      } else if (projectAction === "transfer") {
        setProjectOwner(project.kind, project.id, transferToUserId);
      } else {
        // Back to the admin-only unassigned area.
        setProjectOwner(project.kind, project.id, null);
      }
    }

    // Revoke everything shared *with* this account.
    for (const membership of listMemberships({ userId })) {
      removeMembership(membership.projectKind, membership.projectId, userId);
    }

    updateUser(userId, {
      status: "deleted",
      deletedAt: new Date().toISOString(),
      // Access is revoked immediately, before any cleanup is observed.
      bumpSessionEpoch: true,
    });

    recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.delete",
      targetUserId: userId,
      details: {
        projectAction,
        projectsAffected: projects.length,
        transferToUserId: projectAction === "transfer" ? transferToUserId : null,
      },
    });

    return NextResponse.json({
      ok: true,
      projectsAffected: projects.length,
      note: "Account soft-deleted. Credit ledger and audit history are retained.",
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
