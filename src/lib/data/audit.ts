import { seedConversionRuleSet } from "../accounting/conversion";
import type { AuditLogEntry, ConversionRuleSet, ProjectKind, ProjectMembership } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { IDENTITY_LOCK_CLASS } from "./identity";
import { jsonText } from "./jsonText";
import { getAppSettings, lockAppSettings, saveAppSettings } from "./settings";

/*
 * Audit log, project memberships and conversion rule sets, ported from
 * accounting/records.ts (the credit ledger half lives with the credits
 * repository).
 */

const CONVERSION_RULES_LOCK_ID = 3;

/* ── conversion rule sets ── */

/**
 * The stored rule sets, or the seed when none is stored: db.ts normalized an
 * empty list to [seedConversionRuleSet()], so callers always saw one.
 */
async function storedOrSeedRuleSets(q: Queryable): Promise<ConversionRuleSet[]> {
  const { rows } = await q.query<{ data: ConversionRuleSet }>(
    "select data from conversion_rule_sets order by version desc",
  );
  return rows.length ? rows.map((r) => r.data) : [seedConversionRuleSet()];
}

export async function listConversionRuleSets(): Promise<ConversionRuleSet[]> {
  return storedOrSeedRuleSets(getDb());
}

export async function getConversionRuleSet(version: number): Promise<ConversionRuleSet | null> {
  return (await storedOrSeedRuleSets(getDb())).find((r) => r.version === version) ?? null;
}

/** The rule set new charges are converted with. */
export async function getActiveConversionRuleSet(): Promise<ConversionRuleSet> {
  const wanted = (await getAppSettings()).activeConversionRuleVersion;
  const sets = await storedOrSeedRuleSets(getDb());
  return sets.find((r) => r.version === wanted) ?? sets[0] ?? seedConversionRuleSet();
}

/** Inserts or replaces one rule set version (also used by the store import). */
export async function insertRuleSet(tx: Queryable, set: ConversionRuleSet): Promise<void> {
  await tx.query(
    `insert into conversion_rule_sets (version, data) values ($1, $2::jsonb)
     on conflict (version) do update set data = excluded.data`,
    [set.version, jsonText(set)],
  );
}

/**
 * Rules are versioned, never edited in place: publishing appends a new version
 * and activates it, so historical charges keep resolving to the rates that
 * actually produced them.
 */
export async function publishConversionRuleSet(input: {
  rates: ConversionRuleSet["rates"];
  perCallReservationCeiling: ConversionRuleSet["perCallReservationCeiling"];
  note: string | null;
  actorUserId: string;
}): Promise<ConversionRuleSet> {
  return withTx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1::int, $2::int)", [IDENTITY_LOCK_CLASS, CONVERSION_RULES_LOCK_ID]);
    const { rows } = await tx.query<{ max: number | null }>("select max(version) as max from conversion_rule_sets");
    let max = rows[0]?.max ?? null;
    if (max === null) {
      // Store the seed the empty store stood for, so its version stays taken.
      const seed = seedConversionRuleSet();
      await insertRuleSet(tx, seed);
      max = seed.version;
    }
    const created: ConversionRuleSet = {
      version: Number(max) + 1,
      createdAt: new Date().toISOString(),
      createdByUserId: input.actorUserId,
      note: input.note,
      rates: input.rates,
      perCallReservationCeiling: input.perCallReservationCeiling,
    };
    await insertRuleSet(tx, created);
    const settings = await lockAppSettings(tx);
    await saveAppSettings(tx, {
      ...settings,
      activeConversionRuleVersion: created.version,
      updatedAt: created.createdAt,
      updatedByUserId: input.actorUserId,
    });
    return created;
  });
}

/* ── project memberships ── */

export async function listMemberships(filter?: {
  userId?: string;
  projectKind?: ProjectKind;
  projectId?: string;
}): Promise<ProjectMembership[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: string | undefined) => {
    if (!value) return;
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  };
  add("user_id", filter?.userId);
  add("project_kind", filter?.projectKind);
  add("project_id", filter?.projectId);
  const { rows } = await getDb().query<{ data: ProjectMembership }>(
    `select data from project_memberships ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      order by (data->>'createdAt') collate "C" asc nulls first, id asc`,
    params,
  );
  return rows.map((r) => r.data);
}

async function selectMembership(
  q: Queryable,
  projectKind: ProjectKind,
  projectId: string,
  userId: string,
  forUpdate: boolean,
): Promise<ProjectMembership | null> {
  const { rows } = await q.query<{ data: ProjectMembership }>(
    `select data from project_memberships
      where project_kind = $1 and project_id = $2 and user_id = $3
      order by (data->>'createdAt') collate "C" asc nulls first, id asc
      limit 1${forUpdate ? " for update" : ""}`,
    [projectKind, projectId, userId],
  );
  return rows[0]?.data ?? null;
}

export async function getMembership(
  projectKind: ProjectKind,
  projectId: string,
  userId: string,
): Promise<ProjectMembership | null> {
  return selectMembership(getDb(), projectKind, projectId, userId, false);
}

/** Serializes writers of one (project, user) pair: the table has no unique key on it. */
async function lockMember(tx: Queryable, projectKind: ProjectKind, projectId: string, userId: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `project-member:${JSON.stringify([projectKind, projectId, userId])}`,
  ]);
}

export async function upsertMembership(input: {
  projectKind: ProjectKind;
  projectId: string;
  userId: string;
  role: ProjectMembership["role"];
  grantedByUserId: string;
}): Promise<ProjectMembership> {
  return withTx(async (tx) => {
    await lockMember(tx, input.projectKind, input.projectId, input.userId);
    const now = new Date().toISOString();
    const existing = await selectMembership(tx, input.projectKind, input.projectId, input.userId, true);
    const record: ProjectMembership = existing
      ? { ...existing, role: input.role, grantedByUserId: input.grantedByUserId, updatedAt: now }
      : {
          id: crypto.randomUUID(),
          projectKind: input.projectKind,
          projectId: input.projectId,
          userId: input.userId,
          role: input.role,
          grantedByUserId: input.grantedByUserId,
          createdAt: now,
          updatedAt: now,
        };
    await upsertMembershipRow(tx, record);
    return record;
  });
}

/** Inserts or replaces one membership row (also used by the store import). */
export async function upsertMembershipRow(tx: Queryable, record: ProjectMembership): Promise<void> {
  await tx.query(
    `insert into project_memberships (id, project_kind, project_id, user_id, data)
     values ($1, $2, $3, $4, $5::jsonb)
     on conflict (id) do update set
       project_kind = excluded.project_kind,
       project_id   = excluded.project_id,
       user_id      = excluded.user_id,
       data         = excluded.data`,
    [record.id, record.projectKind, record.projectId, record.userId, jsonText(record)],
  );
}

export async function removeMembership(projectKind: ProjectKind, projectId: string, userId: string): Promise<boolean> {
  return withTx(async (tx) => {
    await lockMember(tx, projectKind, projectId, userId);
    const result = await tx.query(
      "delete from project_memberships where project_kind = $1 and project_id = $2 and user_id = $3",
      [projectKind, projectId, userId],
    );
    return result.rowCount > 0;
  });
}

/* ── audit log ── */

export interface AuditDraft {
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  targetUserId?: string | null;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  details?: Record<string, string | number | boolean | null> | null;
}

/**
 * Never pass credentials, API keys or prompt content in `details`. Pass the
 * transaction handle to record the entry atomically with the change it
 * describes. `seq` comes from audit_seq.
 */
export async function recordAudit(draft: AuditDraft, q: Queryable = getDb()): Promise<AuditLogEntry> {
  const entry: Omit<AuditLogEntry, "seq"> = {
    id: crypto.randomUUID(),
    actorUserId: draft.actorUserId,
    actorUsername: draft.actorUsername,
    action: draft.action,
    targetUserId: draft.targetUserId ?? null,
    projectKind: draft.projectKind ?? null,
    projectId: draft.projectId ?? null,
    details: draft.details ?? null,
    createdAt: new Date().toISOString(),
  };
  // One statement: the sequence value goes into both the column and `data`.
  const { rows } = await q.query<{ seq: string | number }>(
    `insert into audit_logs (seq, id, created_at, data)
     select n.seq, $1, $2::timestamptz, $3::jsonb || jsonb_build_object('seq', n.seq)
       from (select nextval('audit_seq') as seq) n
     returning seq`,
    [entry.id, entry.createdAt, jsonText(entry)],
  );
  if (!rows[0]) throw new Error("recordAudit: insert returned no row");
  return { ...entry, seq: Number(rows[0].seq) };
}

export async function queryAudit(filter?: {
  actorUserId?: string;
  targetUserId?: string;
  action?: string;
  /** e.g. "admin.credits" matches every credit action. */
  actionPrefix?: string;
  excludeActions?: Set<string>;
  from?: string;
  to?: string;
  limit?: number;
  /** Only entries done by or to one of these users (an organisation). */
  userIds?: Set<string> | null;
}): Promise<AuditLogEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filter?.userIds) {
    const ids = param([...filter.userIds]);
    conditions.push(
      `(coalesce(data->>'actorUserId', '') <> '' and data->>'actorUserId' = any(${ids}::text[])
        or coalesce(data->>'targetUserId', '') <> '' and data->>'targetUserId' = any(${ids}::text[]))`,
    );
  }
  if (filter?.actorUserId) conditions.push(`data->>'actorUserId' = ${param(filter.actorUserId)}`);
  if (filter?.targetUserId) conditions.push(`data->>'targetUserId' = ${param(filter.targetUserId)}`);
  if (filter?.action) conditions.push(`data->>'action' = ${param(filter.action)}`);
  if (filter?.actionPrefix) {
    const p = param(filter.actionPrefix);
    conditions.push(`left(data->>'action', length(${p})) = ${p}`);
  }
  if (filter?.excludeActions?.size) {
    conditions.push(`not (data->>'action' = any(${param([...filter.excludeActions])}::text[]))`);
  }
  // String comparison, as db.ts did with ISO strings.
  if (filter?.from) conditions.push(`(data->>'createdAt') collate "C" >= ${param(filter.from)}`);
  if (filter?.to) conditions.push(`(data->>'createdAt') collate "C" <= ${param(filter.to)}`);
  const limit = param(filter?.limit ?? 200);
  const { rows } = await getDb().query<{ data: AuditLogEntry }>(
    `select data from audit_logs ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      order by seq desc limit ${limit}`,
    params,
  );
  return rows.map((r) => r.data);
}
