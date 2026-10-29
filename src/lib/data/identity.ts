import type { AppUser, AppUserPublic, Organization, UserRole, UserStatus } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { jsonText } from "./jsonText";

/*
 * Users and organisations, ported from db.ts. Each row keeps the whole record
 * in `data`; username, org_id, role and status are copies kept in sync here.
 *
 * Every write that can change who exists or who is an active admin (user
 * creation, role / status / org changes) holds one advisory key, so a check
 * made in a caller's `guard` (last admin, bootstrap only when no admin exists)
 * and the write it protects cannot interleave with another such write.
 */

/** Advisory key class for identity invariants (runs use 7302). */
export const IDENTITY_LOCK_CLASS = 7303;
const USERS_LOCK_ID = 1;
const ORGS_LOCK_ID = 2;

/** Exclusive hold on the users key: user creation and admin-count-sensitive updates. */
export async function lockUsers(tx: Queryable): Promise<void> {
  await tx.query("select pg_advisory_xact_lock($1::int, $2::int)", [IDENTITY_LOCK_CLASS, USERS_LOCK_ID]);
}

async function lockOrganizations(tx: Queryable): Promise<void> {
  await tx.query("select pg_advisory_xact_lock($1::int, $2::int)", [IDENTITY_LOCK_CLASS, ORGS_LOCK_ID]);
}

/* ── users ── */

/** Inserts or replaces one user row (also used by the store import). */
export async function upsertUser(tx: Queryable, user: AppUser): Promise<void> {
  await tx.query(
    `insert into users (id, username, org_id, role, status, data)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (id) do update set
       username = excluded.username,
       org_id   = excluded.org_id,
       role     = excluded.role,
       status   = excluded.status,
       data     = excluded.data`,
    [user.id, user.username, user.orgId ?? null, user.role, user.status, jsonText(user)],
  );
}

/** Newest first, as db.ts kept them (createUser unshifts). */
const USER_ORDER = "order by (data->>'createdAt') collate \"C\" desc nulls last, id desc";

export async function listUsers(options?: { includeDeleted?: boolean }): Promise<AppUser[]> {
  const { rows } = await getDb().query<{ data: AppUser }>(
    `select data from users ${options?.includeDeleted ? "" : "where status <> 'deleted'"} ${USER_ORDER}`,
  );
  return rows.map((r) => r.data);
}

export async function getUserById(id: string): Promise<AppUser | null> {
  const { rows } = await getDb().query<{ data: AppUser }>("select data from users where id = $1", [id]);
  return rows[0]?.data ?? null;
}

/** Users by id, for showing names next to many rows at once (missing ids are left out). */
export async function getUsersByIds(ids: Iterable<string | null | undefined>): Promise<Map<string, AppUser>> {
  const wanted = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  const { rows } = await getDb().query<{ data: AppUser }>("select data from users where id = any($1::text[])", [wanted]);
  return new Map(rows.map((r) => [r.data.id, r.data]));
}

export interface UserCounts {
  /** Every account that is not deleted. */
  total: number;
  active: number;
  suspended: number;
  deleted: number;
  /** Active admins. */
  admins: number;
}

/** Account counts by status; `userIds` limits them to those users (an organisation). */
export async function countUsers(userIds?: Set<string> | null): Promise<UserCounts> {
  const { rows } = await getDb().query<UserCounts>(
    `select count(*) filter (where status <> 'deleted')::int                   as "total",
            count(*) filter (where status = 'active')::int                     as "active",
            count(*) filter (where status = 'suspended')::int                  as "suspended",
            count(*) filter (where status = 'deleted')::int                    as "deleted",
            count(*) filter (where role = 'admin' and status = 'active')::int  as "admins"
       from users ${userIds ? "where id = any($1::text[])" : ""}`,
    userIds ? [[...userIds]] : [],
  );
  return rows[0];
}

/** The user an invitation token (by its hash) belongs to, or null. */
export async function getUserByInviteHash(tokenHash: string): Promise<AppUser | null> {
  const { rows } = await getDb().query<{ data: AppUser }>(
    "select data from users where data->'invite'->>'tokenHash' = $1 and status <> 'deleted' limit 1",
    [tokenHash],
  );
  return rows[0]?.data ?? null;
}

/** Case-insensitive (usernames are stored lowercased; the unique index is on lower(username)). */
export async function getUserByUsername(username: string): Promise<AppUser | null> {
  const key = username.trim().toLowerCase();
  const { rows } = await getDb().query<{ data: AppUser }>(
    `select data from users where lower(username) = $1 ${USER_ORDER} limit 1`,
    [key],
  );
  return rows[0]?.data ?? null;
}

/** Pass the transaction handle when counting inside a `guard`. */
export async function countActiveAdmins(q: Queryable = getDb()): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from users where role = 'admin' and status = 'active'",
  );
  return rows[0]?.n ?? 0;
}

/** Active admins of one organisation. Pass the transaction handle inside a `guard`. */
export async function countActiveOrgAdmins(orgId: string, q: Queryable = getDb()): Promise<number> {
  const { rows } = await q.query<{ n: number }>(
    "select count(*)::int as n from users where org_id = $1 and role = 'admin' and status = 'active'",
    [orgId],
  );
  return rows[0]?.n ?? 0;
}

export async function createUser(
  input: {
    username: string;
    displayName: string;
    passwordHash: string;
    role?: UserRole;
    status?: UserStatus;
    mustChangePassword?: boolean;
    createdByUserId?: string | null;
    orgId?: string | null;
    email?: string | null;
    invite?: AppUser["invite"];
  },
  options?: {
    /** Runs inside the transaction under the users lock; throw to refuse. */
    guard?: (tx: Queryable) => Promise<void>;
  },
): Promise<AppUser> {
  return withTx(async (tx) => {
    await lockUsers(tx);
    if (options?.guard) await options.guard(tx);
    const username = input.username.trim().toLowerCase();
    const { rows } = await tx.query("select 1 from users where lower(username) = $1", [username]);
    if (rows.length) throw new Error("Username already taken");
    const now = new Date().toISOString();
    const user: AppUser = {
      id: crypto.randomUUID(),
      username,
      displayName: input.displayName.trim(),
      passwordHash: input.passwordHash,
      role: input.role ?? "user",
      status: input.status ?? "active",
      sessionEpoch: 1,
      mustChangePassword: input.mustChangePassword ?? false,
      maxConcurrentRuns: null,
      allowedProviders: null,
      blockedModels: null,
      createdAt: now,
      updatedAt: now,
      createdByUserId: input.createdByUserId ?? null,
      orgId: input.orgId ?? null,
      email: input.email ?? null,
      invite: input.invite ?? null,
    };
    await upsertUser(tx, user);
    return user;
  });
}

export type UserPatch = Partial<
  Pick<
    AppUser,
    | "displayName"
    | "passwordHash"
    | "role"
    | "status"
    | "mustChangePassword"
    | "maxConcurrentRuns"
    | "allowedProviders"
    | "blockedModels"
    | "suspendedAt"
    | "deletedAt"
    | "lastLoginAt"
    | "orgId"
    | "email"
    | "invite"
  >
> & {
  /** Invalidates every existing session for this user. */
  bumpSessionEpoch?: boolean;
};

export async function updateUser(
  id: string,
  patch: UserPatch,
  options?: {
    /**
     * Runs inside the transaction, under the users lock and the row lock,
     * before the write; throw to refuse (e.g. "last active admin").
     */
    guard?: (prev: AppUser, tx: Queryable) => Promise<void>;
  },
): Promise<AppUser | null> {
  return withTx(async (tx) => {
    // Changes that can move the admin count (or org admin count) serialize
    // with each other and with user creation.
    const sensitive =
      Boolean(options?.guard) || patch.role !== undefined || patch.status !== undefined || patch.orgId !== undefined;
    if (sensitive) await lockUsers(tx);
    const { rows } = await tx.query<{ data: AppUser }>("select data from users where id = $1 for update", [id]);
    const prev = rows[0]?.data;
    if (!prev) return null;
    if (options?.guard) await options.guard(prev, tx);
    const { bumpSessionEpoch, ...fields } = patch;
    const next: AppUser = {
      ...prev,
      ...fields,
      displayName: fields.displayName !== undefined ? fields.displayName.trim() : prev.displayName,
      sessionEpoch: bumpSessionEpoch ? prev.sessionEpoch + 1 : prev.sessionEpoch,
      updatedAt: new Date().toISOString(),
    };
    await upsertUser(tx, next);
    return next;
  });
}

export function toPublicUser(user: AppUser): AppUserPublic {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    createdAt: user.createdAt,
    orgId: user.orgId ?? null,
  };
}

/* ── organisations ── */

/** Inserts or replaces one organisation row (also used by the store import). */
export async function upsertOrganization(tx: Queryable, org: Organization): Promise<void> {
  await tx.query(
    `insert into organizations (id, archived_at, data)
     values ($1, $2::timestamptz, $3::jsonb)
     on conflict (id) do update set archived_at = excluded.archived_at, data = excluded.data`,
    [org.id, org.archivedAt || null, jsonText(org)],
  );
}

function cleanOrgName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function listOrganizations(options?: { includeArchived?: boolean }): Promise<Organization[]> {
  const { rows } = await getDb().query<{ data: Organization }>(
    `select data from organizations
      ${options?.includeArchived ? "" : "where coalesce(data->>'archivedAt', '') = ''"}
      order by (data->>'createdAt') collate "C" desc nulls last, id desc`,
  );
  return rows.map((r) => r.data);
}

export async function getOrganization(id: string | null | undefined): Promise<Organization | null> {
  if (!id) return null;
  const { rows } = await getDb().query<{ data: Organization }>("select data from organizations where id = $1", [id]);
  return rows[0]?.data ?? null;
}

export async function createOrganization(input: { name: string; createdByUserId: string | null }): Promise<Organization> {
  const name = cleanOrgName(input.name);
  if (!name) throw new Error("Organisation name is required");
  return withTx(async (tx) => {
    await lockOrganizations(tx);
    const { rows } = await tx.query(
      `select 1 from organizations
        where coalesce(data->>'archivedAt', '') = '' and lower(data->>'name') = lower($1)`,
      [name],
    );
    if (rows.length) throw new Error("An organisation with that name already exists");
    const now = new Date().toISOString();
    const org: Organization = {
      id: crypto.randomUUID(),
      name,
      createdAt: now,
      updatedAt: now,
      createdByUserId: input.createdByUserId,
      archivedAt: null,
    };
    await upsertOrganization(tx, org);
    return org;
  });
}

export async function renameOrganization(id: string, name: string): Promise<Organization | null> {
  return withTx(async (tx) => {
    await lockOrganizations(tx);
    const { rows } = await tx.query<{ data: Organization }>(
      "select data from organizations where id = $1 for update",
      [id],
    );
    const org = rows[0]?.data;
    if (!org) return null;
    const clean = cleanOrgName(name);
    if (!clean) throw new Error("Organisation name is required");
    const next: Organization = { ...org, name: clean, updatedAt: new Date().toISOString() };
    await upsertOrganization(tx, next);
    return next;
  });
}

/** Ids of every user in an organisation (any status). */
export async function orgUserIds(orgId: string): Promise<Set<string>> {
  const { rows } = await getDb().query<{ id: string }>("select id from users where org_id = $1", [orgId]);
  return new Set(rows.map((r) => r.id));
}
