import fs from "fs";
import path from "path";
import type {
  CompetitorRecord,
  DatabaseShape,
  HistoryRunSummary,
  LookupAdRecord,
  SearchCompetitorAdRecord,
  LookupHistorySummary,
  LookupJob,
  SearchJob,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "store.json");
const DB_LOCK_PATH = path.join(DATA_DIR, "store.json.lock");

/** In-process cache so status polls don't re-parse a multi-MB store on every request. */
let memoryDb: DatabaseShape | null = null;

/**
 * Tombstones for runs deleted while a pipeline is still in-flight.
 * Without this, saveJob() re-creates the deleted row on the next progress tick.
 */
const suppressedSearchJobIds = new Set<string>();
const suppressedLookupJobIds = new Set<string>();

/** Cross-request / multi-process lock for read-modify-write of store.json */
function withDbLock<T>(fn: () => T): T {
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
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(DB_LOCK_PATH);
    } catch {
      /* ignore */
    }
  }
}

export function isSearchJobSuppressed(jobId: string): boolean {
  return suppressedSearchJobIds.has(jobId);
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
  return suppressedLookupJobIds.has(lookupId);
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
  if (suppressedSearchJobIds.has(job.id)) return false;
  return (
    job.status === "running" ||
    SEARCH_IN_FLIGHT_STAGES.has(job.progress?.stage || "")
  );
}

export function isLookupWorkInFlight(job: LookupJob): boolean {
  if (suppressedLookupJobIds.has(job.id)) return false;
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

function emptyDb(): DatabaseShape {
  return {
    jobs: [],
    competitors: [],
    seenPageIds: [],
    lookupJobs: [],
    lookupAds: [],
    searchCompetitorAds: [],
  };
}

function hydrateDb(parsed: DatabaseShape): DatabaseShape {
  if (!parsed.lookupJobs) parsed.lookupJobs = [];
  if (!parsed.lookupAds) parsed.lookupAds = [];
  if (!parsed.jobs) parsed.jobs = [];
  if (!parsed.competitors) parsed.competitors = [];
  if (!parsed.seenPageIds) parsed.seenPageIds = [];
  if (!parsed.searchCompetitorAds) parsed.searchCompetitorAds = [];
  return parsed;
}

function ensureDb(): DatabaseShape {
  if (memoryDb) return memoryDb;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    memoryDb = db;
    fs.writeFileSync(DB_PATH, JSON.stringify(db), "utf8");
    return db;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    memoryDb = hydrateDb(JSON.parse(raw) as DatabaseShape);
    return memoryDb;
  } catch {
    memoryDb = emptyDb();
    return memoryDb;
  }
}

function writeDb(db: DatabaseShape) {
  memoryDb = db;
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db), "utf8");
}

function normalizeDb(input: Partial<DatabaseShape> | null | undefined): DatabaseShape {
  const db = emptyDb();
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
  if (suppressedSearchJobIds.has(job.id)) return false;
  const db = ensureDb();
  const idx = db.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) {
    // Preserve competitorIds if a concurrent saveCompetitor already wrote them
    const existing = db.jobs[idx];
    const mergedIds = Array.from(
      new Set([...(existing.competitorIds || []), ...(job.competitorIds || [])]),
    );
    db.jobs[idx] = { ...job, competitorIds: mergedIds };
  } else {
    db.jobs.unshift(job);
  }
  writeDb(db);
  return true;
}

export function getJob(id: string): SearchJob | null {
  return ensureDb().jobs.find((j) => j.id === id) ?? null;
}

export function updateJob(
  id: string,
  patch: Partial<SearchJob>,
): SearchJob | null {
  if (suppressedSearchJobIds.has(id)) return null;
  const db = ensureDb();
  const idx = db.jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  db.jobs[idx] = {
    ...db.jobs[idx],
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
  return db.jobs[idx];
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
  if (suppressedLookupJobIds.has(job.id)) return false;
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupJobs) db.lookupJobs = [];
    const idx = db.lookupJobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      const existing = db.lookupJobs[idx];
      const mergedIds = Array.from(
        new Set([...(existing.adIds || []), ...(job.adIds || [])]),
      );
      db.lookupJobs[idx] = { ...job, adIds: mergedIds };
    } else {
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
  if (suppressedLookupJobIds.has(id)) return null;
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupJobs) db.lookupJobs = [];
    const idx = db.lookupJobs.findIndex((j) => j.id === id);
    if (idx < 0) return null;
    db.lookupJobs[idx] = {
      ...db.lookupJobs[idx],
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
  if (suppressedLookupJobIds.has(lookupId)) return false;
  return withDbLock(() => {
    const db = ensureDb();
    if (!db.lookupAds) db.lookupAds = [];
    if (!db.lookupJobs) db.lookupJobs = [];
    if (!db.lookupJobs.some((j) => j.id === lookupId)) return false;
    const job = db.lookupJobs.find((j) => j.id === lookupId);
    for (const ad of ads) {
      const existing = db.lookupAds.findIndex((a) => a.id === ad.id);
      if (existing >= 0) db.lookupAds[existing] = ad;
      else db.lookupAds.unshift(ad);
      if (job && !job.adIds.includes(ad.id)) job.adIds.push(ad.id);
    }
    if (job) job.updatedAt = new Date().toISOString();
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
