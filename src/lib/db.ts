import fs from "fs";
import path from "path";
import type {
  CompetitorRecord,
  DatabaseShape,
  HistoryRunSummary,
  LookupAdRecord,
  LookupHistorySummary,
  LookupJob,
  SearchJob,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "store.json");

function emptyDb(): DatabaseShape {
  return {
    jobs: [],
    competitors: [],
    seenPageIds: [],
    lookupJobs: [],
    lookupAds: [],
  };
}

function ensureDb(): DatabaseShape {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
    return db;
  }
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as DatabaseShape;
    if (!parsed.lookupJobs) parsed.lookupJobs = [];
    if (!parsed.lookupAds) parsed.lookupAds = [];
    if (!parsed.jobs) parsed.jobs = [];
    if (!parsed.competitors) parsed.competitors = [];
    if (!parsed.seenPageIds) parsed.seenPageIds = [];
    return parsed;
  } catch {
    return emptyDb();
  }
}

function writeDb(db: DatabaseShape) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

function normalizeDb(input: Partial<DatabaseShape> | null | undefined): DatabaseShape {
  const db = emptyDb();
  if (!input || typeof input !== "object") return db;
  if (Array.isArray(input.jobs)) db.jobs = input.jobs;
  if (Array.isArray(input.competitors)) db.competitors = input.competitors;
  if (Array.isArray(input.seenPageIds)) db.seenPageIds = input.seenPageIds;
  if (Array.isArray(input.lookupJobs)) db.lookupJobs = input.lookupJobs;
  if (Array.isArray(input.lookupAds)) db.lookupAds = input.lookupAds;
  return db;
}

export function getStoreStats(db: DatabaseShape = ensureDb()) {
  return {
    jobs: db.jobs.length,
    competitors: db.competitors.length,
    lookupJobs: db.lookupJobs?.length ?? 0,
    lookupAds: db.lookupAds?.length ?? 0,
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

export function saveJob(job: SearchJob) {
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
}

export function getJob(id: string): SearchJob | null {
  return ensureDb().jobs.find((j) => j.id === id) ?? null;
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

export function saveCompetitor(competitor: CompetitorRecord) {
  const db = ensureDb();
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
}

export function getCompetitorsByRun(runId: string): CompetitorRecord[] {
  return ensureDb().competitors.filter((c) => c.runId === runId);
}

export function getCompetitor(id: string): CompetitorRecord | null {
  return ensureDb().competitors.find((c) => c.id === id) ?? null;
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
  const db = ensureDb();
  const jobIdx = db.jobs.findIndex((j) => j.id === runId);
  if (jobIdx < 0) return { ok: false, removedCompetitors: 0 };

  const removed = db.competitors.filter((c) => c.runId === runId);
  const removedPageIds = new Set(removed.map((c) => c.pageId));

  db.competitors = db.competitors.filter((c) => c.runId !== runId);
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
  const removedRuns = db.jobs.length;
  const removedCompetitors = db.competitors.length;
  db.jobs = [];
  db.competitors = [];
  db.seenPageIds = [];
  writeDb(db);
  return { removedRuns, removedCompetitors };
}

/* ── Competitor name lookup (separate from keyword search history) ── */

export function saveLookupJob(job: LookupJob) {
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
}

export function getLookupJob(id: string): LookupJob | null {
  return ensureDb().lookupJobs?.find((j) => j.id === id) ?? null;
}

export function listLookupHistory(limit = 100): LookupHistorySummary[] {
  const db = ensureDb();
  const jobs = db.lookupJobs ?? [];
  const ads = db.lookupAds ?? [];
  return jobs.slice(0, limit).map((job) => {
    const fromIds = job.adIds?.length ?? 0;
    const fromFilter = ads.filter((a) => a.lookupId === job.id).length;
    return {
      ...job,
      adCount: Math.max(fromIds, fromFilter),
    };
  });
}

export function saveLookupAd(ad: LookupAdRecord) {
  const db = ensureDb();
  if (!db.lookupAds) db.lookupAds = [];
  if (!db.lookupJobs) db.lookupJobs = [];
  db.lookupAds.unshift(ad);
  const job = db.lookupJobs.find((j) => j.id === ad.lookupId);
  if (job && !job.adIds.includes(ad.id)) {
    job.adIds.push(ad.id);
    job.updatedAt = new Date().toISOString();
  }
  writeDb(db);
}

export function getLookupAds(lookupId: string): LookupAdRecord[] {
  return (ensureDb().lookupAds ?? []).filter((a) => a.lookupId === lookupId);
}

export function deleteLookupHistoryRun(lookupId: string): {
  ok: boolean;
  removedAds: number;
} {
  const db = ensureDb();
  if (!db.lookupJobs) db.lookupJobs = [];
  if (!db.lookupAds) db.lookupAds = [];
  const idx = db.lookupJobs.findIndex((j) => j.id === lookupId);
  if (idx < 0) return { ok: false, removedAds: 0 };
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
  const removedRuns = db.lookupJobs?.length ?? 0;
  const removedAds = db.lookupAds?.length ?? 0;
  db.lookupJobs = [];
  db.lookupAds = [];
  writeDb(db);
  return { removedRuns, removedAds };
}
