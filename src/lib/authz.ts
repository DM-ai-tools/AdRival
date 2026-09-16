import { maskClientFacingText } from "@/lib/clientFacing";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getProject,
  getProjectSpace,
  getUserById,
  listProjects,
  listProjectSpaces,
  listSpaceMemberships,
  toPublicUser,
  type ProjectOwnership,
} from "@/lib/db";
import { getMembership, listMemberships, recordAudit } from "@/lib/accounting/records";
import { parseSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import type {
  AppUser,
  AppUserPublic,
  ProjectAction,
  ProjectKind,
  ProjectRole,
} from "@/lib/types";

/**
 * Resolve the caller from the session cookie and re-validate them against the
 * stored account on every request.
 *
 * A signed cookie alone is never enough: the account must still exist, still be
 * active, and its `sessionEpoch` must match the one the cookie was minted with.
 */
export async function getSessionUser(): Promise<AppUser | null> {
  const jar = await cookies();
  const session = await parseSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = getUserById(session.sub);
  if (!user) return null;
  if (user.status !== "active") return null;
  if (user.sessionEpoch !== session.epoch) return null;
  return user;
}

export async function getCurrentPublicUser(): Promise<AppUserPublic | null> {
  const user = await getSessionUser();
  return user ? toPublicUser(user) : null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(
  err: unknown,
  options?: { audience?: "user" | "admin" },
): NextResponse {
  const raw = err instanceof Error ? err.message : "Unexpected error";
  const error =
    options?.audience === "admin" ? raw : maskClientFacingText(raw) || raw;
  if (err instanceof HttpError) {
    return NextResponse.json(
      { error, code: err.code },
      { status: err.status },
    );
  }
  return NextResponse.json({ error }, { status: 500 });
}

/** 401 when unauthenticated, 403 when a password reset must be completed. */
export async function requireUser(options?: {
  allowPasswordChangePending?: boolean;
}): Promise<AppUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Unauthorized", "unauthorized");
  if (user.mustChangePassword && !options?.allowPasswordChangePending) {
    throw new HttpError(
      403,
      "You must set a new password before continuing.",
      "password_change_required",
    );
  }
  return user;
}

export async function requireAdmin(): Promise<AppUser> {
  const user = await requireUser();
  if (user.role !== "admin") {
    throw new HttpError(403, "Administrator access required", "forbidden");
  }
  return user;
}

/* ─────────────────────────── Project authorization ──────────────────────── */

export interface ProjectAccess {
  project: ProjectOwnership;
  /** "owner" for the owner, otherwise the shared role. Admins get "owner". */
  role: ProjectRole;
  isAdminOverride: boolean;
}

const ACTIONS_BY_ROLE: Record<ProjectRole, ProjectAction[]> = {
  owner: ["view", "edit", "run"],
  editor: ["view", "edit", "run"],
  viewer: ["view"],
};

function spaceRoleFor(
  spaceId: string | null | undefined,
  user: AppUser,
): ProjectRole | null {
  if (!spaceId) return null;
  const space = getProjectSpace(spaceId);
  if (!space || space.archivedAt) return null;
  if (space.ownerUserId === user.id) return "owner";
  const membership = listSpaceMemberships(spaceId).find((m) => m.userId === user.id);
  return membership?.role ?? null;
}

/** Authorize a run or edit inside a client space. */
export function resolveSpaceAccess(
  spaceId: string,
  user: AppUser,
  action: ProjectAction,
): { spaceId: string; role: ProjectRole; clientName: string } {
  const space = getProjectSpace(spaceId);
  if (!space || space.archivedAt) {
    throw new HttpError(404, "Not found", "not_found");
  }
  if (user.role === "admin") {
    return { spaceId, role: "owner", clientName: space.clientName };
  }
  const role = spaceRoleFor(spaceId, user);
  if (!role || !ACTIONS_BY_ROLE[role].includes(action)) {
    throw new HttpError(
      role ? 403 : 404,
      role === "viewer"
        ? "You have view-only access to this client space."
        : "Not found",
      role ? "forbidden" : "not_found",
    );
  }
  return { spaceId, role, clientName: space.clientName };
}

function jobsInVisibleSpaces(user: AppUser): VisibleProject[] {
  const spaces = [
    ...listProjectSpaces({ ownerUserId: user.id }).map((space) => ({
      id: space.id,
      role: "owner" as const,
    })),
    ...listSpaceMemberships()
      .filter((m) => m.userId === user.id)
      .map((m) => ({ id: m.spaceId, role: m.role })),
  ];
  const bySpace = new Map(spaces.map((s) => [s.id, s.role]));
  return listProjects()
    .filter((project) => project.spaceId && bySpace.has(project.spaceId) && !project.archivedAt)
    .map((project) => {
      const role = bySpace.get(project.spaceId!) ?? "viewer";
      const owner = project.ownerUserId ? getUserById(project.ownerUserId) : null;
      return {
        ...project,
        accessRole: role,
        ownerUsername: owner?.username ?? null,
        ownerDisplayName: owner?.displayName ?? null,
      };
    });
}

/**
 * Authorize an action on one project.
 *
 * Unowned legacy rows are reachable only by admins, so a user who guesses a
 * project id from before the migration still gets a 404.
 */
export function resolveProjectAccess(
  kind: ProjectKind,
  projectId: string,
  user: AppUser,
  action: ProjectAction,
): ProjectAccess {
  const project = getProject(kind, projectId);
  // 404 rather than 403 so ids cannot be probed for existence.
  if (!project) throw new HttpError(404, "Not found", "not_found");

  if (project.ownerUserId === user.id) {
    return { project, role: "owner", isAdminOverride: false };
  }

  if (user.role === "admin") {
    recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: `admin.project.${action}`,
      projectKind: kind,
      projectId,
      targetUserId: project.ownerUserId ?? null,
      details: { reason: "administrative inspection" },
    });
    return { project, role: "owner", isAdminOverride: true };
  }

  if (!project.ownerUserId) {
    // Legacy row awaiting owner assignment — invisible to non-admins,
    // unless it was later placed in a client space they can access.
    const viaSpace = spaceRoleFor(project.spaceId, user);
    if (!viaSpace) throw new HttpError(404, "Not found", "not_found");
    if (!ACTIONS_BY_ROLE[viaSpace].includes(action)) {
      throw new HttpError(
        403,
        viaSpace === "viewer"
          ? "You have view-only access to this client space."
          : "You do not have permission to do that.",
        "forbidden",
      );
    }
    return { project, role: viaSpace, isAdminOverride: false };
  }

  const viaSpace = spaceRoleFor(project.spaceId, user);
  if (viaSpace) {
    if (!ACTIONS_BY_ROLE[viaSpace].includes(action)) {
      throw new HttpError(
        403,
        viaSpace === "viewer"
          ? "You have view-only access to this client space."
          : "You do not have permission to do that.",
        "forbidden",
      );
    }
    return { project, role: viaSpace, isAdminOverride: false };
  }

  const membership = getMembership(kind, projectId, user.id);
  if (!membership) throw new HttpError(404, "Not found", "not_found");

  if (!ACTIONS_BY_ROLE[membership.role].includes(action)) {
    throw new HttpError(
      403,
      membership.role === "viewer"
        ? "You have view-only access to this project."
        : "You do not have permission to do that.",
      "forbidden",
    );
  }
  return { project, role: membership.role, isAdminOverride: false };
}

export interface VisibleProject extends ProjectOwnership {
  accessRole: ProjectRole;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
}

/**
 * Projects the user may see in their own workspace: the ones they own plus the
 * ones explicitly shared with them. Admins are not special-cased here — their
 * cross-user view lives in the admin area so their own lists stay clean.
 */
export function listVisibleProjects(user: AppUser): VisibleProject[] {
  const decorate = (
    project: ProjectOwnership,
    accessRole: ProjectRole,
  ): VisibleProject => {
    const owner = project.ownerUserId ? getUserById(project.ownerUserId) : null;
    return {
      ...project,
      accessRole,
      ownerUsername: owner?.username ?? null,
      ownerDisplayName: owner?.displayName ?? null,
    };
  };

  const owned = listProjects({ ownerUserId: user.id }).map((p) =>
    decorate(p, "owner"),
  );
  const shared = listMemberships({ userId: user.id })
    .map((membership) => {
      const project = getProject(membership.projectKind, membership.projectId);
      return project ? decorate(project, membership.role) : null;
    })
    .filter((p): p is VisibleProject => p !== null);

  const seen = new Set(owned.map((p) => `${p.kind}:${p.id}`));
  const fromSpaces = jobsInVisibleSpaces(user)
    .filter((p) => !seen.has(`${p.kind}:${p.id}`))
    .map((p) => p);
  return [
    ...owned,
    ...shared.filter((p) => !seen.has(`${p.kind}:${p.id}`)),
    ...fromSpaces.filter(
      (p) => !seen.has(`${p.kind}:${p.id}`) && !shared.some((s) => s.kind === p.kind && s.id === p.id),
    ),
  ].filter((p) => !p.archivedAt);
}

/** Ids the user may read, as a `kind:id` set for cheap filtering. */
export function visibleProjectKeys(user: AppUser): Set<string> {
  return new Set(listVisibleProjects(user).map((p) => `${p.kind}:${p.id}`));
}

/** Search run ids the user may read — for filtering competitor-level rows. */
export function visibleRunIds(user: AppUser, kind: ProjectKind): Set<string> {
  return new Set(
    listVisibleProjects(user)
      .filter((p) => p.kind === kind)
      .map((p) => p.id),
  );
}

export function canRunInProject(access: ProjectAccess): boolean {
  return ACTIONS_BY_ROLE[access.role].includes("run");
}
