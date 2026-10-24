import type { LookupJob, ProjectKind, ProjectSpace, SearchJob, SpaceMembership } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { lockRunId, lockRunsShared, runWasDeleted } from "./runs";

/*
 * Projects (search and lookup runs seen as owned things), client spaces and
 * space memberships, ported from db.ts.
 *
 * Writes to run rows follow the locking rules in runs.ts: the global runs key
 * shared once per transaction, then the space row, then each run id once, in
 * sorted order. A run is changed in place with UPDATE, never re-inserted, and
 * a run with a deletion tombstone is skipped, so nothing here can bring back a
 * deleted run.
 */

type RunTable = "jobs" | "lookup_jobs";
type RunRow = SearchJob | LookupJob;

function tableFor(kind: ProjectKind): RunTable {
  return kind === "search" ? "jobs" : "lookup_jobs";
}

/** Locks run ids in one fixed order (callers hold lockRunsShared already). */
async function lockRunIdsSorted(tx: Queryable, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockRunId(tx, id);
}

/** The run row, locked; null when missing or tombstoned. Its run id must be locked. */
async function selectRunForUpdate<T extends RunRow>(tx: Queryable, table: RunTable, id: string): Promise<T | null> {
  if (await runWasDeleted(tx, id)) return null;
  const { rows } = await tx.query<{ data: T }>(`select data from ${table} where id = $1 for update`, [id]);
  return rows[0]?.data ?? null;
}

/** Writes an existing run row back (UPDATE only: a row that is gone stays gone). */
async function updateRunRow(tx: Queryable, table: RunTable, row: RunRow): Promise<void> {
  await tx.query(
    `update ${table} set owner_user_id = $2, space_id = $3, data = $4::jsonb where id = $1`,
    [row.id, row.ownerUserId ?? null, row.spaceId ?? null, JSON.stringify(row)],
  );
}

/* ── project ownership helpers ── */

export interface ProjectOwnership {
  kind: ProjectKind;
  id: string;
  ownerUserId: string | null | undefined;
  spaceId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

function describeProject(kind: ProjectKind, row: RunRow): ProjectOwnership {
  return {
    kind,
    id: row.id,
    ownerUserId: row.ownerUserId,
    spaceId: row.spaceId ?? null,
    title:
      kind === "search"
        ? (row as SearchJob).keyword || "Keyword search"
        : (row as LookupJob).queryName || "Competitor lookup",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  };
}

export async function getProject(kind: ProjectKind, id: string): Promise<ProjectOwnership | null> {
  const { rows } = await getDb().query<{ data: RunRow }>(`select data from ${tableFor(kind)} where id = $1`, [id]);
  return rows[0] ? describeProject(kind, rows[0].data) : null;
}

/** SQL true when a JSON field is set to a JS-truthy value. */
function truthySql(field: string): string {
  return `coalesce((${field}) not in ('null', 'false', '0', '""'), false)`;
}

export async function listProjects(options?: {
  ownerUserId?: string;
  unassignedOnly?: boolean;
}): Promise<ProjectOwnership[]> {
  let where = "";
  const params: unknown[] = [];
  if (options?.unassignedOnly) {
    where = "where coalesce(owner_user_id, '') = ''";
  } else if (options?.ownerUserId) {
    where = "where owner_user_id = $1";
    params.push(options.ownerUserId);
  }
  const db = getDb();
  const jobs = await db.query<{ data: SearchJob }>(`select data from jobs ${where}`, params);
  const lookups = await db.query<{ data: LookupJob }>(
    `select data from lookup_jobs ${where ? `${where} and` : "where"} not ${truthySql("data->'internalOnly'")}`,
    params,
  );
  const rows: ProjectOwnership[] = [
    ...jobs.rows.map((r) => describeProject("search", r.data)),
    ...lookups.rows.map((r) => describeProject("lookup", r.data)),
  ];
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Change one run in place under its locks; false when the run is missing. */
async function changeRun(kind: ProjectKind, id: string, change: (row: RunRow) => RunRow): Promise<boolean> {
  return withTx(async (tx) => {
    await lockRunsShared(tx);
    await lockRunId(tx, id);
    const table = tableFor(kind);
    const row = await selectRunForUpdate(tx, table, id);
    if (!row) return false;
    await updateRunRow(tx, table, change(row));
    return true;
  });
}

export async function setProjectOwner(kind: ProjectKind, id: string, ownerUserId: string | null): Promise<boolean> {
  return changeRun(kind, id, (row) => ({ ...row, ownerUserId, updatedAt: new Date().toISOString() }));
}

export async function setProjectArchived(kind: ProjectKind, id: string, archived: boolean): Promise<boolean> {
  return changeRun(kind, id, (row) => {
    const now = new Date().toISOString();
    return { ...row, archivedAt: archived ? now : null, updatedAt: now };
  });
}

/* ── spaces ── */

/** Upserts a space; org_id is the owner's organisation at the time of the write. */
async function saveSpace(tx: Queryable, space: ProjectSpace): Promise<void> {
  await tx.query(
    `insert into project_spaces (id, org_id, owner_user_id, archived_at, data)
     values ($1, (select org_id from users where id = $2), $2, $3::timestamptz, $4::jsonb)
     on conflict (id) do update set
       org_id        = excluded.org_id,
       owner_user_id = excluded.owner_user_id,
       archived_at   = excluded.archived_at,
       data          = excluded.data`,
    [space.id, space.ownerUserId, space.archivedAt || null, JSON.stringify(space)],
  );
}

async function selectSpaceForUpdate(tx: Queryable, id: string): Promise<ProjectSpace | null> {
  const { rows } = await tx.query<{ data: ProjectSpace }>(
    "select data from project_spaces where id = $1 for update",
    [id],
  );
  return rows[0]?.data ?? null;
}

export async function listProjectSpaces(options?: {
  ownerUserId?: string;
  includeArchived?: boolean;
}): Promise<ProjectSpace[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (!options?.includeArchived) conditions.push("coalesce(data->>'archivedAt', '') = ''");
  if (options?.ownerUserId) {
    params.push(options.ownerUserId);
    conditions.push(`owner_user_id = $${params.length}`);
  }
  const { rows } = await getDb().query<{ data: ProjectSpace }>(
    `select data from project_spaces ${conditions.length ? `where ${conditions.join(" and ")}` : ""}`,
    params,
  );
  return rows.map((r) => r.data).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getProjectSpace(id: string): Promise<ProjectSpace | null> {
  const { rows } = await getDb().query<{ data: ProjectSpace }>("select data from project_spaces where id = $1", [id]);
  return rows[0]?.data ?? null;
}

export async function createProjectSpace(input: { clientName: string; ownerUserId: string }): Promise<ProjectSpace> {
  return withTx(async (tx) => {
    const now = new Date().toISOString();
    const space: ProjectSpace = {
      id: crypto.randomUUID(),
      clientName: input.clientName.trim(),
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    await saveSpace(tx, space);
    return space;
  });
}

/** Change one space row in place; false when it is missing. */
async function changeSpace(spaceId: string, change: (space: ProjectSpace) => ProjectSpace): Promise<boolean> {
  return withTx(async (tx) => {
    const space = await selectSpaceForUpdate(tx, spaceId);
    if (!space) return false;
    await saveSpace(tx, change(space));
    return true;
  });
}

export async function setProjectSpaceOwner(spaceId: string, ownerUserId: string): Promise<boolean> {
  return changeSpace(spaceId, (space) => ({ ...space, ownerUserId, updatedAt: new Date().toISOString() }));
}

export async function renameProjectSpace(spaceId: string, clientName: string): Promise<boolean> {
  return changeSpace(spaceId, (space) => ({ ...space, clientName, updatedAt: new Date().toISOString() }));
}

/** Ids of a space's runs in one table matching `extra` (SQL over `data`). */
async function spaceRunIds(tx: Queryable, table: RunTable, spaceId: string, extra: string, params: unknown[]): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `select id from ${table} where space_id = $1 and ${extra}`,
    [spaceId, ...params],
  );
  return rows.map((r) => r.id);
}

/**
 * Lock and rewrite every run of a space that `matches` (checked again on the
 * locked row). Returns how many changed. Caller holds lockRunsShared and the
 * space row.
 */
async function changeSpaceRuns(
  tx: Queryable,
  spaceId: string,
  candidates: { jobs: string[]; lookups: string[] },
  matches: (row: RunRow) => boolean,
  change: (row: RunRow) => RunRow,
): Promise<number> {
  await lockRunIdsSorted(tx, [...candidates.jobs, ...candidates.lookups]);
  let changed = 0;
  for (const [table, ids] of [
    ["jobs", candidates.jobs],
    ["lookup_jobs", candidates.lookups],
  ] as const) {
    for (const id of ids) {
      const row = await selectRunForUpdate(tx, table, id);
      if (!row || row.spaceId !== spaceId || !matches(row)) continue;
      await updateRunRow(tx, table, change(row));
      changed += 1;
    }
  }
  return changed;
}

export async function archiveProjectSpace(spaceId: string): Promise<{ ok: boolean; runsArchived: number }> {
  return withTx(async (tx) => {
    await lockRunsShared(tx);
    const space = await selectSpaceForUpdate(tx, spaceId);
    if (!space) return { ok: false, runsArchived: 0 };
    const now = new Date().toISOString();
    const notArchived = "coalesce(data->>'archivedAt', '') = ''";
    const candidates = {
      jobs: await spaceRunIds(tx, "jobs", spaceId, notArchived, []),
      lookups: await spaceRunIds(tx, "lookup_jobs", spaceId, notArchived, []),
    };
    const runsArchived = await changeSpaceRuns(
      tx,
      spaceId,
      candidates,
      (row) => !row.archivedAt,
      (row) => ({ ...row, archivedAt: now, updatedAt: now }),
    );
    await saveSpace(tx, { ...space, archivedAt: now, updatedAt: now });
    return { ok: true, runsArchived };
  });
}

/**
 * Bring back an archived client space, and the runs that were archived with
 * it (same archive time). Runs archived separately stay archived.
 */
export async function restoreProjectSpace(spaceId: string): Promise<{ ok: boolean; runsRestored: number }> {
  return withTx(async (tx) => {
    await lockRunsShared(tx);
    const space = await selectSpaceForUpdate(tx, spaceId);
    if (!space?.archivedAt) return { ok: false, runsRestored: 0 };
    const archivedAt = space.archivedAt;
    const now = new Date().toISOString();
    const sameArchive = "data->>'archivedAt' = $2";
    const candidates = {
      jobs: await spaceRunIds(tx, "jobs", spaceId, sameArchive, [archivedAt]),
      lookups: await spaceRunIds(tx, "lookup_jobs", spaceId, sameArchive, [archivedAt]),
    };
    const runsRestored = await changeSpaceRuns(
      tx,
      spaceId,
      candidates,
      (row) => row.archivedAt === archivedAt,
      (row) => ({ ...row, archivedAt: null, updatedAt: now }),
    );
    await saveSpace(tx, { ...space, archivedAt: null, updatedAt: now });
    return { ok: true, runsRestored };
  });
}

export async function assignRunsToSpace(
  spaceId: string,
  runs: Array<{ kind: ProjectKind; id: string }>,
): Promise<number> {
  return withTx(async (tx) => {
    await lockRunsShared(tx);
    const space = await selectSpaceForUpdate(tx, spaceId);
    if (!space || space.archivedAt) return 0;
    await lockRunIdsSorted(tx, runs.map((r) => r.id));
    const now = new Date().toISOString();
    let moved = 0;
    for (const run of runs) {
      const table = tableFor(run.kind);
      const row = await selectRunForUpdate(tx, table, run.id);
      if (!row) continue;
      await updateRunRow(tx, table, {
        ...row,
        spaceId,
        ownerUserId: row.ownerUserId ? row.ownerUserId : space.ownerUserId,
        updatedAt: now,
      });
      moved += 1;
    }
    await saveSpace(tx, { ...space, updatedAt: now });
    return moved;
  });
}

/* ── space memberships ── */

export async function listSpaceMemberships(spaceId?: string): Promise<SpaceMembership[]> {
  const { rows } = await getDb().query<{ data: SpaceMembership }>(
    `select data from space_memberships ${spaceId ? "where space_id = $1" : ""}
      order by (data->>'createdAt') collate "C" asc nulls first, id asc`,
    spaceId ? [spaceId] : [],
  );
  return rows.map((r) => r.data);
}

/** Serializes writers of one (space, user) pair: the table has no unique key on it. */
async function lockSpaceMember(tx: Queryable, spaceId: string, userId: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `space-member:${JSON.stringify([spaceId, userId])}`,
  ]);
}

export async function upsertSpaceMembership(input: {
  spaceId: string;
  userId: string;
  role: "editor" | "viewer";
  grantedByUserId: string;
}): Promise<SpaceMembership> {
  return withTx(async (tx) => {
    await lockSpaceMember(tx, input.spaceId, input.userId);
    const now = new Date().toISOString();
    const { rows } = await tx.query<{ data: SpaceMembership }>(
      `select data from space_memberships where space_id = $1 and user_id = $2
        order by (data->>'createdAt') collate "C" asc nulls first, id asc limit 1 for update`,
      [input.spaceId, input.userId],
    );
    const existing = rows[0]?.data;
    const record: SpaceMembership = existing
      ? { ...existing, role: input.role, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          spaceId: input.spaceId,
          userId: input.userId,
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          createdAt: now,
          updatedAt: now,
        };
    await tx.query(
      `insert into space_memberships (id, space_id, user_id, data) values ($1, $2, $3, $4::jsonb)
       on conflict (id) do update set space_id = excluded.space_id, user_id = excluded.user_id, data = excluded.data`,
      [record.id, record.spaceId, record.userId, JSON.stringify(record)],
    );
    return record;
  });
}

export async function removeSpaceMembership(spaceId: string, userId: string): Promise<boolean> {
  return withTx(async (tx) => {
    await lockSpaceMember(tx, spaceId, userId);
    const result = await tx.query("delete from space_memberships where space_id = $1 and user_id = $2", [
      spaceId,
      userId,
    ]);
    return result.rowCount > 0;
  });
}
