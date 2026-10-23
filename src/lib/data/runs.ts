import type {
  HistoryRunSummary,
  LookupHistorySummary,
  LookupJob,
  LookupOffersReport,
  SearchJob,
} from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { MAX_DELETED_RUN_IDS } from "./legacyStore";

/*
 * Search runs (`jobs`) and competitor lookups (`lookup_jobs`), ported from the
 * file store in db.ts. Each row keeps the whole record in `data`; the other
 * columns are copies kept in sync here.
 *
 * Deletion and stop are durable: a deleted run leaves its id in
 * `deleted_run_ids`, a stopped run has `progress.stopRequested`. Every write
 * checks both inside the same transaction as the upsert, under a per-run
 * advisory lock, so a pipeline still running cannot write a deleted or
 * stopped run back. The suppressed-id sets and progress throttle below are
 * per process, which is correct for the single instance this app runs.
 */

/* ── in-process state ── */

/**
 * Tombstones for runs deleted or stopped while a pipeline is still in flight.
 * A fast path only: the durable truth is in the database.
 */
const suppressedSearchJobIds = new Set<string>();
const suppressedLookupJobIds = new Set<string>();

/**
 * Writes to one run go out one at a time, in call order. With the file store
 * each write finished before the next began; over a pool two writes for the
 * same run could commit out of order and an older snapshot could land last.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const run = previous.then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(key, tail);
  void tail.then(() => {
    if (writeChains.get(key) === tail) writeChains.delete(key);
  });
  return run;
}

/* ── shared SQL helpers ── */

type RunTable = "jobs" | "lookup_jobs";

/** Serializes every transaction that writes this run (search or lookup id). */
export async function lockRunId(tx: Queryable, id: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`run:${id}`]);
}

/** Locks several run ids in one fixed order, so two callers cannot deadlock. */
async function lockRunIds(tx: Queryable, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await lockRunId(tx, id);
}

async function runWasDeleted(q: Queryable, id: string): Promise<boolean> {
  if (!id) return false;
  const { rows } = await q.query<{ found: number }>(
    "select 1 as found from deleted_run_ids where id = $1",
    [id],
  );
  return rows.length > 0;
}

/** Remember deleted run ids (in order), keeping the newest MAX_DELETED_RUN_IDS. */
async function rememberDeletedRuns(tx: Queryable, ids: string[]): Promise<void> {
  const wanted = ids.filter(Boolean);
  if (!wanted.length) return;
  await tx.query(
    `insert into deleted_run_ids (id, created_at)
     select t.id, clock_timestamp()
       from unnest($1::text[]) with ordinality as t(id, n)
      order by t.n
     on conflict (id) do nothing`,
    [wanted],
  );
  await tx.query(
    `delete from deleted_run_ids
      where id in (select id from deleted_run_ids order by created_at desc, id desc offset $1)`,
    [MAX_DELETED_RUN_IDS],
  );
}

/** The record's ISO time, or null when it is missing or unparsable. */
function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

async function upsertRun(tx: Queryable, table: RunTable, row: SearchJob | LookupJob): Promise<void> {
  await tx.query(
    `insert into ${table} (id, owner_user_id, space_id, status, created_at, data)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now()), $6::jsonb)
     on conflict (id) do update set
       owner_user_id = excluded.owner_user_id,
       space_id      = excluded.space_id,
       status        = excluded.status,
       created_at    = excluded.created_at,
       data          = excluded.data`,
    [
      row.id,
      row.ownerUserId ?? null,
      row.spaceId ?? null,
      row.status,
      isoOrNull(row.createdAt),
      JSON.stringify(row),
    ],
  );
}

async function selectRun<T>(q: Queryable, table: RunTable, id: string, forUpdate: boolean): Promise<T | null> {
  const { rows } = await q.query<{ data: T }>(
    `select data from ${table} where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return rows[0]?.data ?? null;
}

async function selectIds(q: Queryable, sql: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await q.query<{ id: string }>(sql, params);
  return rows.map((r) => r.id);
}

/** The offers report a stop leaves behind when it cut off offers analysis. */
function failedOffersReport(prev: LookupOffersReport | null | undefined, reason: string, now: string): LookupOffersReport {
  return {
    status: "failed",
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    error: reason,
    adsAnalyzed: prev?.adsAnalyzed || 0,
    adCopy: prev?.adCopy || {
      uniqueCreatives: 0,
      creatives: [],
      uniqueOffers: [],
    },
    landingPages: prev?.landingPages || {
      uniqueUrls: 0,
      analyzed: 0,
      failed: 0,
      pages: [],
      uniqueOffers: [],
    },
  };
}

/* ── progress throttle ── */

/**
 * Throttled progress saves. The pipelines report progress many times a
 * second, so routine progress is written at most once per PROGRESS_WRITE_MS.
 * A stage change is written at once, a pending write is always flushed with
 * the latest state, and any normal save cancels it so an older snapshot can
 * never land after a newer one.
 */
export const PROGRESS_WRITE_MS = 2_000;
type PendingProgress<T> = { job: T; timer: ReturnType<typeof setTimeout> | null; last: number; stage: string };
const pendingSearchProgress = new Map<string, PendingProgress<SearchJob>>();
const pendingLookupProgress = new Map<string, PendingProgress<LookupJob>>();

function logProgressError(id: string, err: unknown) {
  console.error(`[runs] progress write for ${id} failed:`, err instanceof Error ? err.message : err);
}

/** Resolves when an immediate write has landed; a deferred write resolves at once. */
async function throttleProgress<T extends { id: string; status: string; progress?: { stage?: string } | null }>(
  pending: Map<string, PendingProgress<T>>,
  job: T,
  write: (job: T) => Promise<boolean>,
): Promise<void> {
  const now = Date.now();
  const stage = job.progress?.stage || "";
  const entry = pending.get(job.id) ?? { job, timer: null, last: 0, stage: "" };
  entry.job = job;
  pending.set(job.id, entry);
  if (stage !== entry.stage || now - entry.last >= PROGRESS_WRITE_MS) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.stage = stage;
    entry.last = now;
    try {
      await write(job);
    } catch (err) {
      logProgressError(job.id, err);
    }
    return;
  }
  if (entry.timer) return;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.last = Date.now();
    write(entry.job).catch((err: unknown) => logProgressError(entry.job.id, err));
  }, PROGRESS_WRITE_MS - (now - entry.last));
  entry.timer.unref?.();
}

function settleProgress<T>(
  pending: Map<string, PendingProgress<T>>,
  id: string,
  job: { status: string; progress?: { stage?: string } | null },
) {
  const entry = pending.get(id);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (job.status !== "running") {
    pending.delete(id);
    return;
  }
  entry.timer = null;
  entry.last = Date.now();
  entry.stage = job.progress?.stage || "";
}

/** Save routine search progress, throttled (see PROGRESS_WRITE_MS). */
export function saveJobProgress(job: SearchJob): Promise<void> {
  // SEARCH_DEBUG=1 prints every progress line (local diagnosis of a search).
  if (process.env.SEARCH_DEBUG) console.log(`[search] ${job.progress?.message || ""}`);
  return throttleProgress(pendingSearchProgress, job, writeSearchJob);
}

/** Save routine lookup progress, throttled (see PROGRESS_WRITE_MS). */
export function saveLookupJobProgress(job: LookupJob): Promise<void> {
  return throttleProgress(pendingLookupProgress, job, writeLookupJob);
}

/* ── suppression and stop ── */

async function storedSuppression(table: RunTable, id: string): Promise<boolean> {
  const { rows } = await getDb().query<{ deleted: boolean; stopped: boolean }>(
    `select exists (select 1 from deleted_run_ids where id = $1) as deleted,
            coalesce((select (data->'progress'->>'stopRequested') = 'true' from ${table} where id = $1), false) as stopped`,
    [id],
  );
  return Boolean(rows[0]?.deleted || rows[0]?.stopped);
}

export async function isSearchJobSuppressed(jobId: string): Promise<boolean> {
  if (suppressedSearchJobIds.has(jobId)) return true;
  if (await storedSuppression("jobs", jobId)) {
    suppressedSearchJobIds.add(jobId);
    return true;
  }
  return false;
}

export async function isLookupJobSuppressed(lookupId: string): Promise<boolean> {
  if (suppressedLookupJobIds.has(lookupId)) return true;
  if (await storedSuppression("lookup_jobs", lookupId)) {
    suppressedLookupJobIds.add(lookupId);
    return true;
  }
  return false;
}

/** Allow a stopped search/brand-review job to run again (clears stop flag). */
export async function clearSearchJobSuppression(jobId: string): Promise<SearchJob | null> {
  suppressedSearchJobIds.delete(jobId);
  return withTx(async (tx) => {
    await lockRunId(tx, jobId);
    const prev = await selectRun<SearchJob>(tx, "jobs", jobId, true);
    if (!prev) return null;
    if (!prev.progress?.stopRequested && !suppressedSearchJobIds.has(jobId)) return prev;
    const next: SearchJob = {
      ...prev,
      progress: { ...prev.progress, stopRequested: false },
      updatedAt: new Date().toISOString(),
    };
    await upsertRun(tx, "jobs", next);
    return next;
  });
}

/** Allow a stopped lookup to run its offers report again (clears stop flag). */
export async function clearLookupJobSuppression(lookupId: string): Promise<LookupJob | null> {
  suppressedLookupJobIds.delete(lookupId);
  return withTx(async (tx) => {
    await lockRunId(tx, lookupId);
    const prev = await selectRun<LookupJob>(tx, "lookup_jobs", lookupId, true);
    if (!prev) return null;
    if (!prev.progress?.stopRequested) return prev;
    const next: LookupJob = {
      ...prev,
      progress: { ...prev.progress, stopRequested: false },
      updatedAt: new Date().toISOString(),
    };
    await upsertRun(tx, "lookup_jobs", next);
    return next;
  });
}

/** Ids of the offers lookups a search run owns (`search-offers:<runId>…`). */
function offersLookupIds(q: Queryable, runId: string): Promise<string[]> {
  const prefix = `search-offers:${runId}`;
  return selectIds(q, "select id from lookup_jobs where left(id, length($1)) = $1", [prefix]);
}

/** Stop an in-flight keyword search (pipeline checks suppression each page). */
export async function stopSearchJob(jobId: string, reason = "Stopped by user"): Promise<SearchJob | null> {
  suppressedSearchJobIds.add(jobId);
  return withTx(async (tx) => {
    await lockRunId(tx, jobId);
    const now = new Date().toISOString();
    const lookupIds = await offersLookupIds(tx, jobId);
    await lockRunIds(tx, lookupIds);
    for (const lookupId of lookupIds) {
      suppressedLookupJobIds.add(lookupId);
      const lj = await selectRun<LookupJob>(tx, "lookup_jobs", lookupId, true);
      if (!lj) continue;
      if (lj.status !== "running" && lj.progress?.stage !== "analyzing_offers") continue;
      await upsertRun(tx, "lookup_jobs", {
        ...lj,
        status: lj.adIds?.length ? "partial" : "failed",
        error: reason,
        progress: {
          ...lj.progress,
          stage: "done",
          message: reason,
          stopRequested: true,
          offersPhase: "failed",
          offersCurrentName: null,
        },
        updatedAt: now,
      });
    }
    const prev = await selectRun<SearchJob>(tx, "jobs", jobId, true);
    if (!prev) return null;
    const hasRoster = (prev.competitorIds?.length || 0) > 0;
    const inOffers = prev.progress?.stage === "analyzing_offers";
    const next: SearchJob = {
      ...prev,
      status: hasRoster ? (prev.status === "running" ? "partial" : prev.status) : "failed",
      error: hasRoster ? prev.error : reason,
      offersReport: inOffers ? failedOffersReport(prev.offersReport, reason, now) : prev.offersReport,
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
    await upsertRun(tx, "jobs", next);
    return next;
  });
}

/** Stop an in-flight competitor lookup (including offers analysis). */
export async function stopLookupJob(lookupId: string, reason = "Stopped by user"): Promise<LookupJob | null> {
  suppressedLookupJobIds.add(lookupId);
  return withTx(async (tx) => {
    await lockRunId(tx, lookupId);
    const prev = await selectRun<LookupJob>(tx, "lookup_jobs", lookupId, true);
    if (!prev) return null;
    const hasAds = (prev.adIds?.length || 0) > 0;
    const inOffers = prev.progress?.stage === "analyzing_offers";
    const now = new Date().toISOString();
    const next: LookupJob = {
      ...prev,
      status: hasAds ? (prev.status === "running" ? "partial" : prev.status) : "failed",
      error: hasAds ? prev.error : reason,
      offersReport: inOffers ? failedOffersReport(prev.offersReport, reason, now) : prev.offersReport,
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
    await upsertRun(tx, "lookup_jobs", next);
    return next;
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

function searchInFlight(job: SearchJob, deleted: boolean): boolean {
  if (suppressedSearchJobIds.has(job.id) || job.progress?.stopRequested || deleted) return false;
  return job.status === "running" || SEARCH_IN_FLIGHT_STAGES.has(job.progress?.stage || "");
}

function lookupInFlight(job: LookupJob, deleted: boolean): boolean {
  if (suppressedLookupJobIds.has(job.id) || job.progress?.stopRequested || deleted) return false;
  return job.status === "running" || LOOKUP_IN_FLIGHT_STAGES.has(job.progress?.stage || "");
}

export async function isSearchWorkInFlight(job: SearchJob): Promise<boolean> {
  if (!searchInFlight(job, false)) return false;
  return searchInFlight(job, await runWasDeleted(getDb(), job.id));
}

export async function isLookupWorkInFlight(job: LookupJob): Promise<boolean> {
  if (!lookupInFlight(job, false)) return false;
  return lookupInFlight(job, await runWasDeleted(getDb(), job.id));
}

async function deletedAmong(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  return new Set(await selectIds(getDb(), "select id from deleted_run_ids where id = any($1::text[])", [ids]));
}

/** Stop every in-flight search, lookup, brand review, and offers analysis. */
export async function stopAllInFlightWork(
  reason = "Stopped by user",
  extra?: { jobIds?: string[]; lookupIds?: string[] },
): Promise<{ searchJobIds: string[]; lookupIds: string[] }> {
  const searchJobIds = new Set<string>(extra?.jobIds?.filter(Boolean) || []);
  const lookupIds = new Set<string>(extra?.lookupIds?.filter(Boolean) || []);
  const jobs = await listJobs(200);
  const lookups = await listLookupJobs(200);
  const deleted = await deletedAmong([...jobs.map((j) => j.id), ...lookups.map((j) => j.id)]);
  for (const job of jobs) {
    if (searchInFlight(job, deleted.has(job.id))) searchJobIds.add(job.id);
  }
  for (const job of lookups) {
    if (lookupInFlight(job, deleted.has(job.id))) lookupIds.add(job.id);
  }
  const stoppedSearch: string[] = [];
  const stoppedLookup: string[] = [];
  for (const id of searchJobIds) {
    if (await stopSearchJob(id, reason)) stoppedSearch.push(id);
    else suppressedSearchJobIds.add(id);
  }
  for (const id of lookupIds) {
    if (await stopLookupJob(id, reason)) stoppedLookup.push(id);
    else suppressedLookupJobIds.add(id);
  }
  return { searchJobIds: stoppedSearch, lookupIds: stoppedLookup };
}

/* ── seen pages ── */

export async function getSeenPageIds(): Promise<Set<string>> {
  return new Set(await selectIds(getDb(), "select id from seen_page_ids"));
}

export async function markPageSeen(pageId: string): Promise<void> {
  await getDb().query("insert into seen_page_ids (id) values ($1) on conflict (id) do nothing", [pageId]);
}

/* ── search jobs ── */

/** Persist a search job. Returns false if the run was deleted or stopped and must not resurrect. */
export async function saveJob(job: SearchJob): Promise<boolean> {
  settleProgress(pendingSearchProgress, job.id, job);
  return writeSearchJob(job);
}

function writeSearchJob(job: SearchJob): Promise<boolean> {
  return serial(`search:${job.id}`, () =>
    withTx(async (tx) => {
      await lockRunId(tx, job.id);
      if (suppressedSearchJobIds.has(job.id) || (await runWasDeleted(tx, job.id))) {
        suppressedSearchJobIds.add(job.id);
        return false;
      }
      const existing = await selectRun<SearchJob>(tx, "jobs", job.id, true);
      let next = job;
      if (existing) {
        if (existing.progress?.stopRequested) {
          suppressedSearchJobIds.add(job.id);
          return false;
        }
        // Keep competitorIds a concurrent saveCompetitor already wrote.
        const mergedIds = Array.from(new Set([...(existing.competitorIds || []), ...(job.competitorIds || [])]));
        next = {
          ...job,
          competitorIds: mergedIds,
          // The API route stamps ownership before dispatching the pipeline; the
          // pipeline's own writes don't carry it and must not erase it.
          ownerUserId: job.ownerUserId !== undefined ? job.ownerUserId : existing.ownerUserId,
          spaceId: job.spaceId !== undefined ? job.spaceId : existing.spaceId,
          archivedAt: job.archivedAt !== undefined ? job.archivedAt : existing.archivedAt,
        };
      }
      await upsertRun(tx, "jobs", next);
      return true;
    }),
  );
}

export async function getJob(id: string): Promise<SearchJob | null> {
  return selectRun<SearchJob>(getDb(), "jobs", id, false);
}

export async function updateJob(id: string, patch: Partial<SearchJob>): Promise<SearchJob | null> {
  // A pending throttled progress write holds an older snapshot; drop it.
  settleProgress(pendingSearchProgress, id, { status: patch.status ?? "running", progress: patch.progress });
  return serial(`search:${id}`, () =>
    withTx(async (tx) => {
      await lockRunId(tx, id);
      const existing = await selectRun<SearchJob>(tx, "jobs", id, true);
      if (!existing) return null;
      if (
        suppressedSearchJobIds.has(id) ||
        existing.progress?.stopRequested ||
        (await runWasDeleted(tx, id))
      ) {
        suppressedSearchJobIds.add(id);
        return null;
      }
      const next: SearchJob = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      await upsertRun(tx, "jobs", next);
      return next;
    }),
  );
}

export async function listJobs(limit = 100): Promise<SearchJob[]> {
  const { rows } = await getDb().query<{ data: SearchJob }>(
    "select data from jobs order by created_at desc, id desc limit $1",
    [limit],
  );
  return rows.map((r) => r.data);
}

export async function listHistoryRuns(limit = 100): Promise<HistoryRunSummary[]> {
  const { rows } = await getDb().query<{ data: SearchJob; found: number }>(
    `select j.data,
            (select count(*) from competitors c
              where c.run_id = j.id
                and (c.data->>'recreateOnly') is distinct from 'true')::int as found
       from jobs j
      order by j.created_at desc, j.id desc
      limit $1`,
    [limit],
  );
  return rows.map(({ data, found }) => ({
    ...data,
    competitorCount: Math.max(data.competitorIds?.length ?? 0, found),
  }));
}

/**
 * Delete a run and its competitors. Also frees their pageIds from the
 * global dedup list so the same competitors can be rediscovered later
 * (unless another remaining run still references that pageId).
 */
export async function deleteHistoryRun(runId: string): Promise<{ ok: boolean; removedCompetitors: number }> {
  suppressedSearchJobIds.add(runId);
  return withTx(async (tx) => {
    await lockRunId(tx, runId);
    const lookupIds = await offersLookupIds(tx, runId);
    await lockRunIds(tx, lookupIds);
    for (const id of lookupIds) suppressedLookupJobIds.add(id);
    await rememberDeletedRuns(tx, [runId, ...lookupIds]);
    if (lookupIds.length) {
      await tx.query("delete from lookup_ads where lookup_id = any($1::text[])", [lookupIds]);
      await tx.query("delete from icps where source_kind = 'lookup' and source_id = any($1::text[])", [lookupIds]);
      await tx.query("delete from lookup_jobs where id = any($1::text[])", [lookupIds]);
    }
    await tx.query("delete from icps where source_kind = 'search' and source_id = $1", [runId]);

    const { rows: jobRows } = await tx.query("select 1 from jobs where id = $1 for update", [runId]);
    if (!jobRows.length) return { ok: true, removedCompetitors: 0 };

    // recreated_pages rows go with their competitors (on delete cascade).
    const removed = await tx.query<{ page_id: string | null }>(
      "delete from competitors where run_id = $1 returning data->>'pageId' as page_id",
      [runId],
    );
    await tx.query("delete from search_competitor_ads where run_id = $1", [runId]);
    await tx.query("delete from jobs where id = $1", [runId]);

    const pageIds = [...new Set(removed.rows.map((r) => r.page_id).filter((p): p is string => Boolean(p)))];
    if (pageIds.length) {
      await tx.query(
        `delete from seen_page_ids s
          where s.id = any($1::text[])
            and not exists (select 1 from competitors c where c.data->>'pageId' = s.id)`,
        [pageIds],
      );
    }
    return { ok: true, removedCompetitors: removed.rowCount };
  });
}

/** Delete every run + competitor + clear seen page ids. */
export async function clearAllHistory(): Promise<{ removedRuns: number; removedCompetitors: number }> {
  return withTx(async (tx) => {
    // Tombstones first: a save that committed before this point is deleted
    // below; one that runs after it sees the tombstone and is refused.
    const ids = await selectIds(tx, "select id from jobs order by created_at asc, id asc");
    for (const id of ids) suppressedSearchJobIds.add(id);
    await rememberDeletedRuns(tx, ids);
    const competitors = await tx.query("delete from competitors");
    await tx.query("delete from search_competitor_ads");
    await tx.query("delete from icps where source_kind = 'search'");
    await tx.query("delete from seen_page_ids");
    const jobs = await tx.query("delete from jobs");
    return { removedRuns: jobs.rowCount, removedCompetitors: competitors.rowCount };
  });
}

/* ── lookup jobs ── */

export async function saveLookupJob(job: LookupJob): Promise<boolean> {
  settleProgress(pendingLookupProgress, job.id, job);
  return writeLookupJob(job);
}

function writeLookupJob(job: LookupJob): Promise<boolean> {
  return serial(`lookup:${job.id}`, () =>
    withTx(async (tx) => {
      await lockRunId(tx, job.id);
      if (suppressedLookupJobIds.has(job.id) || (await runWasDeleted(tx, job.id))) {
        suppressedLookupJobIds.add(job.id);
        return false;
      }
      const existing = await selectRun<LookupJob>(tx, "lookup_jobs", job.id, true);
      let next = job;
      if (existing) {
        // Refuse to revive a stopped run.
        if (existing.progress?.stopRequested) {
          suppressedLookupJobIds.add(job.id);
          return false;
        }
        const mergedIds = Array.from(new Set([...(existing.adIds || []), ...(job.adIds || [])]));
        next = {
          ...job,
          adIds: mergedIds,
          // See saveJob(): ownership is stamped by the route, not the pipeline.
          ownerUserId: job.ownerUserId !== undefined ? job.ownerUserId : existing.ownerUserId,
          spaceId: job.spaceId !== undefined ? job.spaceId : existing.spaceId,
          resolvedIdentity: job.resolvedIdentity !== undefined ? job.resolvedIdentity : existing.resolvedIdentity,
          archivedAt: job.archivedAt !== undefined ? job.archivedAt : existing.archivedAt,
        };
      } else if (job.progress?.stopRequested) {
        suppressedLookupJobIds.add(job.id);
        return false;
      }
      await upsertRun(tx, "lookup_jobs", next);
      return true;
    }),
  );
}

export async function getLookupJob(id: string): Promise<LookupJob | null> {
  return selectRun<LookupJob>(getDb(), "lookup_jobs", id, false);
}

export async function updateLookupJob(id: string, patch: Partial<LookupJob>): Promise<LookupJob | null> {
  settleProgress(pendingLookupProgress, id, { status: patch.status ?? "running", progress: patch.progress });
  return serial(`lookup:${id}`, () =>
    withTx(async (tx) => {
      await lockRunId(tx, id);
      const existing = await selectRun<LookupJob>(tx, "lookup_jobs", id, true);
      if (!existing) return null;
      if (
        suppressedLookupJobIds.has(id) ||
        existing.progress?.stopRequested ||
        (await runWasDeleted(tx, id))
      ) {
        suppressedLookupJobIds.add(id);
        return null;
      }
      const next: LookupJob = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      await upsertRun(tx, "lookup_jobs", next);
      return next;
    }),
  );
}

export async function listLookupJobs(limit = 200): Promise<LookupJob[]> {
  const { rows } = await getDb().query<{ data: LookupJob }>(
    "select data from lookup_jobs order by created_at desc, id desc limit $1",
    [limit],
  );
  return rows.map((r) => r.data);
}

export async function listLookupHistory(limit = 100): Promise<LookupHistorySummary[]> {
  const { rows } = await getDb().query<{ data: LookupJob; found: number }>(
    `select l.data,
            (select count(*) from lookup_ads a where a.lookup_id = l.id)::int as found
       from lookup_jobs l
      where (l.data->>'internalOnly') is distinct from 'true'
      order by l.created_at desc, l.id desc
      limit $1`,
    [limit],
  );
  return rows.map(({ data, found }) => ({
    ...data,
    adCount: Math.max(data.adIds?.length ?? 0, found),
  }));
}

export async function deleteLookupHistoryRun(lookupId: string): Promise<{ ok: boolean; removedAds: number }> {
  suppressedLookupJobIds.add(lookupId);
  return withTx(async (tx) => {
    await lockRunId(tx, lookupId);
    await rememberDeletedRuns(tx, [lookupId]);
    const { rows } = await tx.query("select 1 from lookup_jobs where id = $1 for update", [lookupId]);
    if (!rows.length) return { ok: true, removedAds: 0 };
    const ads = await tx.query("delete from lookup_ads where lookup_id = $1", [lookupId]);
    await tx.query("delete from icps where source_kind = 'lookup' and source_id = $1", [lookupId]);
    await tx.query("delete from lookup_jobs where id = $1", [lookupId]);
    return { ok: true, removedAds: ads.rowCount };
  });
}

export async function clearAllLookupHistory(): Promise<{ removedRuns: number; removedAds: number }> {
  return withTx(async (tx) => {
    const ids = await selectIds(tx, "select id from lookup_jobs order by created_at asc, id asc");
    for (const id of ids) suppressedLookupJobIds.add(id);
    await rememberDeletedRuns(tx, ids);
    const ads = await tx.query("delete from lookup_ads");
    await tx.query("delete from icps where source_kind = 'lookup'");
    const jobs = await tx.query("delete from lookup_jobs");
    return { removedRuns: jobs.rowCount, removedAds: ads.rowCount };
  });
}

/* ── restart ── */

export const INTERRUPTED_MESSAGE = "Interrupted by restart";

/**
 * On startup no pipeline of this (single) instance is running yet, so any job
 * or lookup still marked `running` was cut off: mark it failed. Returns how
 * many rows changed.
 */
export async function markInterruptedJobs(): Promise<number> {
  return withTx(async (tx) => {
    const now = new Date().toISOString();
    let changed = 0;
    for (const table of ["jobs", "lookup_jobs"] as const) {
      const result = await tx.query(
        `update ${table}
            set status = 'failed',
                data = jsonb_set(
                  jsonb_set(data || jsonb_build_object('status', 'failed', 'updatedAt', $2::text),
                            '{progress}', coalesce(data->'progress', '{}'::jsonb), true),
                  '{progress,message}', to_jsonb($1::text), true)
          where status = 'running'`,
        [INTERRUPTED_MESSAGE, now],
      );
      changed += result.rowCount;
    }
    return changed;
  });
}
