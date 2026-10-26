import {
  RECREATED_PAGE_HEAVY_KEYS,
  type AdminAlert,
  type AppUser,
  type AuditLogEntry,
  type CompetitorRecord,
  type ConversionRuleSet,
  type CreditLedgerEntry,
  type CreditPeriod,
  type CreditReservation,
  type DatabaseShape,
  type IcpRecord,
  type LegacyCompetitorRecord,
  type LoginAttemptRecord,
  type LookupAdRecord,
  type LookupJob,
  type Organization,
  type ProjectMembership,
  type ProjectSpace,
  type ProviderCallRecord,
  type SearchCompetitorAdRecord,
  type SearchJob,
  type SpaceMembership,
} from "../types";
import { archiveOldPages } from "./archive";
import { insertRuleSet, upsertMembershipRow } from "./audit";
import { withTx, type Queryable } from "./client";
import { upsertCompetitor } from "./competitors";
import { upsertReservation, savePeriod } from "./credits";
import { upsertIcpRow } from "./icps";
import { upsertOrganization, upsertUser } from "./identity";
import { migrateDb } from "./legacyStore";
import { upsertLoginAttemptRow } from "./loginAttempts";
import { lastPerId, upsertLookupAds, upsertSearchCompetitorAds } from "./lookups";
import { applyHeavy, planPage } from "./recreatedPages";
import { interruptedRun, isoOrNull, rememberDeletedRuns, upsertRun } from "./runs";
import { saveAppSettings, upsertAdminAlertRow } from "./settings";
import { saveSpace, upsertSpaceMembershipRow } from "./spaces";

/*
 * Full store.json → Postgres import (the cutover data move). Unlike the
 * history import (importHistory.ts) this carries every collection: accounts,
 * organisations, spaces, memberships, credits, ledger, reservations, provider
 * calls, audit, settings, alerts and login attempts, plus all run history and
 * recreated page content.
 *
 * Run it while the app is stopped (idle database): it takes no run locks, and a
 * running app could write between the per-collection transactions.
 *
 * Idempotent: every write is an upsert by the record's key, so importing the
 * same file again leaves the same rows (re-running a rehearsal is safe). The
 * store object is normalized in place by migrateDb, as the file store did on
 * load; the file itself is never written.
 */

export const CUTOVER_MESSAGE = "Interrupted by cutover";

/** The marker keys a light page carries (recreatedPages.ts). */
const MARKER_KEYS = ["hasPage", "pageBytes", "pageUpdatedAt"] as const;

/** Rows per multi-row statement. */
const BATCH = 200;

export interface ImportReport {
  /** Rows written per collection (DatabaseShape key), plus `recreatedPages`. */
  counts: Record<string, number>;
  /** Uncompressed JSON bytes of all recreated page content written. */
  pageBytes: number;
  /** Jobs and lookups that were `running` and were imported as failed. */
  interruptedJobs: number;
  /** Everything the import changed or could not take, with record ids. */
  warnings: string[];
  /** Set when archiving was requested (opts.archiveOlderThanDays). */
  archive?: { archived: number; failed: number; leftInDatabase: number };
}

/** The store as it is imported: migrated, one record per key, interrupted runs failed. */
export interface PreparedStore {
  organizations: Organization[];
  users: AppUser[];
  appSettings: DatabaseShape["appSettings"];
  conversionRuleSets: ConversionRuleSet[];
  creditPeriods: CreditPeriod[];
  creditLedger: CreditLedgerEntry[];
  creditReservations: CreditReservation[];
  providerCalls: ProviderCallRecord[];
  projectMemberships: ProjectMembership[];
  projectSpaces: ProjectSpace[];
  spaceMemberships: SpaceMembership[];
  auditLogs: AuditLogEntry[];
  adminAlerts: AdminAlert[];
  loginAttempts: LoginAttemptRecord[];
  jobs: SearchJob[];
  lookupJobs: LookupJob[];
  competitors: LegacyCompetitorRecord[];
  lookupAds: LookupAdRecord[];
  searchCompetitorAds: SearchCompetitorAdRecord[];
  icps: IcpRecord[];
  seenPageIds: string[];
  deletedRunIds: string[];
  ledgerSeq: number;
  auditSeq: number;
  /** Ids of jobs and lookups that were running in the file. */
  interrupted: Set<string>;
  warnings: string[];
}

type AnyRecord = Record<string, unknown>;

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Records with a usable string id, the last copy per id; the rest are reported. */
function byId<T>(name: string, rows: unknown[], warnings: string[]): T[] {
  const kept: AnyRecord[] = [];
  rows.forEach((row, index) => {
    if (!isRecord(row) || typeof row.id !== "string" || !row.id) {
      warnings.push(`${name}[${index}]: no id; not imported`);
      return;
    }
    kept.push(row);
  });
  const unique = lastPerId(kept as Array<AnyRecord & { id: string }>);
  if (unique.length !== kept.length) {
    const seen = new Map<string, number>();
    for (const row of kept) seen.set(row.id as string, (seen.get(row.id as string) ?? 0) + 1);
    for (const [id, n] of seen) {
      if (n > 1) warnings.push(`${name} ${id}: appears ${n} times; the last copy is imported`);
    }
  }
  return unique as unknown as T[];
}

/** One ICP per source + stage: the newest (createdAt) wins, as the repository keeps one. */
function newestIcps(icps: IcpRecord[], warnings: string[]): IcpRecord[] {
  const byStage = new Map<string, IcpRecord>();
  for (const icp of icps) {
    const key = JSON.stringify([icp.source?.kind, icp.source?.id, icp.stage]);
    const held = byStage.get(key);
    if (!held) {
      byStage.set(key, icp);
      continue;
    }
    const newer = (icp.createdAt || "") >= (held.createdAt || "") ? icp : held;
    const older = newer === icp ? held : icp;
    warnings.push(`icps ${older.id}: same source and stage as ${newer.id}; the newer one is imported`);
    byStage.set(key, newer);
  }
  return [...byStage.values()];
}

/** One provider call per idempotency key (unique in the database): the first one is kept. */
function firstPerIdempotencyKey(calls: ProviderCallRecord[], warnings: string[]): ProviderCallRecord[] {
  const seen = new Map<string, string>();
  const out: ProviderCallRecord[] = [];
  for (const call of calls) {
    const key = typeof call.idempotencyKey === "string" ? call.idempotencyKey : null;
    if (key !== null) {
      const first = seen.get(key);
      if (first !== undefined) {
        warnings.push(`providerCalls ${call.id}: idempotency key already used by ${first}; the first call is kept`);
        continue;
      }
      seen.set(key, call.id);
    }
    out.push(call);
  }
  return out;
}

/**
 * Every row keeps its seq; rows without a usable one (missing, not a positive
 * integer, or already taken) get the next numbers after the highest seq and
 * the stored counter, in file order.
 */
function withSeqs<T extends { id: string; seq: number }>(
  name: string,
  rows: T[],
  storedCounter: number,
  warnings: string[],
): T[] {
  const valid = (seq: unknown): seq is number => typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0;
  const taken = new Set<number>();
  const needs: number[] = [];
  rows.forEach((row, index) => {
    if (valid(row.seq) && !taken.has(row.seq)) taken.add(row.seq);
    else needs.push(index);
  });
  if (!needs.length) return rows;
  let next = Math.max(0, storedCounter, ...taken);
  const out = [...rows];
  for (const index of needs) {
    next += 1;
    const old = out[index].seq;
    warnings.push(
      `${name} ${out[index].id}: ${old === undefined ? "no seq" : `seq ${JSON.stringify(old)} unusable or taken`}; assigned seq ${next}`,
    );
    out[index] = { ...out[index], seq: next };
  }
  return out;
}

/**
 * Runs migrateDb on the raw parsed store (in place) and shapes it for import.
 * Pure apart from the time stamped on interrupted runs. The verifier builds its
 * expectations from the same function.
 */
export function prepareStore(raw: unknown, now: string = new Date().toISOString()): PreparedStore {
  if (!isRecord(raw)) throw new Error("the store is not a JSON object");
  const store = migrateDb(raw as unknown as DatabaseShape);
  const warnings: string[] = [];
  const interrupted = new Set<string>();

  const runs = <T extends SearchJob | LookupJob>(name: string, rows: unknown[]): T[] =>
    byId<T>(name, rows, warnings).map((run) => {
      if (run.status !== "running") return run;
      interrupted.add(run.id);
      return interruptedRun(run, CUTOVER_MESSAGE, now);
    });

  // Rule sets are keyed by version; the last copy of a version wins.
  const ruleSets = new Map<number, ConversionRuleSet>();
  arrayOf<ConversionRuleSet>(store.conversionRuleSets).forEach((set, index) => {
    if (!isRecord(set) || !Number.isSafeInteger(set.version)) {
      warnings.push(`conversionRuleSets[${index}]: no integer version; not imported`);
      return;
    }
    if (ruleSets.has(set.version)) warnings.push(`conversionRuleSets v${set.version}: appears twice; the last copy is imported`);
    ruleSets.delete(set.version);
    ruleSets.set(set.version, set);
  });

  // Login attempts are keyed by `key` (the row id).
  const attempts = new Map<string, LoginAttemptRecord>();
  arrayOf<LoginAttemptRecord>(store.loginAttempts).forEach((row, index) => {
    if (!isRecord(row) || typeof row.key !== "string" || !row.key) {
      warnings.push(`loginAttempts[${index}]: no key; not imported`);
      return;
    }
    attempts.delete(row.key);
    attempts.set(row.key, row);
  });

  const ledgerSeq = typeof store.ledgerSeq === "number" ? store.ledgerSeq : 0;
  const auditSeq = typeof store.auditSeq === "number" ? store.auditSeq : 0;
  const strings = (rows: unknown[]) => [...new Set(rows.filter((v): v is string => typeof v === "string" && v !== ""))];

  return {
    organizations: byId("organizations", arrayOf(store.organizations), warnings),
    users: byId("users", arrayOf(store.users), warnings),
    appSettings: store.appSettings,
    conversionRuleSets: [...ruleSets.values()],
    creditPeriods: byId("creditPeriods", arrayOf(store.creditPeriods), warnings),
    creditLedger: withSeqs("creditLedger", byId<CreditLedgerEntry>("creditLedger", arrayOf(store.creditLedger), warnings), ledgerSeq, warnings),
    creditReservations: byId("creditReservations", arrayOf(store.creditReservations), warnings),
    providerCalls: firstPerIdempotencyKey(byId("providerCalls", arrayOf(store.providerCalls), warnings), warnings),
    projectMemberships: byId("projectMemberships", arrayOf(store.projectMemberships), warnings),
    projectSpaces: byId("projectSpaces", arrayOf(store.projectSpaces), warnings),
    spaceMemberships: byId("spaceMemberships", arrayOf(store.spaceMemberships), warnings),
    auditLogs: withSeqs("auditLogs", byId<AuditLogEntry>("auditLogs", arrayOf(store.auditLogs), warnings), auditSeq, warnings),
    adminAlerts: byId("adminAlerts", arrayOf(store.adminAlerts), warnings),
    loginAttempts: [...attempts.values()],
    jobs: runs<SearchJob>("jobs", arrayOf(store.jobs)),
    lookupJobs: runs<LookupJob>("lookupJobs", arrayOf(store.lookupJobs)),
    competitors: byId("competitors", arrayOf(store.competitors), warnings),
    lookupAds: byId("lookupAds", arrayOf(store.lookupAds), warnings),
    searchCompetitorAds: byId("searchCompetitorAds", arrayOf(store.searchCompetitorAds), warnings),
    icps: newestIcps(byId("icps", arrayOf(store.icps), warnings), warnings),
    seenPageIds: strings(arrayOf(store.seenPageIds)),
    deletedRunIds: strings(arrayOf(store.deletedRunIds)),
    ledgerSeq,
    auditSeq,
    interrupted,
    warnings,
  };
}

/* ── what the database cannot hold ── */

const str = (v: unknown) => typeof v === "string" && v !== "";
const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const time = (v: unknown) => typeof v === "string" && isoOrNull(v) !== null;

/** Required fields per collection: a NOT NULL column (or a cast) would reject the row without them. */
const REQUIRED: Record<string, Record<string, (v: unknown) => boolean>> = {
  users: { username: str, role: str, status: str },
  creditPeriods: { userId: str, status: str, allowanceSubunits: int, consumedSubunits: int, reservedSubunits: int },
  creditLedger: { userId: str },
  creditReservations: { userId: str, periodId: str, status: str, expiresAt: time },
  providerCalls: { chargedUserId: str, provider: str },
  projectMemberships: { projectKind: str, projectId: str, userId: str },
  projectSpaces: { ownerUserId: str },
  spaceMemberships: { spaceId: str, userId: str },
  jobs: { status: str },
  lookupJobs: { status: str },
};

function missingFields(collection: string, row: AnyRecord): string[] {
  const rules = REQUIRED[collection] ?? {};
  return Object.entries(rules)
    .filter(([field, ok]) => !ok(row[field]))
    .map(([field]) => field);
}

/** The rows the database can hold; each other row is reported with its id. */
function storable<T>(collection: string, rows: T[], warnings: string[]): T[] {
  return rows.filter((row) => {
    const missing = missingFields(collection, row as unknown as AnyRecord);
    if (!missing.length) return true;
    const id = (row as unknown as AnyRecord).id;
    warnings.push(`${collection} ${String(id)}: missing or invalid ${missing.join(", ")}; not imported (the table requires it)`);
    return false;
  });
}

/* ── import ── */

type TxRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

/** The transaction runner of `db` when it has one (a test or script client), else withTx. */
function txRunner(db: Queryable): TxRunner {
  const own = (db as Queryable & { tx?: TxRunner }).tx;
  if (!own) return withTx;
  return <T>(fn: (tx: Queryable) => Promise<T>) => own.call(db, fn) as Promise<T>;
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/**
 * Refuses to import into a database that already has accounts (protects a
 * live database from an accidental re-import) unless `allowExisting`.
 */
export async function assertEmptyTarget(db: Queryable, allowExisting: boolean): Promise<void> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from users");
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0 && !allowExisting) {
    throw new Error(
      `the target database already has ${n} user row(s): refusing to import over live data. ` +
        "To re-run an import into a rehearsal database on purpose, pass --allow-existing.",
    );
  }
}

/** When a page's content was last written, taken from the record (archiving ages pages by it). */
function pageTime(page: AnyRecord, competitor: AnyRecord): string {
  return (
    isoOrNull(page.updatedAt as string) ??
    isoOrNull(page.createdAt as string) ??
    isoOrNull(competitor.createdAt as string) ??
    new Date().toISOString()
  );
}

async function insertLedgerRows(tx: Queryable, rows: CreditLedgerEntry[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoOrNull(row.createdAt) }));
  await tx.query(
    `insert into credit_ledger (seq, id, user_id, period_id, created_at, data)
     select (x->'row'->>'seq')::bigint, x->'row'->>'id', x->'row'->>'userId', x->'row'->>'periodId',
            coalesce((x->>'at')::timestamptz, now()), x->'row'
       from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set
       seq        = excluded.seq,
       user_id    = excluded.user_id,
       period_id  = excluded.period_id,
       created_at = excluded.created_at,
       data       = excluded.data`,
    [JSON.stringify(payload)],
  );
}

async function insertAuditRows(tx: Queryable, rows: AuditLogEntry[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoOrNull(row.createdAt) }));
  await tx.query(
    `insert into audit_logs (seq, id, created_at, data)
     select (x->'row'->>'seq')::bigint, x->'row'->>'id', coalesce((x->>'at')::timestamptz, now()), x->'row'
       from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set
       seq        = excluded.seq,
       created_at = excluded.created_at,
       data       = excluded.data`,
    [JSON.stringify(payload)],
  );
}

async function insertProviderCallRows(tx: Queryable, rows: ProviderCallRecord[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoOrNull(row.startedAt) }));
  await tx.query(
    `insert into provider_calls (id, user_id, run_id, provider, created_at, data)
     select x->'row'->>'id', x->'row'->>'chargedUserId', x->'row'->>'runId', x->'row'->>'provider',
            coalesce((x->>'at')::timestamptz, now()), x->'row'
       from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set
       user_id    = excluded.user_id,
       run_id     = excluded.run_id,
       provider   = excluded.provider,
       created_at = excluded.created_at,
       data       = excluded.data`,
    [JSON.stringify(payload)],
  );
}


/**
 * Everything the import will write, decided without a database: the prepared
 * store with the records the tables cannot hold taken out (each reported), and
 * the in-place fixes the import makes (each reported). The dry run prints it.
 */
export interface ImportPlan {
  prepared: PreparedStore;
  users: AppUser[];
  projectSpaces: ProjectSpace[];
  spaceMemberships: SpaceMembership[];
  projectMemberships: ProjectMembership[];
  creditPeriods: CreditPeriod[];
  creditReservations: CreditReservation[];
  creditLedger: CreditLedgerEntry[];
  providerCalls: ProviderCallRecord[];
  jobs: SearchJob[];
  lookupJobs: LookupJob[];
  competitors: LegacyCompetitorRecord[];
  lookupAds: LookupAdRecord[];
  searchCompetitorAds: SearchCompetitorAdRecord[];
  icps: IcpRecord[];
  /** Jobs and lookups that were running and are written as failed. */
  interruptedJobs: number;
  warnings: string[];
}

export function planImport(store: DatabaseShape): ImportPlan {
  const prepared = prepareStore(store);
  const warnings = [...prepared.warnings];

  const usernames = new Map<string, string>();
  const users = storable("users", prepared.users, warnings).filter((user) => {
    const lower = user.username.toLowerCase();
    const holder = usernames.get(lower);
    if (holder !== undefined) {
      warnings.push(`users ${user.id}: username "${user.username}" already belongs to ${holder}; not imported (usernames are unique)`);
      return false;
    }
    usernames.set(lower, user.id);
    return true;
  });

  // One current period per user: the first one in the file (the one the file
  // store read) is kept. Closed periods are written first.
  const currentOf = new Map<string, string>();
  const creditPeriods = storable("creditPeriods", prepared.creditPeriods, warnings).filter((period) => {
    if (period.status !== "current") return true;
    const held = currentOf.get(period.userId);
    if (held !== undefined) {
      warnings.push(`creditPeriods ${period.id}: second current period of user ${period.userId} (first: ${held}); not imported`);
      return false;
    }
    currentOf.set(period.userId, period.id);
    return true;
  });
  creditPeriods.sort((a, b) => Number(a.status === "current") - Number(b.status === "current"));

  const jobs = storable("jobs", prepared.jobs, warnings);
  const lookupJobs = storable("lookupJobs", prepared.lookupJobs, warnings);

  const competitors = prepared.competitors.map((competitor) => {
    if (typeof competitor.runId === "string") return competitor;
    warnings.push(`competitors ${competitor.id}: no runId; imported with an empty run id`);
    return { ...competitor, runId: "" };
  });
  const lookupAds = prepared.lookupAds.map((ad) => {
    if (typeof ad.lookupId === "string") return ad;
    warnings.push(`lookupAds ${ad.id}: no lookupId; imported with an empty lookup id`);
    return { ...ad, lookupId: "" };
  });
  const searchCompetitorAds = prepared.searchCompetitorAds.map((ad) => {
    if (typeof ad.runId === "string" && typeof ad.competitorId === "string") return ad;
    warnings.push(`searchCompetitorAds ${ad.id}: no runId/competitorId; imported with empty ids`);
    return { ...ad, runId: ad.runId ?? "", competitorId: ad.competitorId ?? "" };
  });
  const icps = prepared.icps.filter((icp) => {
    if (isRecord(icp.source) && str(icp.source.kind) && str(icp.source.id) && str(icp.stage)) return true;
    warnings.push(`icps ${icp.id}: missing source or stage; not imported (the table requires them)`);
    return false;
  });

  const plan: ImportPlan = {
    prepared,
    users,
    projectSpaces: storable("projectSpaces", prepared.projectSpaces, warnings),
    spaceMemberships: storable("spaceMemberships", prepared.spaceMemberships, warnings),
    projectMemberships: storable("projectMemberships", prepared.projectMemberships, warnings),
    creditPeriods,
    creditReservations: storable("creditReservations", prepared.creditReservations, warnings),
    creditLedger: storable("creditLedger", prepared.creditLedger, warnings),
    providerCalls: storable("providerCalls", prepared.providerCalls, warnings),
    jobs,
    lookupJobs,
    competitors,
    lookupAds,
    searchCompetitorAds,
    icps,
    interruptedJobs: [...jobs, ...lookupJobs].filter((run) => prepared.interrupted.has(run.id)).length,
    warnings,
  };

  for (const run of [...jobs, ...lookupJobs]) {
    if (prepared.interrupted.has(run.id)) {
      warnings.push(`note: run ${run.id} was running; imported as failed ("${CUTOVER_MESSAGE}")`);
    }
  }
  const inFlight = competitors.filter((c) => {
    const status = isRecord(c.recreatedPage) ? c.recreatedPage.status : null;
    return status === "pending" || status === "design_pending";
  });
  if (inFlight.length) {
    warnings.push(
      `note: ${inFlight.length} recreated page(s) still pending/design_pending in the file (imported as they are): ` +
        inFlight.map((c) => c.id).join(", "),
    );
  }
  return plan;
}

/** Rows each collection will write (the dry run's counts). */
export function planCounts(plan: ImportPlan): Record<string, number> {
  const p = plan.prepared;
  return {
    organizations: p.organizations.length,
    users: plan.users.length,
    appSettings: p.appSettings ? 1 : 0,
    conversionRuleSets: p.conversionRuleSets.length,
    projectSpaces: plan.projectSpaces.length,
    spaceMemberships: plan.spaceMemberships.length,
    projectMemberships: plan.projectMemberships.length,
    creditPeriods: plan.creditPeriods.length,
    creditReservations: plan.creditReservations.length,
    creditLedger: plan.creditLedger.length,
    providerCalls: plan.providerCalls.length,
    auditLogs: p.auditLogs.length,
    adminAlerts: p.adminAlerts.length,
    loginAttempts: p.loginAttempts.length,
    jobs: plan.jobs.length,
    lookupJobs: plan.lookupJobs.length,
    competitors: plan.competitors.length,
    lookupAds: plan.lookupAds.length,
    searchCompetitorAds: plan.searchCompetitorAds.length,
    icps: plan.icps.length,
    seenPageIds: p.seenPageIds.length,
    deletedRunIds: p.deletedRunIds.length,
  };
}

/** A page from the file with any light-page marker removed (reported); the marker described content kept elsewhere. */
function withoutMarker(competitor: LegacyCompetitorRecord, warnings: string[]): LegacyCompetitorRecord["recreatedPage"] {
  const given: unknown = competitor.recreatedPage;
  if (!isRecord(given) || !MARKER_KEYS.some((key) => key in given)) return competitor.recreatedPage;
  const rest: AnyRecord = { ...given };
  for (const key of MARKER_KEYS) delete rest[key];
  if (!RECREATED_PAGE_HEAVY_KEYS.some((key) => key in rest)) {
    warnings.push(`competitors ${competitor.id}: page is light (no content in the file); stored without content`);
  }
  return rest as unknown as LegacyCompetitorRecord["recreatedPage"];
}

/**
 * Imports the whole store. `db` must be the database behind getDb()/withTx
 * when archiving is requested (archiveOldPages uses the shared client).
 * Throws when a collection fails (that collection's transaction rolls back;
 * the ones before it stay and a re-run completes the import).
 */
export async function importStore(
  db: Queryable,
  store: DatabaseShape,
  opts: { archiveOlderThanDays?: number; log?: (message: string) => void } = {},
): Promise<ImportReport> {
  const log = opts.log ?? (() => {});
  const tx = txRunner(db);
  const plan = planImport(store);
  const { prepared, warnings } = plan;
  const counts: Record<string, number> = {};
  let pageBytes = 0;

  /** One collection: one transaction, rows written in parts of BATCH, then `after`. */
  const step = async <T>(
    name: string,
    rows: T[],
    write: (t: Queryable, part: T[]) => Promise<void>,
    after?: (t: Queryable) => Promise<void>,
  ) => {
    const started = Date.now();
    await tx(async (t) => {
      for (const part of chunks(rows)) await write(t, part);
      if (after) await after(t);
    });
    counts[name] = rows.length;
    log(`${name}: ${rows.length} row(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  };
  const each = <T>(write: (t: Queryable, row: T) => Promise<void>) => async (t: Queryable, part: T[]) => {
    for (const row of part) await write(t, row);
  };

  // Accounts first: spaces copy their owner's org from users.
  await step("organizations", prepared.organizations, each(upsertOrganization));
  await step("users", plan.users, each(upsertUser));
  await step("appSettings", prepared.appSettings ? [prepared.appSettings] : [], each(saveAppSettings));
  await step("conversionRuleSets", prepared.conversionRuleSets, each(insertRuleSet));
  await step("projectSpaces", plan.projectSpaces, each(saveSpace));
  await step("spaceMemberships", plan.spaceMemberships, each(upsertSpaceMembershipRow));
  await step("projectMemberships", plan.projectMemberships, each(upsertMembershipRow));

  // Credits.
  await step("creditPeriods", plan.creditPeriods, each(savePeriod));
  await step("creditReservations", plan.creditReservations, each(upsertReservation));
  await step("creditLedger", plan.creditLedger, insertLedgerRows, async (t) => {
    await t.query(
      "select setval('ledger_seq', greatest((select coalesce(max(seq), 0) from credit_ledger), $1::bigint, 1))",
      [prepared.ledgerSeq],
    );
  });
  {
    let kept = 0;
    await step("providerCalls", plan.providerCalls, async (t, part) => {
      // A key the database already holds under another call id (an earlier,
      // different import) keeps that call: the unique index allows one.
      const keys = part.map((c) => c.idempotencyKey).filter((k): k is string => typeof k === "string");
      const { rows: held } = await t.query<{ id: string; key: string }>(
        "select id, data->>'idempotencyKey' as key from provider_calls where data->>'idempotencyKey' = any($1::text[])",
        [keys],
      );
      const holder = new Map(held.map((r) => [r.key, r.id]));
      const writable = part.filter((call) => {
        const other = typeof call.idempotencyKey === "string" ? holder.get(call.idempotencyKey) : undefined;
        if (other !== undefined && other !== call.id) {
          warnings.push(`providerCalls ${call.id}: idempotency key already held in the database by ${other}; not imported`);
          return false;
        }
        return true;
      });
      if (writable.length) await insertProviderCallRows(t, writable);
      kept += writable.length;
    });
    counts.providerCalls = kept;
  }
  await step("auditLogs", prepared.auditLogs, insertAuditRows, async (t) => {
    await t.query(
      "select setval('audit_seq', greatest((select coalesce(max(seq), 0) from audit_logs), $1::bigint, 1))",
      [prepared.auditSeq],
    );
  });
  await step("adminAlerts", prepared.adminAlerts, each(upsertAdminAlertRow));
  await step("loginAttempts", prepared.loginAttempts, each((t, row: LoginAttemptRecord) => upsertLoginAttemptRow(t, row.key, row)));

  // Runs, then what hangs off them.
  await step("jobs", plan.jobs, each((t, job: SearchJob) => upsertRun(t, "jobs", job)));
  await step("lookupJobs", plan.lookupJobs, each((t, job: LookupJob) => upsertRun(t, "lookup_jobs", job)));

  // Competitors (before recreated_pages: content rows reference them). Each
  // page is split: light fields on the competitor row, content gzip in its own
  // statement (the 46 MB record is one parameterized bytea insert).
  {
    const ownerOf = new Map(prepared.jobs.map((job) => [job.id, job.ownerUserId ?? null]));
    let pages = 0;
    let done = 0;
    await step(
      "competitors",
      plan.competitors,
      each(async (t, competitor: LegacyCompetitorRecord) => {
        const incoming = withoutMarker(competitor, warnings);
        // existed=true: a page without content removes a content row left by an earlier import.
        const { page, action } = planPage(incoming ?? null, undefined, undefined, true);
        if (action.kind === "write") {
          // The page's own time, not the import's: archiving ages content by it.
          action.at = pageTime(incoming as unknown as AnyRecord, competitor as unknown as AnyRecord);
          if (page) page.pageUpdatedAt = action.at;
          pageBytes += action.bytes;
          pages += 1;
        }
        const row = { ...competitor, recreatedPage: page } as CompetitorRecord;
        if (incoming === undefined) delete row.recreatedPage;
        await upsertCompetitor(t, row, ownerOf.get(competitor.runId) ?? null);
        await applyHeavy(t, competitor.id, action);
        done += 1;
        if (action.kind === "write" && action.bytes > 5_000_000) {
          log(`competitors: wrote ${competitor.id} page (${(action.bytes / 1e6).toFixed(1)} MB)`);
        }
        if (done % 50 === 0) log(`competitors: ${done}/${plan.competitors.length}`);
      }),
    );
    counts.recreatedPages = pages;
    log(`recreatedPages: ${pages} page(s), ${(pageBytes / 1e6).toFixed(1)} MB of content`);
  }

  await step("lookupAds", plan.lookupAds, upsertLookupAds);
  await step("searchCompetitorAds", plan.searchCompetitorAds, upsertSearchCompetitorAds);
  await step("icps", plan.icps, each(upsertIcpRow));
  await step("seenPageIds", prepared.seenPageIds, async (t, part) => {
    await t.query("insert into seen_page_ids (id) select unnest($1::text[]) on conflict (id) do nothing", [part]);
  });
  // All ids in one statement keeps the file's order (oldest first) in created_at.
  await step("deletedRunIds", prepared.deletedRunIds, async () => {}, (t) => rememberDeletedRuns(t, prepared.deletedRunIds));

  const report: ImportReport = { counts, pageBytes, interruptedJobs: plan.interruptedJobs, warnings };

  if (opts.archiveOlderThanDays !== undefined) {
    let archived = 0;
    let failed = 0;
    // archiveOldPages stops after a time budget; repeat while it makes progress.
    for (;;) {
      const result = await archiveOldPages({ olderThanDays: opts.archiveOlderThanDays });
      archived += result.archived;
      failed += result.failed;
      log(`archive: ${result.archived} archived, ${result.failed} failed`);
      if (result.archived === 0) break;
    }
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from recreated_pages where content is not null");
    report.archive = { archived, failed, leftInDatabase: Number(rows[0]?.n ?? 0) };
  }
  return report;
}
