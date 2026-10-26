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
import { archiveOldPages, deleteArchivedFor } from "./archive";
import { insertRuleSet, upsertMembershipRow } from "./audit";
import { withTx, type Queryable, type TxOptions } from "./client";
import { upsertCompetitor } from "./competitors";
import { upsertReservation, savePeriod } from "./credits";
import { upsertIcpRow } from "./icps";
import { upsertOrganization, upsertUser } from "./identity";
import { jsonText, sanitizeJsonValueWithStats } from "./jsonText";
import { MAX_DELETED_RUN_IDS, migrateDb } from "./legacyStore";
import { upsertLoginAttemptRow } from "./loginAttempts";
import { upsertLookupAds, upsertSearchCompetitorAds } from "./lookups";
import { applyHeavy, planPage } from "./recreatedPages";
import { interruptedRun, rememberDeletedRuns, upsertRun } from "./runs";
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
export const MARKER_KEYS = ["hasPage", "pageBytes", "pageUpdatedAt"] as const;

/** Rows per multi-row statement. */
const BATCH = 200;

export interface ImportReport {
  /** Rows written per collection (DatabaseShape key), plus `recreatedPages`. */
  counts: Record<string, number>;
  /** Uncompressed JSON bytes of all recreated page content written. */
  pageBytes: number;
  /** Jobs and lookups that were `running` and were imported as failed. */
  interruptedJobs: number;
  /** Text jsonb cannot hold (broken emoji, NUL), stored with U+FFFD; also a line in `warnings`. */
  sanitized: SanitizeSummary;
  /** Everything the import changed or could not take, with record ids. */
  warnings: string[];
  /** Records of the file that were not written, with why (see Drop). */
  drops: Drop[];
  /** Set when archiving was requested (opts.archiveOlderThanDays). */
  archive?: { archived: number; failed: number; leftInDatabase: number };
}

/**
 * A record of the file the import does not write. `lost` is true when it is a
 * distinct record the database cannot hold (no id, a required field missing, a
 * second current period, a taken username): data that would be lost, which
 * verifyImport reports as a mismatch. `lost` is false for a collapse that loses
 * nothing the app used: a later copy of the same id (the file store read the
 * first), a later provider call with the same idempotency key, an older ICP of
 * the same stage, a repeated or empty seen/deleted id.
 */
export interface Drop {
  collection: string;
  id: string;
  reason: string;
  lost: boolean;
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
  /** Text jsonb cannot hold, stored with U+FFFD (see SanitizeSummary). */
  sanitized: SanitizeSummary;
  warnings: string[];
  drops: Drop[];
}

type AnyRecord = Record<string, unknown>;

/** Warnings and drops collected while shaping the store. */
interface Notes {
  warnings: string[];
  drops: Drop[];
}

function drop(notes: Notes, collection: string, id: string, reason: string, lost: boolean): void {
  notes.warnings.push(`${collection} ${id}: ${reason}`);
  notes.drops.push({ collection, id, reason, lost });
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A time the database can store: the value as an ISO string (UTC), or null
 * when it is missing or not a date.
 */
export function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * Records keyed by `field` (a non-empty string), the FIRST copy per key (the
 * file store's lookups used find, so the first copy was the one in use).
 */
function firstPerKey<T>(name: string, rows: unknown[], notes: Notes, field = "id"): T[] {
  const kept = new Map<string, AnyRecord>();
  rows.forEach((row, index) => {
    const key = isRecord(row) ? row[field] : undefined;
    if (typeof key !== "string" || !key) {
      drop(notes, name, `[${index}]`, `no ${field}; not imported`, true);
      return;
    }
    if (kept.has(key)) {
      drop(notes, name, key, `appears again at [${index}]; the first copy is imported`, false);
      return;
    }
    kept.set(key, row as AnyRecord);
  });
  return [...kept.values()] as unknown as T[];
}

/** One ICP per source + stage: the newest (createdAt) wins, as the repository keeps one. */
function newestIcps(icps: IcpRecord[], notes: Notes): IcpRecord[] {
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
    drop(notes, "icps", older.id, `same source and stage as ${newer.id}; the newer one is imported`, false);
    byStage.set(key, newer);
  }
  return [...byStage.values()];
}

/** One provider call per idempotency key (unique in the database): the first one is kept. */
function firstPerIdempotencyKey(calls: ProviderCallRecord[], notes: Notes): ProviderCallRecord[] {
  const seen = new Map<string, string>();
  const out: ProviderCallRecord[] = [];
  for (const call of calls) {
    const key = typeof call.idempotencyKey === "string" ? call.idempotencyKey : null;
    if (key !== null) {
      const first = seen.get(key);
      if (first !== undefined) {
        drop(notes, "providerCalls", call.id, `idempotency key already used by ${first}; the first call is kept`, false);
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
 * integer, or already taken by an earlier row) get the next numbers after the
 * highest seq and the stored counter, in file order.
 */
function withSeqs<T extends { id: string; seq: number }>(
  name: string,
  rows: T[],
  storedCounter: number,
  notes: Notes,
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
    notes.warnings.push(
      `${name} ${out[index].id}: ${old === undefined ? "no seq" : `seq ${JSON.stringify(old)} unusable or taken`}; assigned seq ${next}`,
    );
    out[index] = { ...out[index], seq: next };
  }
  return out;
}

/** Seen page ids / deleted run ids: strings (numbers are stringified), each once. */
function idList(name: string, rows: unknown[], notes: Notes): string[] {
  const out = new Set<string>();
  rows.forEach((value, index) => {
    let id: string | null = null;
    if (typeof value === "string") id = value;
    else if (typeof value === "number" && Number.isFinite(value)) {
      id = String(value);
      notes.warnings.push(`${name} [${index}]: number ${value}; imported as the string "${id}"`);
    }
    if (!id) {
      drop(notes, name, `[${index}]`, `${JSON.stringify(value) ?? "undefined"} is not an id; not imported`, false);
      return;
    }
    if (out.has(id)) {
      drop(notes, name, id, `appears again at [${index}]; kept once`, false);
      return;
    }
    out.add(id);
  });
  return [...out];
}

/* ── text Postgres cannot hold ── */

/** How many record ids the sanitize warning lists. */
const SANITIZED_LISTED = 10;

/**
 * Strings the import changed because jsonb cannot hold them (lone UTF-16
 * surrogates: ad copy cut in the middle of an emoji; NUL): each is stored with
 * U+FFFD in its place (jsonText.ts). `records` are "collection:id", in file order.
 */
export interface SanitizeSummary {
  /** Strings (values and object keys) changed. */
  values: number;
  records: string[];
}

export function sanitizeWarning(summary: SanitizeSummary): string {
  const shown = summary.records.slice(0, SANITIZED_LISTED).join(" ");
  const more = summary.records.length > SANITIZED_LISTED ? ` … (${summary.records.length} records in all)` : "";
  return (
    `${summary.values} text values contained broken emoji/NUL characters and were stored with U+FFFD replacement ` +
    `(records: ${shown}${more})`
  );
}

/** A record's name in messages: its id (or key / version), else its position. */
function recordName(record: unknown, index: number): string {
  if (isRecord(record)) {
    for (const field of ["id", "key", "version"]) {
      const value = record[field];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
  }
  return typeof record === "string" ? record : `[${index}]`;
}

/**
 * The store with every string jsonb cannot hold replaced by U+FFFD (a shallow
 * copy; collections and records that change are new, the input is not
 * modified). Import and verify both shape this copy, so what is written and
 * what is expected agree.
 */
function sanitizeStore(store: DatabaseShape): { store: DatabaseShape; summary: SanitizeSummary } {
  const summary: SanitizeSummary = { values: 0, records: [] };
  const source = store as unknown as AnyRecord;
  const out: AnyRecord = { ...source };
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      let rows: unknown[] | null = null;
      value.forEach((row: unknown, index) => {
        const { value: clean, replaced } = sanitizeJsonValueWithStats(row);
        if (!replaced) return;
        summary.values += replaced;
        summary.records.push(`${name}:${recordName(clean, index)}`);
        rows ??= [...value];
        rows[index] = clean;
      });
      if (rows) out[name] = rows;
    } else {
      const { value: clean, replaced } = sanitizeJsonValueWithStats(value);
      if (!replaced) continue;
      summary.values += replaced;
      summary.records.push(name);
      out[name] = clean;
    }
  }
  return { store: out as unknown as DatabaseShape, summary };
}

/**
 * Runs migrateDb on the raw parsed store (in place) and shapes it for import.
 * Text jsonb cannot hold is replaced with U+FFFD (sanitizeStore; reported).
 * Pure apart from the time stamped on interrupted runs. The verifier builds its
 * expectations from the same function.
 */
export function prepareStore(raw: unknown, now: string = new Date().toISOString()): PreparedStore {
  if (!isRecord(raw)) throw new Error("the store is not a JSON object");
  const { store, summary: sanitized } = sanitizeStore(migrateDb(raw as unknown as DatabaseShape));
  const notes: Notes = { warnings: [], drops: [] };
  if (sanitized.values) notes.warnings.push(sanitizeWarning(sanitized));
  const interrupted = new Set<string>();

  const runs = <T extends SearchJob | LookupJob>(name: string, rows: unknown[]): T[] =>
    firstPerKey<T>(name, rows, notes).map((run) => {
      if (run.status !== "running") return run;
      interrupted.add(run.id);
      return interruptedRun(run, CUTOVER_MESSAGE, now);
    });

  // Rule sets are keyed by version.
  const ruleSets = new Map<number, ConversionRuleSet>();
  arrayOf<ConversionRuleSet>(store.conversionRuleSets).forEach((set, index) => {
    if (!isRecord(set) || !Number.isSafeInteger(set.version)) {
      drop(notes, "conversionRuleSets", `[${index}]`, "no integer version; not imported", true);
      return;
    }
    if (ruleSets.has(set.version)) {
      drop(notes, "conversionRuleSets", String(set.version), `appears again at [${index}]; the first copy is imported`, false);
      return;
    }
    ruleSets.set(set.version, set);
  });

  const ledgerSeq = typeof store.ledgerSeq === "number" ? store.ledgerSeq : 0;
  const auditSeq = typeof store.auditSeq === "number" ? store.auditSeq : 0;

  let deletedRunIds = idList("deletedRunIds", arrayOf(store.deletedRunIds), notes);
  if (deletedRunIds.length > MAX_DELETED_RUN_IDS) {
    // The table keeps the newest MAX_DELETED_RUN_IDS, as the file store did.
    for (const id of deletedRunIds.slice(0, deletedRunIds.length - MAX_DELETED_RUN_IDS)) {
      drop(notes, "deletedRunIds", id, `older than the ${MAX_DELETED_RUN_IDS} kept; not imported`, false);
    }
    deletedRunIds = deletedRunIds.slice(-MAX_DELETED_RUN_IDS);
  }

  return {
    organizations: firstPerKey("organizations", arrayOf(store.organizations), notes),
    users: firstPerKey("users", arrayOf(store.users), notes),
    appSettings: store.appSettings,
    conversionRuleSets: [...ruleSets.values()],
    creditPeriods: firstPerKey("creditPeriods", arrayOf(store.creditPeriods), notes),
    creditLedger: withSeqs("creditLedger", firstPerKey<CreditLedgerEntry>("creditLedger", arrayOf(store.creditLedger), notes), ledgerSeq, notes),
    creditReservations: firstPerKey("creditReservations", arrayOf(store.creditReservations), notes),
    providerCalls: firstPerIdempotencyKey(firstPerKey("providerCalls", arrayOf(store.providerCalls), notes), notes),
    projectMemberships: firstPerKey("projectMemberships", arrayOf(store.projectMemberships), notes),
    projectSpaces: firstPerKey("projectSpaces", arrayOf(store.projectSpaces), notes),
    spaceMemberships: firstPerKey("spaceMemberships", arrayOf(store.spaceMemberships), notes),
    auditLogs: withSeqs("auditLogs", firstPerKey<AuditLogEntry>("auditLogs", arrayOf(store.auditLogs), notes), auditSeq, notes),
    adminAlerts: firstPerKey("adminAlerts", arrayOf(store.adminAlerts), notes),
    loginAttempts: firstPerKey("loginAttempts", arrayOf(store.loginAttempts), notes, "key"),
    jobs: runs<SearchJob>("jobs", arrayOf(store.jobs)),
    lookupJobs: runs<LookupJob>("lookupJobs", arrayOf(store.lookupJobs)),
    competitors: firstPerKey("competitors", arrayOf(store.competitors), notes),
    lookupAds: firstPerKey("lookupAds", arrayOf(store.lookupAds), notes),
    searchCompetitorAds: firstPerKey("searchCompetitorAds", arrayOf(store.searchCompetitorAds), notes),
    icps: newestIcps(firstPerKey("icps", arrayOf(store.icps), notes), notes),
    seenPageIds: idList("seenPageIds", arrayOf(store.seenPageIds), notes),
    deletedRunIds,
    ledgerSeq,
    auditSeq,
    interrupted,
    sanitized,
    warnings: notes.warnings,
    drops: notes.drops,
  };
}

/* ── what the database cannot hold ── */

const str = (v: unknown) => typeof v === "string" && v !== "";
const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
const time = (v: unknown) => isoTime(v) !== null;

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

/** The rows the database can hold; each other row is reported as lost. */
function storable<T>(collection: string, rows: T[], notes: Notes): T[] {
  const rules = REQUIRED[collection] ?? {};
  return rows.filter((row) => {
    const record = row as unknown as AnyRecord;
    const missing = Object.entries(rules)
      .filter(([field, ok]) => !ok(record[field]))
      .map(([field]) => field);
    if (!missing.length) return true;
    drop(notes, collection, String(record.id), `missing or invalid ${missing.join(", ")}; not imported (the table requires it)`, true);
    return false;
  });
}

/* ── plan ── */

/**
 * Everything the import will write, decided without a database: the prepared
 * store with the records the tables cannot hold taken out (each reported), and
 * the in-place fixes the import makes (each reported). The dry run prints it
 * and the verifier builds its expectations from it.
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
  /** Text jsonb cannot hold, stored with U+FFFD (also in `warnings`). */
  sanitized: SanitizeSummary;
  warnings: string[];
  drops: Drop[];
}

export function planImport(store: DatabaseShape, now?: string): ImportPlan {
  const prepared = prepareStore(store, now);
  const notes: Notes = { warnings: [...prepared.warnings], drops: [...prepared.drops] };

  const usernames = new Map<string, string>();
  const users = storable("users", prepared.users, notes).filter((user) => {
    const lower = user.username.toLowerCase();
    const holder = usernames.get(lower);
    if (holder !== undefined) {
      drop(notes, "users", user.id, `username "${user.username}" already belongs to ${holder}; not imported (usernames are unique)`, true);
      return false;
    }
    usernames.set(lower, user.id);
    return true;
  });

  // One current period per user: the first one in the file (the one the file
  // store read) is kept. Closed periods are written first.
  const currentOf = new Map<string, string>();
  const creditPeriods = storable("creditPeriods", prepared.creditPeriods, notes).filter((period) => {
    if (period.status !== "current") return true;
    const held = currentOf.get(period.userId);
    if (held !== undefined) {
      drop(notes, "creditPeriods", period.id, `second current period of user ${period.userId} (first: ${held}); not imported`, true);
      return false;
    }
    currentOf.set(period.userId, period.id);
    return true;
  });
  creditPeriods.sort((a, b) => Number(a.status === "current") - Number(b.status === "current"));

  const jobs = storable("jobs", prepared.jobs, notes);
  const lookupJobs = storable("lookupJobs", prepared.lookupJobs, notes);

  const competitors = prepared.competitors.map((competitor) => {
    if (typeof competitor.runId === "string") return competitor;
    notes.warnings.push(`competitors ${competitor.id}: no runId; imported with an empty run id`);
    return { ...competitor, runId: "" };
  });
  const lookupAds = prepared.lookupAds.map((ad) => {
    if (typeof ad.lookupId === "string") return ad;
    notes.warnings.push(`lookupAds ${ad.id}: no lookupId; imported with an empty lookup id`);
    return { ...ad, lookupId: "" };
  });
  const searchCompetitorAds = prepared.searchCompetitorAds.map((ad) => {
    if (typeof ad.runId === "string" && typeof ad.competitorId === "string") return ad;
    notes.warnings.push(`searchCompetitorAds ${ad.id}: no runId/competitorId; imported with empty ids`);
    return { ...ad, runId: typeof ad.runId === "string" ? ad.runId : "", competitorId: typeof ad.competitorId === "string" ? ad.competitorId : "" };
  });
  const icps = prepared.icps.filter((icp) => {
    if (isRecord(icp.source) && str(icp.source.kind) && str(icp.source.id) && str(icp.stage)) return true;
    drop(notes, "icps", icp.id, "missing source or stage; not imported (the table requires them)", true);
    return false;
  });

  const plan: ImportPlan = {
    prepared,
    users,
    projectSpaces: storable("projectSpaces", prepared.projectSpaces, notes),
    spaceMemberships: storable("spaceMemberships", prepared.spaceMemberships, notes),
    projectMemberships: storable("projectMemberships", prepared.projectMemberships, notes),
    creditPeriods,
    creditReservations: storable("creditReservations", prepared.creditReservations, notes),
    creditLedger: storable("creditLedger", prepared.creditLedger, notes),
    providerCalls: storable("providerCalls", prepared.providerCalls, notes),
    jobs,
    lookupJobs,
    competitors,
    lookupAds,
    searchCompetitorAds,
    icps,
    interruptedJobs: [...jobs, ...lookupJobs].filter((run) => prepared.interrupted.has(run.id)).length,
    sanitized: prepared.sanitized,
    warnings: notes.warnings,
    drops: notes.drops,
  };

  for (const run of [...jobs, ...lookupJobs]) {
    if (prepared.interrupted.has(run.id)) {
      notes.warnings.push(`note: run ${run.id} was running; imported as failed ("${CUTOVER_MESSAGE}")`);
    }
  }
  const inFlight = competitors.filter((c) => {
    const status = isRecord(c.recreatedPage) ? c.recreatedPage.status : null;
    return status === "pending" || status === "design_pending";
  });
  if (inFlight.length) {
    notes.warnings.push(
      `note: ${inFlight.length} recreated page(s) still pending/design_pending in the file (imported as they are): ` +
        inFlight.map((c) => c.id).join(", "),
    );
  }
  return plan;
}

/** Rows each collection will write (the dry run's counts), by DatabaseShape key. */
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

/* ── pages ── */

/**
 * When a page's content was last written, taken from the record (archiving
 * ages pages by it): the page's updatedAt, else its createdAt, else the
 * competitor's createdAt, else now. Always an ISO string.
 */
export function pageTime(page: unknown, competitor: unknown): string {
  const p = isRecord(page) ? page : {};
  const c = isRecord(competitor) ? competitor : {};
  return isoTime(p.updatedAt) ?? isoTime(p.createdAt) ?? isoTime(c.createdAt) ?? new Date().toISOString();
}

/** A page from the file with any light-page marker removed (reported); the marker described content kept elsewhere. */
export function withoutMarker(page: unknown, onLight?: () => void): LegacyCompetitorRecord["recreatedPage"] {
  if (!isRecord(page) || !MARKER_KEYS.some((key) => key in page)) return page as LegacyCompetitorRecord["recreatedPage"];
  const rest: AnyRecord = { ...page };
  for (const key of MARKER_KEYS) delete rest[key];
  if (!RECREATED_PAGE_HEAVY_KEYS.some((key) => key in rest)) onLight?.();
  return rest as unknown as LegacyCompetitorRecord["recreatedPage"];
}

/* ── import ── */

type TxRunner = <T>(fn: (tx: Queryable) => Promise<T>, opts?: TxOptions) => Promise<T>;

/**
 * Server-side bound on each import statement (SET LOCAL statement_timeout in
 * every import transaction). Generous: the biggest single statement is a
 * ~25 MB bytea insert over a home connection; it only guards against a hang.
 */
export const IMPORT_STATEMENT_TIMEOUT_MS = 600_000;

/**
 * The transaction runner of `db` when it has one (a test or script client),
 * else withTx; every transaction gets IMPORT_STATEMENT_TIMEOUT_MS.
 */
function txRunner(db: Queryable): <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> {
  const own = (db as Queryable & { tx?: TxRunner }).tx;
  const opts: TxOptions = { statementTimeoutMs: IMPORT_STATEMENT_TIMEOUT_MS };
  if (!own) return (fn) => withTx(fn, opts);
  return <T>(fn: (tx: Queryable) => Promise<T>) => own.call(db, fn, opts) as Promise<T>;
}

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += BATCH) out.push(rows.slice(i, i + BATCH));
  return out;
}

/**
 * Refuses to import into a database that already has accounts (protects a
 * live database from an accidental re-import) unless `allowExisting`.
 * Read-only; a database without the users table (not migrated yet) is empty.
 */
export async function assertEmptyTarget(db: Queryable, allowExisting: boolean): Promise<void> {
  const exists = await db.query<{ found: boolean }>("select to_regclass('public.users') is not null as found");
  if (!exists.rows[0]?.found) return;
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from users");
  const n = Number(rows[0]?.n ?? 0);
  if (n > 0 && !allowExisting) {
    throw new Error(
      `the target database already has ${n} user row(s): refusing to import over live data. ` +
        "To re-run an import into a rehearsal database on purpose, pass --allow-existing.",
    );
  }
}

async function insertLedgerRows(tx: Queryable, rows: CreditLedgerEntry[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoTime(row.createdAt) }));
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
    [jsonText(payload)],
  );
}

async function insertAuditRows(tx: Queryable, rows: AuditLogEntry[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoTime(row.createdAt) }));
  await tx.query(
    `insert into audit_logs (seq, id, created_at, data)
     select (x->'row'->>'seq')::bigint, x->'row'->>'id', coalesce((x->>'at')::timestamptz, now()), x->'row'
       from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set
       seq        = excluded.seq,
       created_at = excluded.created_at,
       data       = excluded.data`,
    [jsonText(payload)],
  );
}

async function insertProviderCallRows(tx: Queryable, rows: ProviderCallRecord[]): Promise<void> {
  const payload = rows.map((row) => ({ row, at: isoTime(row.startedAt) }));
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
    [jsonText(payload)],
  );
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
  const { prepared, warnings, drops } = plan;
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
          drop(
            { warnings, drops },
            "providerCalls",
            call.id,
            `idempotency key already held in the database by ${other}; not imported`,
            true,
          );
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
    // Content an earlier import archived: rewriting or removing it here leaves
    // the Storage object stale; it is deleted after the commit.
    const archivedBefore = new Set(
      (await db.query<{ id: string }>("select competitor_id as id from recreated_pages where archive_path is not null")).rows.map(
        (r) => r.id,
      ),
    );
    const staleArchives: string[] = [];
    let pages = 0;
    let done = 0;
    await step(
      "competitors",
      plan.competitors,
      each(async (t, competitor: LegacyCompetitorRecord) => {
        const incoming = withoutMarker(competitor.recreatedPage, () =>
          warnings.push(`competitors ${competitor.id}: page is light (no content in the file); stored without content`),
        );
        // existed=true: a page without content removes a content row left by an earlier import.
        const { page, action } = planPage(incoming ?? null, undefined, undefined, true);
        if (action.kind === "write") {
          // The page's own time, not the import's: archiving ages content by it.
          action.at = pageTime(incoming, competitor);
          if (page) page.pageUpdatedAt = action.at;
          pageBytes += action.bytes;
          pages += 1;
        }
        const row = { ...competitor, recreatedPage: page } as CompetitorRecord;
        if (incoming === undefined) delete row.recreatedPage;
        await upsertCompetitor(t, row, ownerOf.get(competitor.runId) ?? null);
        await applyHeavy(t, competitor.id, action);
        if (action.kind !== "keep" && archivedBefore.has(competitor.id)) staleArchives.push(competitor.id);
        done += 1;
        if (action.kind === "write" && action.bytes > 5_000_000) {
          log(`competitors: wrote ${competitor.id} page (${(action.bytes / 1e6).toFixed(1)} MB)`);
        }
        if (done % 50 === 0) log(`competitors: ${done}/${plan.competitors.length}`);
      }),
    );
    counts.recreatedPages = pages;
    log(`recreatedPages: ${pages} page(s), ${(pageBytes / 1e6).toFixed(1)} MB of content`);
    if (staleArchives.length) {
      await deleteArchivedFor(staleArchives);
      log(`archive: removed ${staleArchives.length} stale archive object(s) (content is back in the database)`);
    }
  }

  await step("lookupAds", plan.lookupAds, upsertLookupAds);
  await step("searchCompetitorAds", plan.searchCompetitorAds, upsertSearchCompetitorAds);
  await step("icps", plan.icps, each(upsertIcpRow));
  await step("seenPageIds", prepared.seenPageIds, async (t, part) => {
    await t.query("insert into seen_page_ids (id) select unnest($1::text[]) on conflict (id) do nothing", [part]);
  });
  // All ids in one statement keeps the file's order (oldest first) in created_at.
  await step("deletedRunIds", prepared.deletedRunIds, async () => {}, (t) => rememberDeletedRuns(t, prepared.deletedRunIds));

  const report: ImportReport = {
    counts,
    pageBytes,
    interruptedJobs: plan.interruptedJobs,
    sanitized: plan.sanitized,
    warnings,
    drops,
  };

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
