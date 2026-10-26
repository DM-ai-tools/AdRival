import { NextResponse } from "next/server";
import {
  archiveProjectSpace,
  getOrganization,
  getProjectSpacesByIds,
  getUserById,
  listProjects,
  listProjectSpaces,
  listSpaceMemberships,
  removeSpaceMembership,
  setProjectArchived,
  setProjectSpaceOwner,
  setProjectOwner,
  toPublicUser,
  updateUser,
} from "@/lib/db";
import {
  adminScope,
  assertNotLastActiveAdmin,
  assertUserInScope,
  errorResponse,
  HttpError,
  lastActiveAdminGuard,
  requireAdmin,
  userInScope,
} from "@/lib/authz";
import { getDb } from "@/lib/data/client";
import {
  listMemberships,
  queryLedger,
  recordAudit,
  removeMembership,
} from "@/lib/accounting/records";
import { clearLoginAttempts, isLoginLocked } from "@/lib/auth/rateLimit";
import {
  getCreditSummary,
  listPeriods,
  queryProviderCalls,
  usageByProvider,
  usageByRun,
} from "@/lib/accounting/service";
import type { UserRole } from "@/lib/types";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const admin = await requireAdmin();
    const { userId } = await params;
    const user = await getUserById(userId);
    assertUserInScope(admin, user);

    const [
      credits,
      periods,
      providerUsage,
      runUsage,
      recentCalls,
      projects,
      sharedWithThisUser,
      loginLock,
      spacesOwned,
      sharedSpaces,
      ledger,
    ] = await Promise.all([
      getCreditSummary(user.id),
      listPeriods(user.id),
      usageByProvider({ chargedUserId: user.id }),
      usageByRun({ chargedUserId: user.id }),
      queryProviderCalls({ chargedUserId: user.id, limit: 25 }),
      listProjects({ ownerUserId: user.id }),
      listMemberships({ userId: user.id }),
      isLoginLocked(user.username),
      listProjectSpaces({ ownerUserId: user.id, includeArchived: true }),
      listSpaceMemberships().then((all) => all.filter((m) => m.userId === user.id)),
      // Allowance changes, top-ups, adjustments and charges, newest first.
      queryLedger({ userId: user.id, limit: 100 }),
    ]);
    const sharedSpaceRows = await getProjectSpacesByIds(sharedSpaces.map((m) => m.spaceId));

    return NextResponse.json({
      user: toPublicUser(user),
      limits: {
        maxConcurrentRuns: user.maxConcurrentRuns ?? null,
        allowedProviders: user.allowedProviders ?? null,
        blockedModels: user.blockedModels ?? null,
      },
      credits,
      periods,
      usageByProvider: providerUsage,
      recentRuns: runUsage.slice(0, 25),
      recentCalls: recentCalls.rows,
      projects,
      sharedWithThisUser,
      lastLoginAt: user.lastLoginAt ?? null,
      loginLocked: loginLock.locked,
      spacesOwned: spacesOwned.map((s) => ({
        id: s.id,
        clientName: s.clientName,
        archivedAt: s.archivedAt ?? null,
      })),
      spacesSharedWithThisUser: sharedSpaces.map((m) => ({
        spaceId: m.spaceId,
        role: m.role,
        clientName: sharedSpaceRows.get(m.spaceId)?.clientName ?? m.spaceId,
      })),
      ledger,
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
    const user = await getUserById(userId);
    assertUserInScope(admin, user);

    let body: {
      displayName?: string;
      /** Lift a sign-in lockout caused by repeated wrong passwords. */
      unlockLogin?: boolean;
      role?: UserRole;
      status?: "active" | "suspended";
      maxConcurrentRuns?: number | null;
      allowedProviders?: string[] | null;
      blockedModels?: string[] | null;
      /** Platform admins only: move the user into an organisation (null = platform level). */
      orgId?: string | null;
    } = {};
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (user.status === "deleted") {
      throw new HttpError(409, "This account has been deleted and can't be changed", "user_deleted");
    }
    // An admin removing their own access would lock themselves out mid-session.
    if (
      userId === admin.id &&
      ((body.role !== undefined && body.role !== "admin") || body.status === "suspended")
    ) {
      throw new HttpError(409, "You can't demote or suspend your own account", "self_lockout");
    }

    const patch: Parameters<typeof updateUser>[1] = {};
    const details: Record<string, string | number | boolean | null> = {};
    // Set when this change could remove the last active (org) admin.
    let needsAdminGuard = false;

    if (body.unlockLogin) {
      await clearLoginAttempts(user.username);
      details.unlockLogin = true;
    }

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
      if (body.role === "user") {
        // Early answer, as before; the guard on updateUser re-checks under the lock.
        await assertNotLastActiveAdmin(user, admin, getDb());
        needsAdminGuard = true;
      }
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
        await assertNotLastActiveAdmin(user, admin, getDb());
        needsAdminGuard = true;
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

    if (body.orgId !== undefined && (body.orgId || null) !== (user.orgId ?? null)) {
      if (admin.orgId) {
        throw new HttpError(403, "Only platform administrators can move users between organisations.", "forbidden");
      }
      if (userId === admin.id) {
        throw new HttpError(409, "You can't move your own account into an organisation", "self_lockout");
      }
      const org = body.orgId ? await getOrganization(String(body.orgId)) : null;
      if (body.orgId && (!org || org.archivedAt)) {
        return NextResponse.json({ error: "That organisation does not exist" }, { status: 400 });
      }
      if (user.role === "admin" && !user.orgId) {
        await assertNotLastActiveAdmin(user, admin, getDb());
        needsAdminGuard = true;
      }
      patch.orgId = org?.id ?? null;
      // What the account can see changes, so its sessions start fresh.
      patch.bumpSessionEpoch = true;
      details.orgId = org?.id ?? null;
    }

    // The guard runs inside updateUser's transaction on the locked row: the
    // deleted check and the admin counts cannot go stale before the write, so
    // two concurrent demotions cannot both pass.
    const adminGuard = needsAdminGuard ? lastActiveAdminGuard(admin) : null;
    const updated = await updateUser(userId, patch, {
      guard: async (prev, tx) => {
        if (prev.status === "deleted") {
          throw new HttpError(409, "This account has been deleted and can't be changed", "user_deleted");
        }
        if (adminGuard) await adminGuard(prev, tx);
      },
    });
    if (!updated) throw new HttpError(404, "User not found", "not_found");

    await recordAudit({
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
    const user = await getUserById(userId);
    assertUserInScope(admin, user);
    if (user.id === admin.id) {
      throw new HttpError(409, "You cannot delete your own account", "self_delete");
    }
    // Early answer, as before; the guard on updateUser below re-checks under the lock.
    await assertNotLastActiveAdmin(user, admin, getDb());

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
      const target = await getUserById(transferToUserId);
      if (!target || target.status !== "active" || !userInScope(adminScope(admin), target)) {
        throw new HttpError(
          400,
          "Transfer target must be an active user",
          "invalid_transfer_target",
        );
      }
    }

    // Delete first: the last-admin guard runs in the same transaction as the
    // write, so a concurrent demotion cannot leave no admin, and a refused
    // delete has not touched any project yet. Access is revoked immediately,
    // before any cleanup is observed; a cleanup that fails part-way can be
    // finished by repeating the delete.
    await updateUser(
      userId,
      {
        status: "deleted",
        deletedAt: new Date().toISOString(),
        bumpSessionEpoch: true,
      },
      { guard: lastActiveAdminGuard(admin) },
    );

    const projects = await listProjects({ ownerUserId: userId });
    for (const project of projects) {
      if (projectAction === "archive") {
        await setProjectArchived(project.kind, project.id, true);
      } else if (projectAction === "transfer") {
        await setProjectOwner(project.kind, project.id, transferToUserId);
      } else {
        // Back to the admin-only unassigned area — for an organisation admin that
        // area is theirs, so the runs stay inside the organisation.
        await setProjectOwner(project.kind, project.id, admin.orgId ? admin.id : null);
      }
    }

    // Client spaces follow the same choice as runs. A space always needs an
    // owner, so "unassign" hands it to the admin doing the delete.
    const spaces = await listProjectSpaces({ ownerUserId: userId });
    for (const space of spaces) {
      if (projectAction === "archive") {
        await archiveProjectSpace(space.id);
      } else {
        const newOwner = projectAction === "transfer" ? transferToUserId : admin.id;
        await setProjectSpaceOwner(space.id, newOwner);
        // The new owner doesn't also need a sharing entry on their own space.
        await removeSpaceMembership(space.id, newOwner);
      }
    }

    // Revoke everything shared *with* this account.
    for (const membership of await listMemberships({ userId })) {
      await removeMembership(membership.projectKind, membership.projectId, userId);
    }
    for (const membership of await listSpaceMemberships()) {
      if (membership.userId === userId) await removeSpaceMembership(membership.spaceId, userId);
    }

    await recordAudit({
      actorUserId: admin.id,
      actorUsername: admin.username,
      action: "admin.user.delete",
      targetUserId: userId,
      details: {
        projectAction,
        projectsAffected: projects.length,
        spacesAffected: spaces.length,
        transferToUserId: projectAction === "transfer" ? transferToUserId : null,
      },
    });

    return NextResponse.json({
      ok: true,
      projectsAffected: projects.length,
      spacesAffected: spaces.length,
      note: "Account soft-deleted. Credit ledger and audit history are retained.",
    });
  } catch (err) {
    return errorResponse(err, { audience: "admin" });
  }
}
