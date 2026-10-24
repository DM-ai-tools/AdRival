import type {
  AppUser,
  CompetitorRecord,
  DatabaseShape,
  IcpRecord,
  LegacyCompetitorRecord,
  LookupAdRecord,
  SearchCompetitorAdRecord,
} from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { upsertCompetitor } from "./competitors";
import { upsertIcpRow } from "./icps";
import { emptyDb, remapImportedOwners, type ImportOwnerOptions, type ImportOwnerSummary } from "./legacyStore";
import { lastPerId, upsertLookupAds, upsertSearchCompetitorAds } from "./lookups";
import { applyHeavy, planPage } from "./recreatedPages";
import {
  lockRunsExclusive,
  rememberDeletedRuns,
  suppressLookupRunHere,
  suppressSearchRunHere,
  unsuppressLookupRunHere,
  unsuppressSearchRunHere,
  upsertRun,
} from "./runs";

/*
 * History import (local store.json → this database), the Postgres port of
 * db.ts replaceStore / mergeStore. Only run/history collections are taken from
 * the import: jobs, competitors, seen page ids, lookups, lookup ads, search
 * ads, ICPs and deleted-run tombstones. Accounts, credits, ledger, audit,
 * settings, organisations and login attempts are never touched.
 *
 * An import is a bulk writer: it holds the global runs key exclusive for its
 * whole transaction (see runs.ts), so no per-run save interleaves with it.
 */

export interface StoreStats {
  jobs: number;
  competitors: number;
  lookupJobs: number;
  lookupAds: number;
  searchCompetitorAds: number;
  seenPageIds: number;
}

export interface ImportResult {
  before: StoreStats;
  after: StoreStats;
  owners: ImportOwnerSummary | null;
}

/** Row counts of the history tables (competitors include recreate-only pages). */
export async function getStoreStats(q: Queryable = getDb()): Promise<StoreStats> {
  const { rows } = await q.query<StoreStats>(
    `select (select count(*) from jobs)::int                  as "jobs",
            (select count(*) from competitors)::int           as "competitors",
            (select count(*) from lookup_jobs)::int           as "lookupJobs",
            (select count(*) from lookup_ads)::int            as "lookupAds",
            (select count(*) from search_competitor_ads)::int as "searchCompetitorAds",
            (select count(*) from seen_page_ids)::int         as "seenPageIds"`,
  );
  return rows[0];
}

/** Replace all history with the import's (used for local → production history import). */
export function replaceStore(payload: Partial<DatabaseShape>, options: ImportOwnerOptions = {}): Promise<ImportResult> {
  return importHistory("replace", payload, options);
}

/**
 * Merge imported history into the existing history by id (keeps rows only
 * this database has; incoming rows win on id conflicts). A run deleted here
 * (it has a tombstone) is not brought back, nor are its rows.
 */
export function mergeStore(payload: Partial<DatabaseShape>, options: ImportOwnerOptions = {}): Promise<ImportResult> {
  return importHistory("merge", payload, options);
}

/** The history collections of an import, normalized like db.ts did (emptyDb + arrays only). */
type History = Required<
  Pick<
    DatabaseShape,
    "jobs" | "competitors" | "seenPageIds" | "lookupJobs" | "lookupAds" | "icps" | "searchCompetitorAds" | "deletedRunIds"
  >
>;

function takeHistory(input: Partial<DatabaseShape>): History {
  const db = emptyDb();
  const array = <K extends keyof History>(key: K): History[K] =>
    (Array.isArray(input[key]) ? input[key] : db[key] ?? []) as History[K];
  return {
    jobs: array("jobs"),
    competitors: array("competitors"),
    seenPageIds: array("seenPageIds"),
    lookupJobs: array("lookupJobs"),
    lookupAds: array("lookupAds"),
    icps: array("icps"),
    searchCompetitorAds: array("searchCompetitorAds"),
    deletedRunIds: array("deletedRunIds"),
  };
}

const CHUNK = 500;

function chunks<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) out.push(rows.slice(i, i + CHUNK));
  return out;
}

async function selectIds(tx: Queryable, sql: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(sql, params);
  return rows.map((r) => r.id);
}

/** One ICP per source + stage: duplicates in an old store collapse to the newest. */
function newestIcpPerStage(icps: IcpRecord[]): IcpRecord[] {
  const byStage = new Map<string, IcpRecord>();
  for (const icp of lastPerId(icps)) {
    const key = JSON.stringify([icp.source?.kind, icp.source?.id, icp.stage]);
    const held = byStage.get(key);
    if (!held || (icp.createdAt || "") >= (held.createdAt || "")) byStage.set(key, icp);
  }
  return [...byStage.values()];
}

/** Run ids an import made live or removed, applied to this process once it commits. */
interface RunChanges {
  liveSearch: string[];
  liveLookup: string[];
  removedSearch: string[];
  removedLookup: string[];
}

async function importHistory(
  mode: "replace" | "merge",
  payload: Partial<DatabaseShape>,
  options: ImportOwnerOptions,
): Promise<ImportResult> {
  const { result, runs } = await importInTx(mode, payload, options);
  // Only after the commit: a rolled-back import changes nothing here. Runs the
  // import wrote are live, so this process may write them again; runs a
  // replace removed are refused from now on (a pipeline may still hold one).
  for (const id of runs.liveSearch) unsuppressSearchRunHere(id);
  for (const id of runs.liveLookup) unsuppressLookupRunHere(id);
  for (const id of runs.removedSearch) suppressSearchRunHere(id);
  for (const id of runs.removedLookup) suppressLookupRunHere(id);
  return result;
}

function importInTx(
  mode: "replace" | "merge",
  payload: Partial<DatabaseShape>,
  options: ImportOwnerOptions,
): Promise<{ result: ImportResult; runs: RunChanges }> {
  return withTx(async (tx) => {
    await lockRunsExclusive(tx);
    const before = await getStoreStats(tx);
    // Not an object: nothing to import (a replace still clears the history).
    const valid = Boolean(payload) && typeof payload === "object";
    const incoming = takeHistory(valid ? payload : {});
    let owners: ImportOwnerSummary | null = null;
    if (valid) {
      const { rows: users } = await tx.query<{ data: AppUser }>("select data from users");
      owners = remapImportedOwners(
        { ...emptyDb(), jobs: incoming.jobs, lookupJobs: incoming.lookupJobs, users: users.map((r) => r.data) },
        Array.isArray(payload.users) ? payload.users : undefined,
        options,
      );
    }

    // Merge: a run deleted here stays deleted, with its rows. Replace: the import is the whole history.
    const blocked = mode === "merge" ? new Set(await selectIds(tx, "select id from deleted_run_ids")) : new Set<string>();
    const allowed = (runId: string | null | undefined) => !blocked.has(runId ?? "");

    const jobs = lastPerId(incoming.jobs).filter((j) => allowed(j.id));
    const lookupJobs = lastPerId(incoming.lookupJobs).filter((j) => allowed(j.id));
    const competitors = lastPerId(incoming.competitors).filter((c) => allowed(c.runId));
    const lookupAds = lastPerId(incoming.lookupAds).filter((a) => allowed(a.lookupId)).map(withLookupId);
    const searchAds = lastPerId(incoming.searchCompetitorAds).filter((a) => allowed(a.runId)).map(withRunIds);
    const icps = newestIcpPerStage(incoming.icps.filter((i) => allowed(i.source?.id)));
    const seenPageIds = [...new Set(incoming.seenPageIds.filter((id): id is string => typeof id === "string"))];

    for (const job of jobs) await upsertRun(tx, "jobs", job);
    for (const job of lookupJobs) await upsertRun(tx, "lookup_jobs", job);
    await importCompetitors(tx, competitors);
    for (const part of chunks(lookupAds)) await upsertLookupAds(tx, part);
    for (const part of chunks(searchAds)) await upsertSearchCompetitorAds(tx, part);
    for (const icp of icps) await upsertIcpRow(tx, icp);
    for (const part of chunks(seenPageIds)) {
      await tx.query("insert into seen_page_ids (id) select unnest($1::text[]) on conflict (id) do nothing", [part]);
    }

    const gone =
      mode === "replace"
        ? await deleteOthers(tx, {
            jobs: jobs.map((r) => r.id),
            lookupJobs: lookupJobs.map((r) => r.id),
            competitors: competitors.map((r) => r.id),
            lookupAds: lookupAds.map((r) => r.id),
            searchAds: searchAds.map((r) => r.id),
            icps: icps.map((r) => r.id),
            seenPageIds,
          })
        : { search: [], lookup: [] };
    const removed = [...gone.search, ...gone.lookup];

    // Tombstones: the import's, then every run a replace removed. A run that
    // is live after the import never has one.
    const wanted = [...incoming.deletedRunIds.filter((id): id is string => typeof id === "string"), ...removed];
    const live = new Set(
      await selectIds(
        tx,
        "select id from jobs where id = any($1::text[]) union select id from lookup_jobs where id = any($1::text[])",
        [wanted],
      ),
    );
    const tombstones = wanted.filter((id) => !live.has(id));
    if (mode === "replace") {
      await tx.query("delete from deleted_run_ids where not (id = any($1::text[]))", [tombstones]);
    }
    await rememberDeletedRuns(tx, tombstones);

    return {
      result: { before, after: await getStoreStats(tx), owners },
      runs: {
        liveSearch: jobs.map((j) => j.id),
        liveLookup: lookupJobs.map((j) => j.id),
        removedSearch: gone.search,
        removedLookup: gone.lookup,
      },
    };
  });
}

/**
 * Replace: deletes every history row the import did not write (ids kept per
 * table). Returns the removed run ids per table, oldest first; the caller
 * suppresses them in this process once the transaction has committed.
 */
async function deleteOthers(
  tx: Queryable,
  keep: Record<"jobs" | "lookupJobs" | "competitors" | "lookupAds" | "searchAds" | "icps" | "seenPageIds", string[]>,
): Promise<{ search: string[]; lookup: string[] }> {
  const removedRuns = (table: "jobs" | "lookup_jobs", ids: string[]) =>
    selectIds(
      tx,
      `with gone as (delete from ${table} where not (id = any($1::text[])) returning id, created_at)
       select id from gone order by created_at, id`,
      [ids],
    );
  const searchGone = await removedRuns("jobs", keep.jobs);
  const lookupGone = await removedRuns("lookup_jobs", keep.lookupJobs);
  // recreated_pages rows go with their competitors (on delete cascade).
  await tx.query("delete from competitors where not (id = any($1::text[]))", [keep.competitors]);
  await tx.query("delete from lookup_ads where not (id = any($1::text[]))", [keep.lookupAds]);
  await tx.query("delete from search_competitor_ads where not (id = any($1::text[]))", [keep.searchAds]);
  await tx.query("delete from icps where not (id = any($1::text[]))", [keep.icps]);
  await tx.query("delete from seen_page_ids where not (id = any($1::text[]))", [keep.seenPageIds]);
  return { search: searchGone, lookup: lookupGone };
}

/**
 * Competitor rows with their page content split off (recreated_pages); the
 * owner is copied from the run. A stored page is the base for an incoming
 * light page, as in saveCompetitor; a full (legacy) page replaces its content.
 */
async function importCompetitors(tx: Queryable, rows: LegacyCompetitorRecord[]): Promise<void> {
  if (!rows.length) return;
  const runIds = [...new Set(rows.map((c) => c.runId))];
  const { rows: owners } = await tx.query<{ id: string; owner: string | null }>(
    "select id, owner_user_id as owner from jobs where id = any($1::text[])",
    [runIds],
  );
  const ownerOf = new Map(owners.map((r) => [r.id, r.owner]));
  for (const competitor of rows) {
    const { rows: found } = await tx.query<{ data: CompetitorRecord }>(
      "select data from competitors where id = $1 for update",
      [competitor.id],
    );
    const stored = found[0]?.data ?? null;
    const { page, action } = planPage(competitor.recreatedPage, undefined, stored?.recreatedPage, stored !== null);
    const row = { ...competitor, runId: competitor.runId ?? "", recreatedPage: page } as CompetitorRecord;
    if (page === undefined) delete row.recreatedPage;
    await upsertCompetitor(tx, row, ownerOf.get(competitor.runId) ?? null);
    await applyHeavy(tx, competitor.id, action);
  }
}

/* Old stores can miss the reference columns; the tables require them. */
function withLookupId(ad: LookupAdRecord): LookupAdRecord {
  return { ...ad, lookupId: ad.lookupId ?? "" };
}

function withRunIds(ad: SearchCompetitorAdRecord): SearchCompetitorAdRecord {
  return { ...ad, runId: ad.runId ?? "", competitorId: ad.competitorId ?? "" };
}
