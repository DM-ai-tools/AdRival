import type { CompetitorRecord, RecreatedPageHeavy, SearchJob } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { jsonText } from "./jsonText";
import { applyHeavy, planPage, prefetchArchivedPage, readRecreatedPage } from "./recreatedPages";
import {
  isoOrNull,
  lockRun,
  recreateOnlySql,
  runWasDeleted,
  searchRunSuppressedHere,
  suppressSearchRunHere,
} from "./runs";

/*
 * Competitors found by a search run, ported from db.ts. The row keeps the
 * record in `data` with a light recreatedPage (see recreatedPages.ts); the
 * page content is in recreated_pages and is read here only by
 * updateCompetitorWith({ withContent: true }) (an archived page is fetched
 * from Storage before its write transaction opens).
 *
 * Every write takes lockRun(runId) first (see runs.ts), so it serializes with
 * the run's own saves, deletion and the bulk clears.
 */

/**
 * A competitor to save, with its page content passed apart (the new API).
 * `recreatedPageHeavy` replaces the whole stored content: pass every field to keep.
 */
export type CompetitorInput = CompetitorRecord & { recreatedPageHeavy?: RecreatedPageHeavy };

/** Inserts or replaces one competitor row (the caller holds lockRun on its run, or the exclusive key). */
export async function upsertCompetitor(tx: Queryable, row: CompetitorRecord, ownerUserId: string | null): Promise<void> {
  await tx.query(
    `insert into competitors (id, run_id, owner_user_id, created_at, data)
     values ($1, $2, $3, coalesce($4::timestamptz, now()), $5::jsonb)
     on conflict (id) do update set
       run_id        = excluded.run_id,
       owner_user_id = excluded.owner_user_id,
       created_at    = excluded.created_at,
       data          = excluded.data`,
    [row.id, row.runId, ownerUserId, isoOrNull(row.createdAt), jsonText(row)],
  );
}

async function storedCompetitor(q: Queryable, id: string, forUpdate: boolean): Promise<CompetitorRecord | null> {
  const { rows } = await q.query<{ data: CompetitorRecord }>(
    `select data from competitors where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return rows[0]?.data ?? null;
}

async function selectCompetitors(sql: string, params: unknown[]): Promise<CompetitorRecord[]> {
  const { rows } = await getDb().query<{ data: CompetitorRecord }>(sql, params);
  return rows.map((r) => r.data);
}

/**
 * Save a competitor of a search run. Returns false (and writes nothing) when
 * the run is missing, deleted, or suppressed in this process. A found
 * competitor joins the seen-page list and the job's competitorIds; a page
 * held for recreation (recreateOnly) joins neither.
 *
 * Page content: `recreatedPageHeavy` replaces the whole stored content. Without
 * it, `recreatedPage` follows updateCompetitor's rules (a light page with heavy
 * fields throws; no recreatedPage keeps the stored page and content).
 */
export async function saveCompetitor(input: CompetitorInput): Promise<boolean> {
  const { recreatedPageHeavy, ...competitor } = input;
  const runId = competitor.runId;
  if (searchRunSuppressedHere(runId)) return false;
  return withTx(async (tx) => {
    await lockRun(tx, runId);
    if (searchRunSuppressedHere(runId) || (await runWasDeleted(tx, runId))) {
      suppressSearchRunHere(runId);
      return false;
    }
    const jobRows = await tx.query<{ data: SearchJob }>("select data from jobs where id = $1 for update", [runId]);
    const job = jobRows.rows[0]?.data;
    // Don't orphan competitors onto a deleted / missing run.
    if (!job) return false;

    const existing = await storedCompetitor(tx, competitor.id, true);
    const { page, action } = planPage(
      competitor.recreatedPage,
      recreatedPageHeavy,
      existing?.recreatedPage,
      existing !== null,
    );
    const row = { ...competitor, recreatedPage: page } as CompetitorRecord;
    if (page === undefined) delete row.recreatedPage;
    await upsertCompetitor(tx, row, job.ownerUserId ?? null);
    await applyHeavy(tx, competitor.id, action);

    if (competitor.recreateOnly) return true;
    if (competitor.pageId != null) {
      await tx.query("insert into seen_page_ids (id) values ($1) on conflict (id) do nothing", [competitor.pageId]);
    }
    const ids = job.competitorIds ?? [];
    if (!ids.includes(competitor.id)) {
      const next: SearchJob = { ...job, competitorIds: [...ids, competitor.id], updatedAt: new Date().toISOString() };
      await tx.query("update jobs set data = $2::jsonb where id = $1", [runId, jsonText(next)]);
    }
    return true;
  });
}

/** The competitors a search found (pages held only for recreation are left out). */
export function getCompetitorsByRun(runId: string): Promise<CompetitorRecord[]> {
  return selectCompetitors(
    `select data from competitors
      where run_id = $1 and not ${recreateOnlySql("data")}
      order by created_at desc, id desc`,
    [runId],
  );
}

/** Landing pages from a search's offers dashboard held for recreation. */
export function getRecreateOnlyPagesByRun(runId: string): Promise<CompetitorRecord[]> {
  return selectCompetitors(
    `select data from competitors
      where run_id = $1 and ${recreateOnlySql("data")}
      order by created_at desc, id desc`,
    [runId],
  );
}

/**
 * A user's recreations: every record they own that holds a recreated page
 * (versions, and older source records that already had one). Scoped to a
 * client space through the run's job; a null space means runs with no space.
 */
export function listRecreationsForUser(userId: string, spaceId: string | null): Promise<CompetitorRecord[]> {
  return selectCompetitors(
    `select c.data from competitors c
       join jobs j on j.id = c.run_id
      where c.owner_user_id = $1
        and j.space_id is not distinct from $2::text
        and coalesce(c.data->'recreatedPage', 'null'::jsonb) <> 'null'::jsonb
      order by c.created_at desc, c.id desc`,
    [userId, spaceId],
  );
}

/** One competitor, with its light page (content via getRecreatedPage). */
export function getCompetitor(id: string): Promise<CompetitorRecord | null> {
  return storedCompetitor(getDb(), id, false);
}

export function listAllCompetitors(limit = 100): Promise<CompetitorRecord[]> {
  return selectCompetitors("select data from competitors order by created_at desc, id desc limit $1", [limit]);
}

/**
 * Patch a competitor. Never reads page content. For `recreatedPage`:
 * - a light page (no heavy fields) keeps the stored content and marker;
 * - a full legacy page (heavy fields, no marker keys) replaces the whole content;
 * - a light page carrying heavy fields throws: use setRecreatedPage;
 * - undefined keeps the stored page; null removes page and content.
 */
export async function updateCompetitor(id: string, patch: Partial<CompetitorRecord>): Promise<CompetitorRecord | null> {
  return withTx(async (tx) => {
    const owner = await tx.query<{ run_id: string }>("select run_id from competitors where id = $1", [id]);
    const runId = owner.rows[0]?.run_id;
    if (runId === undefined) return null;
    await lockRun(tx, runId);
    const existing = await storedCompetitor(tx, id, true);
    if (!existing) return null;
    const next: CompetitorRecord = { ...existing, ...patch };
    let action: Parameters<typeof applyHeavy>[2] = { kind: "keep" };
    if ("recreatedPage" in patch) {
      const plan = planPage(patch.recreatedPage, undefined, existing.recreatedPage, true);
      next.recreatedPage = plan.page as CompetitorRecord["recreatedPage"];
      action = plan.action;
    }
    await tx.query(
      `update competitors
          set run_id = $2, created_at = coalesce($3::timestamptz, created_at), data = $4::jsonb
        where id = $1`,
      [id, next.runId, isoOrNull(next.createdAt), jsonText(next)],
    );
    await applyHeavy(tx, id, action);
    return next;
  });
}

/**
 * Deletes a recreation version that holds no page yet (a queued recreation
 * removed before it started). Any other record is left alone: false.
 */
export async function deleteCompetitor(id: string): Promise<boolean> {
  return withTx(async (tx) => {
    const owner = await tx.query<{ run_id: string }>("select run_id from competitors where id = $1", [id]);
    const runId = owner.rows[0]?.run_id;
    if (runId === undefined) return false;
    await lockRun(tx, runId);
    const { rowCount } = await tx.query(
      `delete from competitors
        where id = $1
          and coalesce(data->'recreateOnly'->>'variantOf', '') <> ''
          and coalesce(data->'recreatedPage', 'null'::jsonb) = 'null'::jsonb`,
      [id],
    );
    return rowCount > 0;
  });
}

/** What an updateCompetitorWith updater returns: a patch, with optional page content apart. */
export type CompetitorUpdate = Partial<CompetitorRecord> & { recreatedPageHeavy?: RecreatedPageHeavy };

/**
 * Atomic read-modify-write of one competitor. `updater` runs inside the write
 * transaction with the stored record (row locked), so a concurrent update can
 * never be lost between the read and the write. It must be synchronous and
 * returns the patch to apply (updateCompetitor's rules for recreatedPage), or
 * null to write nothing (the stored record is returned).
 *
 * With `withContent`, the updater also gets the page content (null when none
 * is stored; an archived page is fetched from Storage BEFORE the transaction
 * opens, and used when the row is still at that archived version under the
 * lock; it may throw ArchivedPageUnavailableError). Without it the content
 * argument is undefined.
 * `recreatedPageHeavy` in the patch replaces the whole stored content in the
 * same transaction, so pass every field to keep.
 */
export async function updateCompetitorWith(
  id: string,
  updater: (existing: CompetitorRecord, content: RecreatedPageHeavy | null | undefined) => CompetitorUpdate | null,
  options: { withContent?: boolean } = {},
): Promise<CompetitorRecord | null> {
  const prefetched = options.withContent ? await prefetchArchivedPage(id) : null;
  return withTx(async (tx) => {
    const owner = await tx.query<{ run_id: string }>("select run_id from competitors where id = $1", [id]);
    const runId = owner.rows[0]?.run_id;
    if (runId === undefined) return null;
    await lockRun(tx, runId);
    const existing = await storedCompetitor(tx, id, true);
    if (!existing) return null;
    const content = options.withContent ? await readRecreatedPage(tx, id, true, prefetched) : undefined;
    const update = updater(existing, content);
    if (!update) return existing;
    const { recreatedPageHeavy, ...patch } = update;
    const next: CompetitorRecord = { ...existing, ...patch };
    let action: Parameters<typeof applyHeavy>[2] = { kind: "keep" };
    if ("recreatedPage" in patch || recreatedPageHeavy) {
      const plan = planPage(
        "recreatedPage" in patch ? patch.recreatedPage : undefined,
        recreatedPageHeavy,
        existing.recreatedPage,
        true,
      );
      next.recreatedPage = plan.page as CompetitorRecord["recreatedPage"];
      if (plan.page === undefined) delete next.recreatedPage;
      action = plan.action;
    }
    await tx.query(
      `update competitors
          set run_id = $2, created_at = coalesce($3::timestamptz, created_at), data = $4::jsonb
        where id = $1`,
      [id, next.runId, isoOrNull(next.createdAt), jsonText(next)],
    );
    await applyHeavy(tx, id, action);
    return next;
  });
}
