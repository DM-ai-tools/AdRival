import fs from "fs";
import path from "path";
import type {
  AppSettings,
  AppUser,
  AdminAlert,
  AppUserPublic,
  CompetitorRecord,
  DatabaseShape,
  HistoryRunSummary,
  LookupAdRecord,
  SearchCompetitorAdRecord,
  LookupHistorySummary,
  LookupJob,
  ProjectKind,
  ProjectSpace,
  SearchJob,
  SpaceMembership,
  UserRole,
  UserStatus,
} from "./types";
import { seedConversionRuleSet } from "./accounting/conversion";
import { creditsToSubunits } from "./accounting/units";

/** ADRIVAL_DATA_DIR lets tests point the store at a scratch directory. */
const DATA_DIR =
  process.env.ADRIVAL_DATA_DIR?.trim() || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "store.json");
const DB_LOCK_PATH = path.join(DATA_DIR, "store.json.lock");

/** Current store shape. Bump whenever migrateDb() gains a step. */
export const SCHEMA_VERSION = 2;

/** In-process cache so status polls don't re-parse a multi-MB store on every request. */
let memoryDb: DatabaseShape | null = null;
/**
 * `mtime:size` of the file this process last loaded or wrote. Next.js can
 * bundle this module twice, so a write in the credits route must be visible
 * to the users route. Matching the file stamp forces a re-read instead of
 * serving a balance frozen before the last adjustment.
 */
let memoryDbStamp = "";

/**
 * Tombstones for runs deleted while a pipeline is still in-flight.
 * Without this, saveJob() re-creates the deleted row on the next progress tick.
 */
const suppressedSearchJobIds = new Set<string>();
const suppressedLookupJobIds = new Set<string>();

/**
 * Re-entrancy depth. Accounting composes several store mutations into one
 * logical transaction, so an inner withDbLock must not deadlock on the
 * lockfile this same process already holds.
 */
let lockDepth = 0;

/** Cross-request / multi-process lock for read-modify-write of store.json */
function withDbLock<T>(fn: () => T): T {
  if (lockDepth > 0) {
    lockDepth += 1;
    try {
      return fn();
    } finally {
      lockDepth -= 1;
    }
  }
  const started = Date.now();
  while (true) {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const fd = fs.openSync(DB_LOCK_PATH, "wx");
      fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}`);
      fs.closeSync(fd);
      break;
    } catch {
      if (Date.now() - started > 15_000) {
        // Stale lock recovery
        try {
          fs.unlinkSync(DB_LOCK_PATH);
        } catch {
          /* ignore */
        }
        if (Date.now() - started > 20_000) {
          throw new Error("Timed out waiting for data store lock");
        }
      }
      const waitUntil = Date.now() + 25;
      while (Date.now() < waitUntil) {
        /* spin */
      }
    }
  }
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    try {
      fs.unlinkSync(DB_LOCK_PATH);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read-modify-write the whole store under the exclusive lock. This is the
 * concurrency control the credit accounting service relies on: two runs
 * reserving credits at the same time are serialized here, so they cannot both
 * observe the same available balance.
 */
export function transaction<T>(fn: (db: DatabaseShape) => T): T {
  return withDbLock(() => {
    const db = ensureDb();
    const result = fn(db);
    writeDb(db);
    return result;
  });
}

/** Consistent read snapshot. Callers must not mutate the returned object. */
export function readDb(): DatabaseShape {
  return ensureDb();
}

export function isSearchJobSuppressed(jobId: string): boolean {
  if (suppressedSearchJobIds.has(jobId)) return true;
  // Durable across duplicate Next.js module instances (in-memory Set is not shared).
  const job = ensureDb().jobs.find((j) => j.id === jobId);
  if (job?.progress?.stopRequested) {
    suppressedSearchJobIds.add(jobId);
    return true;
  }
  return false;
}

/** Stop an in-flight keyword search (pipeline checks suppression each page). */
export function stopSearchJob(
  jobId: string,
  reason = "Stopped by user",
): SearchJob | null {
  suppressedSearchJobIds.add(jobId);
  return withDbLock(() => {
    const db = ensureDb();
    const now = new Date().toISOString();
    for (const lj of db.lookupJobs ?? []) {
      if (!lj.id.startsWith(`search-offers:${jobId}`)) continue;
      suppressedLookupJobIds.add(lj.id);
      if (
        lj.status === "running" ||
        lj.progress?.stage === "analyzing_offers"
      ) {
        lj.status = lj.adIds?.length ? "partial" : "failed";
        lj.error = reason;
        lj.progress = {
          ...lj.progress,
          stage: "done",
          message: reason,
          stopRequested: true,
          offersPhase: "failed",
          offersCurrentName: null,
        };
        lj.updatedAt = now;
      }
    }
    const idx = db.jobs.findIndex((j) => j.id === jobId);
    if (idx < 0) {
      writeDb(db);
      return null;
    }
    const prev = db.jobs[idx];
    const hasRoster = (prev.competitorIds?.length || 0) > 0;
    const inOffers = prev.progress?.stage === "analyzing_offers";
    db.jobs[idx] = {
      ...prev,
      status: hasRoster
        ? prev.status === "running"
          ? "partial"
          : prev.status
        : "failed",
      error: hasRoster ? prev.error : reason,
      offersReport: inOffers
        ? {
            status: "failed",
            createdAt:
              prev.offersReport?.createdAt || now,
            updatedAt: now,
            error: reason,
            adsAnalyzed: prev.offersReport?.adsAnalyzed || 0,
            adCopy: prev.offersReport?.adCopy || {
              uniqueCreatives: 0,
              creatives: [],
              uniqueOffers: [],
            },
            landingPages: prev.offersReport?.landingPages || {
              uniqueUrls: 0,
              analyzed: 0,
              failed: 0,
              pages: [],
              uniqueOffers: [],
            },
          }
        : prev.offersReport,
      progress: {
        ...prev.progress,
        stage: hasRoster ? "done" : "failed",
        message: reason,
        stopRequested: true,
        offersPhase: inOffers ? "failed" : prev.progress.offersPhase,
        offersCurrentName: null,
      },
      updatedAt: now,
    };
    writeDb(db);
    return db.jobs[idx];
  });
}

export function isLookupJobSuppressed(lookupId: string): boolean {
  if (suppressedLookupJobIds.has(lookupId)) return true;
  // Durable across duplicate Next.js module instances (in-memory Set is not shared).
  const job = ensureDb().lookupJobs?.find((j) => j.id === lookupId);
  if (job?.progress?.stopRequested) {
    suppressedLookupJobIds.add(lookupId);
    return true;
  }
  return false;
}

export function listLookupJobs(limit = 200): LookupJob[] {
  return (ensureDb().lookupJobs ?? []).slice(0, limit);
}

/** Stop an in-flight competitor lookup (including offers analysis). */
export function stopLookupJob(
  lookupId: string,
  reason = "Stopped by user",
): LookupJob | null {
  suppressedLookupJobIds.add(lookupId);
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupJobs) db.lookupJobs = [];
    const idx = db.lookupJobs.findIndex((j) => j.id === lookupId);
    if (idx < 0) {
      writeDb(db);
      return null;
    }
    const prev = db.lookupJobs[idx];
    const hasAds = (prev.adIds?.length || 0) > 0;
    const inOffers = prev.progress?.stage === "analyzing_offers";
    const now = new Date().toISOString();
    db.lookupJobs[idx] = {
      ...prev,
      status: hasAds
        ? prev.status === "running"
          ? "partial"
          : prev.status
        : "failed",
      error: hasAds ? prev.error : reason,
      offersReport: inOffers
        ? {
            status: "failed",
            createdAt: prev.offersReport?.createdAt || now,
            updatedAt: now,
            error: reason,
            adsAnalyzed: prev.offersReport?.adsAnalyzed || 0,
            adCopy: prev.offersReport?.adCopy || {
              uniqueCreatives: 0,
              creatives: [],
              uniqueOffers: [],
            },
            landingPages: prev.offersReport?.landingPages || {
              uniqueUrls: 0,
              analyzed: 0,
              failed: 0,
              pages: [],
              uniqueOffers: [],
            },
          }
        : prev.offersReport,
      progress: {
        ...prev.progress,
        stage: hasAds ? "done" : "failed",
        message: reason,
        stopRequested: true,
        offersPhase: inOffers ? "failed" : prev.progress.offersPhase,
        offersCurrentName: null,
      },
      updatedAt: now,
    };
    writeDb(db);
    return db.lookupJobs[idx];
  });
}

const SEARCH_IN_FLIGHT_STAGES = new Set([
  "expanding_queries",
  "searching_ads",
  "analyzing_ad",
  "filling_quota",
  "brand_review",
  "analyzing_offers",
  "searching_pages",
  "fetching_ads",
]);

const LOOKUP_IN_FLIGHT_STAGES = new Set([
  "searching_pages",
  "verifying_page",
  "fetching_ads",
  "analyzing_offers",
]);

export function isSearchWorkInFlight(job: SearchJob): boolean {
  if (suppressedSearchJobIds.has(job.id) || job.progress?.stopRequested) return false;
  return (
    job.status === "running" ||
    SEARCH_IN_FLIGHT_STAGES.has(job.progress?.stage || "")
  );
}

export function isLookupWorkInFlight(job: LookupJob): boolean {
  if (suppressedLookupJobIds.has(job.id) || job.progress?.stopRequested) return false;
  return (
    job.status === "running" ||
    LOOKUP_IN_FLIGHT_STAGES.has(job.progress?.stage || "")
  );
}

/** Stop every in-flight search, lookup, brand review, and offers analysis. */
export function stopAllInFlightWork(
  reason = "Stopped by user",
  extra?: { jobIds?: string[]; lookupIds?: string[] },
): { searchJobIds: string[]; lookupIds: string[] } {
  const searchJobIds = new Set<string>(extra?.jobIds?.filter(Boolean) || []);
  const lookupIds = new Set<string>(extra?.lookupIds?.filter(Boolean) || []);
  for (const job of listJobs(200)) {
    if (isSearchWorkInFlight(job)) searchJobIds.add(job.id);
  }
  for (const job of listLookupJobs(200)) {
    if (isLookupWorkInFlight(job)) lookupIds.add(job.id);
  }
  const stoppedSearch: string[] = [];
  const stoppedLookup: string[] = [];
  for (const id of searchJobIds) {
    if (stopSearchJob(id, reason)) stoppedSearch.push(id);
    else suppressedSearchJobIds.add(id);
  }
  for (const id of lookupIds) {
    if (stopLookupJob(id, reason)) stoppedLookup.push(id);
    else suppressedLookupJobIds.add(id);
  }
  return { searchJobIds: stoppedSearch, lookupIds: stoppedLookup };
}

export function defaultAppSettings(): AppSettings {
  return {
    // Closed by default: a fresh deployment should not accept signups before
    // the operator has bootstrapped the first admin.
    publicSignupEnabled: false,
    // Zero credits for new users unless an admin raises this.
    defaultAllowanceSubunits: 0,
    defaultResetCadence: "none",
    lowCreditWarningSubunits: creditsToSubunits(25),
    maxConcurrentRunsPerUser: 3,
    maxRunReservationSubunits: creditsToSubunits(500),
    disabledProviders: [],
    disabledModels: [],
    activeConversionRuleVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedByUserId: null,
  };
}

function emptyDb(): DatabaseShape {
  return migrateDb({
    schemaVersion: 0,
    jobs: [],
    competitors: [],
    seenPageIds: [],
    lookupJobs: [],
    lookupAds: [],
    searchCompetitorAds: [],
    users: [],
  });
}

/**
 * Forward-only store migrations.
 *
 * v1 → v2 (multi-user workspaces, credits, admin):
 *   - adds the accounting/authorization collections
 *   - seeds settings and conversion rule set v1
 *   - backfills role/status/sessionEpoch on pre-existing users
 *   - deliberately does NOT infer ownership for pre-existing jobs. Rows keep
 *     `ownerUserId === undefined` and are only reachable from the admin
 *     "Unassigned projects" screen until an admin assigns an owner.
 */
function migrateDb(parsed: DatabaseShape): DatabaseShape {
  if (!parsed.jobs) parsed.jobs = [];
  if (!parsed.competitors) parsed.competitors = [];
  if (!parsed.seenPageIds) parsed.seenPageIds = [];
  if (!parsed.lookupJobs) parsed.lookupJobs = [];
  if (!parsed.lookupAds) parsed.lookupAds = [];
  if (!parsed.searchCompetitorAds) parsed.searchCompetitorAds = [];
  if (!parsed.users) parsed.users = [];

  const from = parsed.schemaVersion ?? 1;

  if (from < 2) {
    if (!parsed.appSettings) parsed.appSettings = defaultAppSettings();
    if (!parsed.conversionRuleSets?.length) {
      parsed.conversionRuleSets = [seedConversionRuleSet()];
    }
    for (const user of parsed.users) {
      // Existing accounts predate roles. They become regular users; the first
      // admin must be created through the documented bootstrap.
      if (!user.role) user.role = "user";
      if (!user.status) user.status = "active";
      if (typeof user.sessionEpoch !== "number") user.sessionEpoch = 1;
      if (typeof user.mustChangePassword !== "boolean") {
        user.mustChangePassword = false;
      }
    }
  }

  if (!parsed.appSettings) parsed.appSettings = defaultAppSettings();
  if (!parsed.conversionRuleSets?.length) {
    parsed.conversionRuleSets = [seedConversionRuleSet()];
  }
  if (!parsed.creditPeriods) parsed.creditPeriods = [];
  if (!parsed.creditLedger) parsed.creditLedger = [];
  if (!parsed.creditReservations) parsed.creditReservations = [];
  if (!parsed.providerCalls) parsed.providerCalls = [];
  if (!parsed.projectMemberships) parsed.projectMemberships = [];
  if (!parsed.projectSpaces) parsed.projectSpaces = [];
  if (!parsed.spaceMemberships) parsed.spaceMemberships = [];
  if (!parsed.auditLogs) parsed.auditLogs = [];
  if (!parsed.adminAlerts) parsed.adminAlerts = [];
  if (!parsed.loginAttempts) parsed.loginAttempts = [];
  if (typeof parsed.ledgerSeq !== "number") {
    parsed.ledgerSeq = parsed.creditLedger.length;
  }
  if (typeof parsed.auditSeq !== "number") {
    parsed.auditSeq = parsed.auditLogs.length;
  }

  parsed.schemaVersion = SCHEMA_VERSION;
  return parsed;
}

function hydrateDb(parsed: DatabaseShape): DatabaseShape {
  return migrateDb(parsed);
}

function storeStamp(): string {
  try {
    const stat = fs.statSync(DB_PATH);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "";
  }
}

function ensureDb(): DatabaseShape {
  const stamp = storeStamp();
  if (memoryDb && stamp && stamp === memoryDbStamp) return memoryDb;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    memoryDb = db;
    fs.writeFileSync(DB_PATH, JSON.stringify(db), "utf8");
    memoryDbStamp = storeStamp();
    return db;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as DatabaseShape;
    const previousVersion = parsed.schemaVersion ?? 1;
    memoryDb = hydrateDb(parsed);
    if (previousVersion < SCHEMA_VERSION) {
      // Persist the migration immediately so a read-only request path cannot
      // leave the on-disk store un-migrated.
      fs.writeFileSync(DB_PATH, JSON.stringify(memoryDb), "utf8");
    }
    memoryDbStamp = storeStamp();
    return memoryDb;
  } catch {
    memoryDb = emptyDb();
    memoryDbStamp = "";
    return memoryDb;
  }
}

function writeDb(db: DatabaseShape) {
  memoryDb = db;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db), "utf8");
  memoryDbStamp = storeStamp();
}

/**
 * Shape an imported payload into a store. Only run/history collections are
 * taken from the import — accounts, credits, ledger, audit and settings are
 * always preserved from the live store so a history import can never clobber
 * billing or authorization data.
 */
function normalizeDb(input: Partial<DatabaseShape> | null | undefined): DatabaseShape {
  const current = ensureDb();
  const db = emptyDb();
  db.users = current.users;
  db.appSettings = current.appSettings;
  db.conversionRuleSets = current.conversionRuleSets;
  db.creditPeriods = current.creditPeriods;
  db.creditLedger = current.creditLedger;
  db.creditReservations = current.creditReservations;
  db.providerCalls = current.providerCalls;
  db.projectMemberships = current.projectMemberships;
  db.projectSpaces = current.projectSpaces;
  db.spaceMemberships = current.spaceMemberships;
  db.auditLogs = current.auditLogs;
  db.adminAlerts = current.adminAlerts;
  db.loginAttempts = current.loginAttempts;
  db.ledgerSeq = current.ledgerSeq;
  db.auditSeq = current.auditSeq;
  if (!input || typeof input !== "object") return db;
  if (Array.isArray(input.jobs)) db.jobs = input.jobs;
  if (Array.isArray(input.competitors)) db.competitors = input.competitors;
  if (Array.isArray(input.seenPageIds)) db.seenPageIds = input.seenPageIds;
  if (Array.isArray(input.lookupJobs)) db.lookupJobs = input.lookupJobs;
  if (Array.isArray(input.lookupAds)) db.lookupAds = input.lookupAds;
  if (Array.isArray(input.searchCompetitorAds)) {
    db.searchCompetitorAds = input.searchCompetitorAds;
  }
  return db;
}

export function getStoreStats(db: DatabaseShape = ensureDb()) {
  return {
    jobs: db.jobs.length,
    competitors: db.competitors.length,
    lookupJobs: db.lookupJobs?.length ?? 0,
    lookupAds: db.lookupAds?.length ?? 0,
    searchCompetitorAds: db.searchCompetitorAds?.length ?? 0,
    seenPageIds: db.seenPageIds.length,
  };
}

/** Replace the entire JSON store (used for local → production history import). */
export function replaceStore(payload: Partial<DatabaseShape>): {
  before: ReturnType<typeof getStoreStats>;
  after: ReturnType<typeof getStoreStats>;
} {
  const before = getStoreStats();
  const next = normalizeDb(payload);
  writeDb(next);
  return { before, after: getStoreStats(next) };
}

/**
 * Merge local history into the existing store by id (keeps production-only rows).
 * Incoming records win on id conflicts.
 */
export function mergeStore(payload: Partial<DatabaseShape>): {
  before: ReturnType<typeof getStoreStats>;
  after: ReturnType<typeof getStoreStats>;
} {
  const before = getStoreStats();
  const current = ensureDb();
  const incoming = normalizeDb(payload);

  const byId = <T extends { id: string }>(existing: T[], next: T[]) => {
    const map = new Map<string, T>();
    for (const row of existing) map.set(row.id, row);
    for (const row of next) map.set(row.id, row);
    return Array.from(map.values());
  };

  const merged: DatabaseShape = {
    ...current,
    jobs: byId(current.jobs, incoming.jobs),
    competitors: byId(current.competitors, incoming.competitors),
    seenPageIds: Array.from(
      new Set([...(current.seenPageIds || []), ...(incoming.seenPageIds || [])]),
    ),
    lookupJobs: byId(current.lookupJobs ?? [], incoming.lookupJobs ?? []),
    lookupAds: byId(current.lookupAds ?? [], incoming.lookupAds ?? []),
    searchCompetitorAds: byId(
      current.searchCompetitorAds ?? [],
      incoming.searchCompetitorAds ?? [],
    ),
  };

  // Newest-first ordering for history UIs
  merged.jobs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  merged.competitors.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
  merged.lookupJobs!.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
  merged.lookupAds!.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );
  merged.searchCompetitorAds!.sort((a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || ""),
  );

  writeDb(merged);
  return { before, after: getStoreStats(merged) };
}

export function getSeenPageIds(): Set<string> {
  return new Set(ensureDb().seenPageIds);
}

export function markPageSeen(pageId: string) {
  const db = ensureDb();
  if (!db.seenPageIds.includes(pageId)) {
    db.seenPageIds.push(pageId);
    writeDb(db);
  }
}

/** Persist a search job. Returns false if the run was deleted and must not resurrect. */
export function saveJob(job: SearchJob): boolean {
  return withDbLock(() => {
    const db = ensureDb();
    const idx = db.jobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      const existing = db.jobs[idx];
      if (suppressedSearchJobIds.has(job.id) || existing.progress?.stopRequested) {
        suppressedSearchJobIds.add(job.id);
        return false;
      }
      // Preserve competitorIds if a concurrent saveCompetitor already wrote them
      const mergedIds = Array.from(
        new Set([...(existing.competitorIds || []), ...(job.competitorIds || [])]),
      );
      db.jobs[idx] = {
        ...job,
        competitorIds: mergedIds,
        // The API route stamps ownership before dispatching the pipeline; the
        // pipeline's own writes don't carry it and must not erase it.
        ownerUserId:
          job.ownerUserId !== undefined ? job.ownerUserId : existing.ownerUserId,
        spaceId: job.spaceId !== undefined ? job.spaceId : existing.spaceId,
        archivedAt: job.archivedAt !== undefined ? job.archivedAt : existing.archivedAt,
      };
    } else {
      if (suppressedSearchJobIds.has(job.id)) return false;
      db.jobs.unshift(job);
    }
    writeDb(db);
    return true;
  });
}

export function getJob(id: string): SearchJob | null {
  return ensureDb().jobs.find((j) => j.id === id) ?? null;
}

export function updateJob(
  id: string,
  patch: Partial<SearchJob>,
): SearchJob | null {
  return withDbLock(() => {
    const db = ensureDb();
    const idx = db.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    const existing = db.jobs[idx];
    if (suppressedSearchJobIds.has(id) || existing.progress?.stopRequested) {
      suppressedSearchJobIds.add(id);
      return null;
    }
    db.jobs[idx] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeDb(db);
    return db.jobs[idx];
  });
}

export function listJobs(limit = 100): SearchJob[] {
  return ensureDb().jobs.slice(0, limit);
}

export function listHistoryRuns(limit = 100): HistoryRunSummary[] {
  const db = ensureDb();
  return db.jobs.slice(0, limit).map((job) => {
    const fromIds = job.competitorIds?.length ?? 0;
    const fromFilter = db.competitors.filter((c) => c.runId === job.id).length;
    return {
      ...job,
      competitorCount: Math.max(fromIds, fromFilter),
    };
  });
}

export function saveCompetitor(competitor: CompetitorRecord): boolean {
  if (suppressedSearchJobIds.has(competitor.runId)) return false;
  const db = ensureDb();
  // Don't orphan competitors onto a deleted / missing run
  if (!db.jobs.some((j) => j.id === competitor.runId)) return false;
  db.competitors.unshift(competitor);
  if (!db.seenPageIds.includes(competitor.pageId)) {
    db.seenPageIds.push(competitor.pageId);
  }
  const job = db.jobs.find((j) => j.id === competitor.runId);
  if (job && !job.competitorIds.includes(competitor.id)) {
    job.competitorIds.push(competitor.id);
    job.updatedAt = new Date().toISOString();
  }
  writeDb(db);
  return true;
}

export function getCompetitorsByRun(runId: string): CompetitorRecord[] {
  return ensureDb().competitors.filter((c) => c.runId === runId);
}

export function getCompetitor(id: string): CompetitorRecord | null {
  return ensureDb().competitors.find((c) => c.id === id) ?? null;
}

export function updateCompetitor(
  id: string,
  patch: Partial<CompetitorRecord>,
): CompetitorRecord | null {
  const db = ensureDb();
  const idx = db.competitors.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  db.competitors[idx] = { ...db.competitors[idx], ...patch };
  writeDb(db);
  return db.competitors[idx];
}

export function listAllCompetitors(limit = 100): CompetitorRecord[] {
  return ensureDb().competitors.slice(0, limit);
}

/**
 * Delete a run and its competitors. Also frees their pageIds from the
 * global dedup list so the same competitors can be rediscovered later
 * (unless another remaining run still references that pageId).
 */
export function deleteHistoryRun(runId: string): {
  ok: boolean;
  removedCompetitors: number;
} {
  // Tombstone first so an in-flight pipeline cannot recreate the row
  suppressedSearchJobIds.add(runId);
  const db = ensureDb();
  const jobIdx = db.jobs.findIndex((j) => j.id === runId);
  if (jobIdx < 0) {
    // Still ok — job may have been deleted already while pipeline kept running
    return { ok: true, removedCompetitors: 0 };
  }

  const removed = db.competitors.filter((c) => c.runId === runId);
  const removedPageIds = new Set(removed.map((c) => c.pageId));

  db.competitors = db.competitors.filter((c) => c.runId !== runId);
  if (db.searchCompetitorAds) {
    db.searchCompetitorAds = db.searchCompetitorAds.filter((a) => a.runId !== runId);
  }
  db.jobs.splice(jobIdx, 1);

  // Only un-see a pageId if no other stored competitor still uses it
  const stillUsed = new Set(
    db.competitors.map((c) => c.pageId).filter(Boolean),
  );
  db.seenPageIds = db.seenPageIds.filter(
    (id) => !removedPageIds.has(id) || stillUsed.has(id),
  );

  writeDb(db);
  return { ok: true, removedCompetitors: removed.length };
}

/** Delete every run + competitor + clear seen page ids */
export function clearAllHistory(): { removedRuns: number; removedCompetitors: number } {
  const db = ensureDb();
  for (const job of db.jobs) suppressedSearchJobIds.add(job.id);
  const removedRuns = db.jobs.length;
  const removedCompetitors = db.competitors.length;
  db.jobs = [];
  db.competitors = [];
  db.searchCompetitorAds = [];
  db.seenPageIds = [];
  writeDb(db);
  return { removedRuns, removedCompetitors };
}

/* ── Competitor name lookup (separate from keyword search history) ── */

export function saveLookupJob(job: LookupJob): boolean {
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupJobs) db.lookupJobs = [];
    const idx = db.lookupJobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      const existing = db.lookupJobs[idx];
      // Refuse to revive a stopped run (in-memory Set alone is not cross-bundle safe).
      if (suppressedLookupJobIds.has(job.id) || existing.progress?.stopRequested) {
        suppressedLookupJobIds.add(job.id);
        return false;
      }
      const mergedIds = Array.from(
        new Set([...(existing.adIds || []), ...(job.adIds || [])]),
      );
      db.lookupJobs[idx] = {
        ...job,
        adIds: mergedIds,
        // See saveJob(): ownership is stamped by the route, not the pipeline.
        ownerUserId:
          job.ownerUserId !== undefined ? job.ownerUserId : existing.ownerUserId,
        spaceId: job.spaceId !== undefined ? job.spaceId : existing.spaceId,
        archivedAt:
          job.archivedAt !== undefined ? job.archivedAt : existing.archivedAt,
      };
    } else {
      if (suppressedLookupJobIds.has(job.id) || job.progress?.stopRequested) {
        suppressedLookupJobIds.add(job.id);
        return false;
      }
      db.lookupJobs.unshift(job);
    }
    writeDb(db);
    return true;
  });
}

export function getLookupJob(id: string): LookupJob | null {
  return ensureDb().lookupJobs?.find((j) => j.id === id) ?? null;
}

export function updateLookupJob(
  id: string,
  patch: Partial<LookupJob>,
): LookupJob | null {
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupJobs) db.lookupJobs = [];
    const idx = db.lookupJobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    const existing = db.lookupJobs[idx];
    if (suppressedLookupJobIds.has(id) || existing.progress?.stopRequested) {
      suppressedLookupJobIds.add(id);
      return null;
    }
    db.lookupJobs[idx] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    writeDb(db);
    return db.lookupJobs[idx];
  });
}

export function listLookupHistory(limit = 100): LookupHistorySummary[] {
  const db = ensureDb();
  const jobs = db.lookupJobs ?? [];
  const ads = db.lookupAds ?? [];
  return jobs
    .filter((j) => !j.internalOnly)
    .slice(0, limit)
    .map((job) => {
    const fromIds = job.adIds?.length ?? 0;
    const fromFilter = ads.filter((a) => a.lookupId === job.id).length;
    return {
      ...job,
      adCount: Math.max(fromIds, fromFilter),
    };
    });
}

export function saveLookupAd(ad: LookupAdRecord): boolean {
  return saveLookupAds([ad]);
}

export function saveLookupAds(ads: LookupAdRecord[]): boolean {
  if (!ads.length) return true;
  const lookupId = ads[0].lookupId;
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupAds) db.lookupAds = [];
    if (!db.lookupJobs) db.lookupJobs = [];
    const job = db.lookupJobs.find((j) => j.id === lookupId);
    if (!job) return false;
    if (suppressedLookupJobIds.has(lookupId) || job.progress?.stopRequested) {
      suppressedLookupJobIds.add(lookupId);
      return false;
    }
    for (const ad of ads) {
      const existing = db.lookupAds.findIndex((a) => a.id === ad.id);
      if (existing >= 0) db.lookupAds[existing] = ad;
      else db.lookupAds.unshift(ad);
      if (!job.adIds.includes(ad.id)) job.adIds.push(ad.id);
    }
    job.updatedAt = new Date().toISOString();
    writeDb(db);
    return true;
  });
}

export function getLookupAd(adId: string): LookupAdRecord | null {
  return (ensureDb().lookupAds ?? []).find((a) => a.id === adId) ?? null;
}

export function updateLookupAd(
  adId: string,
  patch: Partial<LookupAdRecord>,
): LookupAdRecord | null {
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupAds) db.lookupAds = [];
    const idx = db.lookupAds.findIndex((a) => a.id === adId);
    if (idx < 0) return null;
    const prev = db.lookupAds[idx];
    let next = { ...prev, ...patch };
    // Never let a stale "pending" clobber a completed/failed analysis
    if (
      patch.pageAnalysis?.status === "pending" &&
      (prev.pageAnalysis?.status === "completed" ||
        prev.pageAnalysis?.status === "failed") &&
      prev.pageAnalysis.offer
    ) {
      // Allow intentional refresh only when previous error/offer will be replaced
      // by a later completed write; pending marker is fine for UX mid-flight.
      next = {
        ...next,
        pageAnalysis: {
          ...patch.pageAnalysis,
          // Keep last good offer visible while refreshing
          offer: prev.pageAnalysis.offer,
          pageArchitecture: prev.pageAnalysis.pageArchitecture,
          summary: prev.pageAnalysis.summary,
        },
      };
    }
    db.lookupAds[idx] = next;
    const job = db.lookupJobs?.find((j) => j.id === db.lookupAds![idx].lookupId);
    if (job) job.updatedAt = new Date().toISOString();
    writeDb(db);
    return db.lookupAds[idx];
  });
}

export function getLookupAds(lookupId: string): LookupAdRecord[] {
  return (ensureDb().lookupAds ?? []).filter((a) => a.lookupId === lookupId);
}

export function deleteLookupHistoryRun(lookupId: string): {
  ok: boolean;
  removedAds: number;
} {
  suppressedLookupJobIds.add(lookupId);
  const db = ensureDb();
  if (!db.lookupJobs) db.lookupJobs = [];
  if (!db.lookupAds) db.lookupAds = [];
  const idx = db.lookupJobs.findIndex((j) => j.id === lookupId);
  if (idx < 0) return { ok: true, removedAds: 0 };
  const before = db.lookupAds.length;
  db.lookupAds = db.lookupAds.filter((a) => a.lookupId !== lookupId);
  db.lookupJobs.splice(idx, 1);
  writeDb(db);
  return { ok: true, removedAds: before - db.lookupAds.length };
}

export function clearAllLookupHistory(): {
  removedRuns: number;
  removedAds: number;
} {
  const db = ensureDb();
  for (const job of db.lookupJobs ?? []) suppressedLookupJobIds.add(job.id);
  const removedRuns = db.lookupJobs?.length ?? 0;
  const removedAds = db.lookupAds?.length ?? 0;
  db.lookupJobs = [];
  db.lookupAds = [];
  writeDb(db);
  return { removedRuns, removedAds };
}

export function saveSearchCompetitorAd(ad: SearchCompetitorAdRecord): boolean {
  return saveSearchCompetitorAds([ad]);
}

/** Replace cached ads for one competitor in a single store write. */
export function saveSearchCompetitorAds(
  ads: SearchCompetitorAdRecord[],
  options?: { replaceCompetitorId?: string; runId?: string },
): boolean {
  if (!ads.length && !options?.replaceCompetitorId) return true;
  const runId = options?.runId || ads[0]?.runId;
  if (!runId || suppressedSearchJobIds.has(runId)) return false;
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.searchCompetitorAds) db.searchCompetitorAds = [];
    if (!db.jobs.some((j) => j.id === runId)) return false;
    if (options?.replaceCompetitorId) {
      db.searchCompetitorAds = db.searchCompetitorAds.filter(
        (a) =>
          !(a.runId === runId && a.competitorId === options.replaceCompetitorId),
      );
    }
    for (const ad of ads) {
      const idx = db.searchCompetitorAds.findIndex((a) => a.id === ad.id);
      if (idx >= 0) db.searchCompetitorAds[idx] = ad;
      else db.searchCompetitorAds.unshift(ad);
    }
    writeDb(db);
    return true;
  });
}

export function getSearchCompetitorAdsByRun(runId: string): SearchCompetitorAdRecord[] {
  return (ensureDb().searchCompetitorAds ?? []).filter((a) => a.runId === runId);
}

export function getSearchCompetitorAdsByCompetitor(
  runId: string,
  competitorId: string,
): SearchCompetitorAdRecord[] {
  return (ensureDb().searchCompetitorAds ?? []).filter(
    (a) => a.runId === runId && a.competitorId === competitorId,
  );
}

/* ───────────────────────────────── Users ────────────────────────────────── */

export function listUsers(options?: { includeDeleted?: boolean }): AppUser[] {
  const all = [...(readDb().users ?? [])];
  return options?.includeDeleted
    ? all
    : all.filter((u) => u.status !== "deleted");
}

export function getUserById(id: string): AppUser | null {
  return (readDb().users ?? []).find((u) => u.id === id) || null;
}

export function getUserByUsername(username: string): AppUser | null {
  const key = username.trim().toLowerCase();
  return (readDb().users ?? []).find((u) => u.username === key) || null;
}

export function countActiveAdmins(): number {
  return (readDb().users ?? []).filter(
    (u) => u.role === "admin" && u.status === "active",
  ).length;
}

export function createUser(input: {
  username: string;
  displayName: string;
  passwordHash: string;
  role?: UserRole;
  status?: UserStatus;
  mustChangePassword?: boolean;
  createdByUserId?: string | null;
}): AppUser {
  return transaction((db) => {
    if (!db.users) db.users = [];
    const username = input.username.trim().toLowerCase();
    if (db.users.some((u) => u.username === username)) {
      throw new Error("Username already taken");
    }
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
    };
    db.users.unshift(user);
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
  >
> & {
  /** Invalidates every existing session for this user. */
  bumpSessionEpoch?: boolean;
};

export function updateUser(id: string, patch: UserPatch): AppUser | null {
  return transaction((db) => {
    if (!db.users) db.users = [];
    const idx = db.users.findIndex((u) => u.id === id);
    if (idx < 0) return null;
    const prev = db.users[idx];
    const { bumpSessionEpoch, ...fields } = patch;
    db.users[idx] = {
      ...prev,
      ...fields,
      displayName:
        fields.displayName !== undefined
          ? fields.displayName.trim()
          : prev.displayName,
      sessionEpoch: bumpSessionEpoch ? prev.sessionEpoch + 1 : prev.sessionEpoch,
      updatedAt: new Date().toISOString(),
    };
    return db.users[idx];
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
  };
}

/* ────────────────────────────── App settings ────────────────────────────── */

export function getAppSettings(): AppSettings {
  return readDb().appSettings ?? defaultAppSettings();
}

export function updateAppSettings(
  patch: Partial<AppSettings>,
  actorUserId: string | null,
): AppSettings {
  return transaction((db) => {
    const next: AppSettings = {
      ...(db.appSettings ?? defaultAppSettings()),
      ...patch,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actorUserId,
    };
    db.appSettings = next;
    return next;
  });
}

/* ──────────────────────── Project ownership helpers ─────────────────────── */

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

function describeProject(
  kind: ProjectKind,
  row: SearchJob | LookupJob,
): ProjectOwnership {
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

export function getProject(
  kind: ProjectKind,
  id: string,
): ProjectOwnership | null {
  const db = readDb();
  if (kind === "search") {
    const row = db.jobs.find((j) => j.id === id);
    return row ? describeProject("search", row) : null;
  }
  const row = (db.lookupJobs ?? []).find((j) => j.id === id);
  return row ? describeProject("lookup", row) : null;
}

export function listProjects(options?: {
  ownerUserId?: string;
  unassignedOnly?: boolean;
}): ProjectOwnership[] {
  const db = readDb();
  const rows: ProjectOwnership[] = [
    ...db.jobs.map((j) => describeProject("search", j)),
    ...(db.lookupJobs ?? [])
      .filter((j) => !j.internalOnly)
      .map((j) => describeProject("lookup", j)),
  ];
  const filtered = options?.unassignedOnly
    ? rows.filter((r) => !r.ownerUserId)
    : options?.ownerUserId
      ? rows.filter((r) => r.ownerUserId === options.ownerUserId)
      : rows;
  return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function setProjectOwner(
  kind: ProjectKind,
  id: string,
  ownerUserId: string | null,
): boolean {
  return transaction((db) => {
    const rows: Array<SearchJob | LookupJob> =
      kind === "search" ? db.jobs : (db.lookupJobs ?? []);
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    row.ownerUserId = ownerUserId;
    row.updatedAt = new Date().toISOString();
    return true;
  });
}

export function setProjectArchived(
  kind: ProjectKind,
  id: string,
  archived: boolean,
): boolean {
  return transaction((db) => {
    const rows: Array<SearchJob | LookupJob> =
      kind === "search" ? db.jobs : (db.lookupJobs ?? []);
    const row = rows.find((r) => r.id === id);
    if (!row) return false;
    row.archivedAt = archived ? new Date().toISOString() : null;
    row.updatedAt = new Date().toISOString();
    return true;
  });
}

export function listProjectSpaces(options?: {
  ownerUserId?: string;
  includeArchived?: boolean;
}): ProjectSpace[] {
  return (readDb().projectSpaces ?? [])
    .filter((space) => {
      if (!options?.includeArchived && space.archivedAt) return false;
      if (options?.ownerUserId && space.ownerUserId !== options.ownerUserId) {
        return false;
      }
      return true;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getProjectSpace(id: string): ProjectSpace | null {
  return (readDb().projectSpaces ?? []).find((space) => space.id === id) ?? null;
}

export function createProjectSpace(input: {
  clientName: string;
  ownerUserId: string;
}): ProjectSpace {
  return transaction((db) => {
    if (!db.projectSpaces) db.projectSpaces = [];
    const now = new Date().toISOString();
    const space: ProjectSpace = {
      id: crypto.randomUUID(),
      clientName: input.clientName.trim(),
      ownerUserId: input.ownerUserId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    db.projectSpaces.unshift(space);
    return space;
  });
}

export function setProjectSpaceOwner(spaceId: string, ownerUserId: string): boolean {
  return transaction((db) => {
    const space = (db.projectSpaces ?? []).find((s) => s.id === spaceId);
    if (!space) return false;
    space.ownerUserId = ownerUserId;
    space.updatedAt = new Date().toISOString();
    return true;
  });
}

export function archiveProjectSpace(spaceId: string): {
  ok: boolean;
  runsArchived: number;
} {
  return transaction((db) => {
    const space = (db.projectSpaces ?? []).find((s) => s.id === spaceId);
    if (!space) return { ok: false, runsArchived: 0 };
    const now = new Date().toISOString();
    space.archivedAt = now;
    space.updatedAt = now;
    let runsArchived = 0;
    for (const job of db.jobs) {
      if (job.spaceId === spaceId && !job.archivedAt) {
        job.archivedAt = now;
        job.updatedAt = now;
        runsArchived += 1;
      }
    }
    for (const job of db.lookupJobs ?? []) {
      if (job.spaceId === spaceId && !job.archivedAt) {
        job.archivedAt = now;
        job.updatedAt = now;
        runsArchived += 1;
      }
    }
    return { ok: true, runsArchived };
  });
}

export function assignRunsToSpace(
  spaceId: string,
  runs: Array<{ kind: ProjectKind; id: string }>,
): number {
  return transaction((db) => {
    const space = (db.projectSpaces ?? []).find((s) => s.id === spaceId);
    if (!space || space.archivedAt) return 0;
    const now = new Date().toISOString();
    let moved = 0;
    for (const run of runs) {
      const rows = run.kind === "search" ? db.jobs : (db.lookupJobs ?? []);
      const row = rows.find((r) => r.id === run.id);
      if (!row) continue;
      row.spaceId = spaceId;
      if (!row.ownerUserId) row.ownerUserId = space.ownerUserId;
      row.updatedAt = now;
      moved += 1;
    }
    space.updatedAt = now;
    return moved;
  });
}

export function listSpaceMemberships(spaceId?: string): SpaceMembership[] {
  return (readDb().spaceMemberships ?? []).filter(
    (m) => !spaceId || m.spaceId === spaceId,
  );
}

export function upsertSpaceMembership(input: {
  spaceId: string;
  userId: string;
  role: "editor" | "viewer";
  grantedByUserId: string;
}): SpaceMembership {
  return transaction((db) => {
    if (!db.spaceMemberships) db.spaceMemberships = [];
    const now = new Date().toISOString();
    const existing = db.spaceMemberships.find(
      (m) => m.spaceId === input.spaceId && m.userId === input.userId,
    );
    if (existing) {
      existing.role = input.role;
      existing.updatedAt = now;
      return existing;
    }
    const created: SpaceMembership = {
      id: crypto.randomUUID(),
      spaceId: input.spaceId,
      userId: input.userId,
      role: input.role,
      grantedByUserId: input.grantedByUserId,
      createdAt: now,
      updatedAt: now,
    };
    db.spaceMemberships.push(created);
    return created;
  });
}

export function removeSpaceMembership(spaceId: string, userId: string): boolean {
  return transaction((db) => {
    if (!db.spaceMemberships) return false;
    const before = db.spaceMemberships.length;
    db.spaceMemberships = db.spaceMemberships.filter(
      (m) => !(m.spaceId === spaceId && m.userId === userId),
    );
    return db.spaceMemberships.length < before;
  });
}

const PROVIDER_ALERT_DEDUPE_MS = 15 * 60 * 1000;

/** Record that a provider account is out of credits. Deduped per user+provider. */
export function recordProviderCreditAlert(input: {
  userId: string;
  username: string;
  displayName: string;
  provider: AdminAlert["provider"];
  runId: string | null;
}): void {
  transaction((db) => {
    if (!db.adminAlerts) db.adminAlerts = [];
    const cutoff = Date.now() - PROVIDER_ALERT_DEDUPE_MS;
    const duplicate = db.adminAlerts.some(
      (alert) =>
        alert.kind === "provider_credits_exhausted" &&
        alert.userId === input.userId &&
        alert.provider === input.provider &&
        new Date(alert.createdAt).getTime() >= cutoff,
    );
    if (duplicate) return;
    db.adminAlerts.push({
      id: crypto.randomUUID(),
      kind: "provider_credits_exhausted",
      userId: input.userId,
      username: input.username,
      displayName: input.displayName,
      provider: input.provider,
      runId: input.runId,
      createdAt: new Date().toISOString(),
    });
    if (db.adminAlerts.length > 300) {
      db.adminAlerts = db.adminAlerts.slice(-300);
    }
  });
}

export function listAdminAlerts(): AdminAlert[] {
  return [...(readDb().adminAlerts ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

