import type { LookupAdRecord, LookupJob, SearchCompetitorAdRecord } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import {
  lockRun,
  lookupRunSuppressedHere,
  runWasDeleted,
  searchRunSuppressedHere,
  suppressLookupRunHere,
  suppressSearchRunHere,
} from "./runs";

/*
 * Ads of competitor lookups (`lookup_ads`) and the ads cached for keyword
 * search competitors (`search_competitor_ads`), ported from db.ts. Every
 * write takes lockRun on the owning run first (see runs.ts) and refuses a
 * run that was deleted or is suppressed, so a pipeline still running cannot
 * write ads back for it.
 */

/**
 * Last record per id, ordered by each id's last occurrence (one upsert cannot
 * touch a row twice).
 */
export function lastPerId<T extends { id: string }>(records: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of records) {
    byId.delete(r.id);
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

/** Newest first, as db.ts kept them (new records went to the front). */
const NEWEST_FIRST = "order by (data->>'createdAt') desc nulls last, id desc";

/* ── lookup ads ── */

/** Inserts or replaces lookup ads (the caller holds lockRun on their lookup, or the exclusive key). */
export async function upsertLookupAds(tx: Queryable, ads: LookupAdRecord[]): Promise<void> {
  await tx.query(
    `insert into lookup_ads (id, lookup_id, data)
     select x->>'id', x->>'lookupId', x from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set lookup_id = excluded.lookup_id, data = excluded.data`,
    [JSON.stringify(lastPerId(ads))],
  );
}

export function saveLookupAd(ad: LookupAdRecord): Promise<boolean> {
  return saveLookupAds([ad]);
}

/**
 * Save ads of one lookup (the first ad's lookupId) and add their ids to the
 * lookup. Returns false when the lookup is missing, stopped, deleted, or
 * suppressed in this process.
 */
export async function saveLookupAds(ads: LookupAdRecord[]): Promise<boolean> {
  if (!ads.length) return true;
  const lookupId = ads[0].lookupId;
  return withTx(async (tx) => {
    await lockRun(tx, lookupId);
    const { rows } = await tx.query<{ data: LookupJob }>("select data from lookup_jobs where id = $1 for update", [
      lookupId,
    ]);
    const job = rows[0]?.data;
    if (!job) return false;
    if (lookupRunSuppressedHere(lookupId) || job.progress?.stopRequested || (await runWasDeleted(tx, lookupId))) {
      suppressLookupRunHere(lookupId);
      return false;
    }
    await upsertLookupAds(tx, ads);
    const adIds = [...(job.adIds ?? [])];
    for (const ad of ads) if (!adIds.includes(ad.id)) adIds.push(ad.id);
    const next: LookupJob = { ...job, adIds, updatedAt: new Date().toISOString() };
    await tx.query("update lookup_jobs set data = $2::jsonb where id = $1", [lookupId, JSON.stringify(next)]);
    return true;
  });
}

export async function getLookupAd(adId: string): Promise<LookupAdRecord | null> {
  const { rows } = await getDb().query<{ data: LookupAdRecord }>("select data from lookup_ads where id = $1", [adId]);
  return rows[0]?.data ?? null;
}

export async function updateLookupAd(adId: string, patch: Partial<LookupAdRecord>): Promise<LookupAdRecord | null> {
  return withTx(async (tx) => {
    const owner = await tx.query<{ lookup_id: string }>("select lookup_id from lookup_ads where id = $1", [adId]);
    const lookupId = owner.rows[0]?.lookup_id;
    if (lookupId === undefined) return null;
    await lockRun(tx, lookupId);
    const { rows } = await tx.query<{ data: LookupAdRecord }>("select data from lookup_ads where id = $1 for update", [
      adId,
    ]);
    const prev = rows[0]?.data;
    if (!prev) return null;
    let next: LookupAdRecord = { ...prev, ...patch };
    // Never let a stale "pending" clobber a completed/failed analysis
    if (
      patch.pageAnalysis?.status === "pending" &&
      (prev.pageAnalysis?.status === "completed" || prev.pageAnalysis?.status === "failed") &&
      prev.pageAnalysis.offer
    ) {
      // Keep the last good offer visible while refreshing.
      next = {
        ...next,
        pageAnalysis: {
          ...patch.pageAnalysis,
          offer: prev.pageAnalysis.offer,
          pageArchitecture: prev.pageAnalysis.pageArchitecture,
          summary: prev.pageAnalysis.summary,
          levels: prev.pageAnalysis.levels,
        },
      };
    }
    await tx.query("update lookup_ads set lookup_id = $2, data = $3::jsonb where id = $1", [
      adId,
      next.lookupId,
      JSON.stringify(next),
    ]);
    await tx.query("update lookup_jobs set data = jsonb_set(data, '{updatedAt}', to_jsonb($2::text)) where id = $1", [
      lookupId,
      new Date().toISOString(),
    ]);
    return next;
  });
}

export async function getLookupAds(lookupId: string): Promise<LookupAdRecord[]> {
  const { rows } = await getDb().query<{ data: LookupAdRecord }>(
    `select data from lookup_ads where lookup_id = $1 ${NEWEST_FIRST}`,
    [lookupId],
  );
  return rows.map((r) => r.data);
}

/* ── search competitor ads ── */

export function saveSearchCompetitorAd(ad: SearchCompetitorAdRecord): Promise<boolean> {
  return saveSearchCompetitorAds([ad]);
}

/**
 * Save cached ads of a search run (options.runId, else the first ad's run).
 * With replaceCompetitorId, that competitor's other cached ads in the run are
 * removed first. Returns false when the run is missing, deleted, or
 * suppressed in this process.
 */
export async function saveSearchCompetitorAds(
  ads: SearchCompetitorAdRecord[],
  options?: { replaceCompetitorId?: string; runId?: string },
): Promise<boolean> {
  if (!ads.length && !options?.replaceCompetitorId) return true;
  const runId = options?.runId || ads[0]?.runId;
  if (!runId || searchRunSuppressedHere(runId)) return false;
  return withTx(async (tx) => {
    await lockRun(tx, runId);
    if (searchRunSuppressedHere(runId) || (await runWasDeleted(tx, runId))) {
      suppressSearchRunHere(runId);
      return false;
    }
    const job = await tx.query("select 1 from jobs where id = $1", [runId]);
    if (!job.rows.length) return false;
    const records = lastPerId(ads);
    if (options?.replaceCompetitorId) {
      // Rows being saved again are upserted below, not deleted and re-inserted.
      await tx.query(
        `delete from search_competitor_ads
          where run_id = $1 and competitor_id = $2 and not (id = any($3::text[]))`,
        [runId, options.replaceCompetitorId, records.map((a) => a.id)],
      );
    }
    await upsertSearchCompetitorAds(tx, records);
    return true;
  });
}

/** Inserts or replaces cached search ads (the caller holds lockRun on their run, or the exclusive key). */
export async function upsertSearchCompetitorAds(tx: Queryable, ads: SearchCompetitorAdRecord[]): Promise<void> {
  if (!ads.length) return;
  await tx.query(
    `insert into search_competitor_ads (id, run_id, competitor_id, data)
     select x->>'id', x->>'runId', x->>'competitorId', x from jsonb_array_elements($1::jsonb) as t(x)
     on conflict (id) do update set
       run_id        = excluded.run_id,
       competitor_id = excluded.competitor_id,
       data          = excluded.data`,
    [JSON.stringify(lastPerId(ads))],
  );
}

export async function getSearchCompetitorAdsByRun(runId: string): Promise<SearchCompetitorAdRecord[]> {
  const { rows } = await getDb().query<{ data: SearchCompetitorAdRecord }>(
    `select data from search_competitor_ads where run_id = $1 ${NEWEST_FIRST}`,
    [runId],
  );
  return rows.map((r) => r.data);
}

export async function getSearchCompetitorAdsByCompetitor(
  runId: string,
  competitorId: string,
): Promise<SearchCompetitorAdRecord[]> {
  const { rows } = await getDb().query<{ data: SearchCompetitorAdRecord }>(
    `select data from search_competitor_ads where run_id = $1 and competitor_id = $2 ${NEWEST_FIRST}`,
    [runId, competitorId],
  );
  return rows.map((r) => r.data);
}
