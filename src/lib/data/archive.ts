import { createHash, randomUUID } from "node:crypto";

import { mapPool } from "../pipeline/pool";
import { getDb, withTx } from "./client";
import { getStorage, StorageNotConfiguredError, StorageNotFoundError, storageConfigured } from "./storageClient";

/*
 * Recreated page content older than a window moves from the database
 * (recreated_pages.content, gzip of its JSON) to Supabase Storage, to keep the
 * free-tier database small. The row stays, with archive_path instead of
 * content; reading an archived page fetches the file (getRecreatedPage), and
 * any write of the page (setRecreatedPage / applyHeavy) puts the content back
 * into the row.
 *
 * Archiving a page: claim the row (a short lease in recreated_pages.data, so
 * two archivers never upload the same row at once), upload the bytes, read
 * them back and compare length and sha-256, and only then, in one short
 * transaction that locks the row and checks it still holds the same content
 * (same hash, same updated_at, our claim), swap content for archive_path. No
 * transaction is open during the upload or read-back. A page changed meanwhile
 * keeps its new content and is left for a later run.
 */

/** An archived page whose file could not be read (missing, unreachable, corrupt, or no archive configured). */
export class ArchivedPageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArchivedPageUnavailableError";
  }
}

export const ARCHIVE_BUCKET = "recreated-pages-archive";

const DEFAULT_DAYS = 14;
const BATCH = 20;
/** One call stops picking new pages after this long. */
const TIME_BUDGET_MS = 5 * 60_000;
/** How long a claim keeps other archivers off a row (longer than an upload plus read-back with retries). */
const CLAIM_MINUTES = 10;
const HOUR_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 60_000;
/** Storage deletes in flight at once (a run or a history clear can name hundreds). */
const DELETE_CONCURRENCY = 5;

/** The object path (inside the bucket) for a competitor's archived page. */
export function archiveObjectPath(competitorId: string): string {
  if (/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(competitorId)) return `${competitorId}.json.gz`;
  // Ids with other characters get a safe name; the hash keeps it unique.
  const safe = competitorId.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\./, "_").slice(0, 80);
  const hash = createHash("sha256").update(competitorId).digest("hex").slice(0, 16);
  return `${safe}-${hash}.json.gz`;
}

/** archive_path values are `bucket/object`; an older bare object path is read from the archive bucket. */
function splitArchivePath(path: string): { bucket: string; object: string } {
  const prefix = `${ARCHIVE_BUCKET}/`;
  return { bucket: ARCHIVE_BUCKET, object: path.startsWith(prefix) ? path.slice(prefix.length) : path };
}

/** The stored (gzip) bytes of an archived page. Any failure is ArchivedPageUnavailableError (with the cause). */
export async function fetchArchived(path: string): Promise<Buffer> {
  const { bucket, object } = splitArchivePath(path);
  try {
    return await getStorage().getObject(bucket, object);
  } catch (err) {
    const why = err instanceof StorageNotFoundError
      ? "is missing"
      : err instanceof StorageNotConfiguredError
        ? "cannot be read: Storage is not configured"
        : "could not be read";
    throw new ArchivedPageUnavailableError(`archived page ${path} ${why}`, { cause: err });
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** RECREATED_PAGE_ARCHIVE_DAYS, default 14. */
function windowDays(): number {
  const raw = process.env.RECREATED_PAGE_ARCHIVE_DAYS?.trim();
  if (!raw) return DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAYS;
}

type Outcome = "archived" | "failed" | "skipped";

const CLAIM_FREE = "coalesce((data->>'archiveClaimUntil')::timestamptz, '-infinity'::timestamptz) < now()";

/** Takes the archive claim on one row with content older than `cutoff`; null when it is not (or no longer) eligible. */
async function claim(
  competitorId: string,
  cutoff: string,
  token: string,
): Promise<{ content: Buffer; stamp: string } | null> {
  const { rows } = await getDb().query<{ content: Buffer | Uint8Array; stamp: string }>(
    `update recreated_pages
        set data = data || jsonb_build_object(
              'archiveClaim', $2::text,
              'archiveClaimUntil', now() + make_interval(mins => $4::int))
      where competitor_id = $1
        and content is not null
        and updated_at <= $3::timestamptz
        and ${CLAIM_FREE}
      returning content, updated_at::text as stamp`,
    [competitorId, token, cutoff, CLAIM_MINUTES],
  );
  const row = rows[0];
  return row ? { content: Buffer.from(row.content), stamp: row.stamp } : null;
}

/** Drops our claim (best effort; the lease runs out anyway). */
async function release(competitorId: string, token: string): Promise<void> {
  try {
    await getDb().query(
      `update recreated_pages set data = data - 'archiveClaim' - 'archiveClaimUntil'
        where competitor_id = $1 and data->>'archiveClaim' = $2`,
      [competitorId, token],
    );
  } catch (err) {
    console.warn(`[archive] could not release the claim on ${competitorId}: ${errorText(err)}`);
  }
}

async function archiveOne(competitorId: string, cutoff: string): Promise<Outcome> {
  const token = randomUUID();
  const claimed = await claim(competitorId, cutoff, token);
  if (!claimed) return "skipped";
  const storage = getStorage();
  const object = archiveObjectPath(competitorId);
  const archivePath = `${ARCHIVE_BUCKET}/${object}`;
  const hash = sha256(claimed.content);

  try {
    await storage.putObject(ARCHIVE_BUCKET, object, claimed.content);
    const back = await storage.getObject(ARCHIVE_BUCKET, object);
    if (back.length !== claimed.content.length || sha256(back) !== hash) {
      throw new Error(`read-back differs (${back.length} bytes, expected ${claimed.content.length})`);
    }
  } catch (err) {
    await release(competitorId, token);
    if (err instanceof StorageNotConfiguredError) throw err;
    console.warn(`[archive] page ${competitorId} not archived: ${errorText(err)}`);
    return "failed";
  }

  let outcome: Outcome | "gone";
  try {
    outcome = await withTx(async (tx) => {
      const { rows } = await tx.query<{ sha: string | null; stamp: string; claim: string | null; live: boolean }>(
        `select encode(sha256(content), 'hex') as sha,
                updated_at::text as stamp,
                data->>'archiveClaim' as claim,
                coalesce((data->>'archiveClaimUntil')::timestamptz > now(), false) as live
           from recreated_pages
          where competitor_id = $1
            for update`,
        [competitorId],
      );
      const row = rows[0];
      if (!row) return "gone" as const;
      // Changed (or archived, or claimed by another run after our lease ran out) since we read it.
      if (row.sha !== hash || row.stamp !== claimed.stamp || row.claim !== token || !row.live) {
        return "skipped" as const;
      }
      await tx.query(
        `update recreated_pages
            set content = null,
                archive_path = $2,
                archived_at = now(),
                data = data - 'archiveClaim' - 'archiveClaimUntil'
          where competitor_id = $1`,
        [competitorId, archivePath],
      );
      return "archived" as const;
    });
  } catch (err) {
    await release(competitorId, token);
    console.warn(`[archive] page ${competitorId} not archived: ${errorText(err)}`);
    return "failed";
  }

  if (outcome === "gone") {
    // Deleted while uploading: the upload must not stay behind.
    await deleteArchivedFor([competitorId]);
    return "skipped";
  }
  if (outcome === "skipped") await release(competitorId, token);
  return outcome;
}

/**
 * Moves page content last changed more than `olderThanDays` ago (default
 * RECREATED_PAGE_ARCHIVE_DAYS, else 14) to Storage, oldest first, in batches,
 * until none is left or the time budget is used. A page that fails stays in
 * the database and is tried once per call. Safe to run twice at once.
 * Throws StorageNotConfiguredError when Storage has no settings.
 */
export async function archiveOldPages(
  opts: { olderThanDays?: number; now?: Date } = {},
): Promise<{ archived: number; failed: number }> {
  if (!storageConfigured()) throw new StorageNotConfiguredError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const days = opts.olderThanDays ?? windowDays();
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 24 * HOUR_MS).toISOString();
  const started = Date.now();
  const tried: string[] = [];
  let archived = 0;
  let failed = 0;

  while (Date.now() - started < TIME_BUDGET_MS) {
    const { rows } = await getDb().query<{ competitor_id: string }>(
      `select competitor_id from recreated_pages
        where content is not null
          and updated_at <= $1::timestamptz
          and not (competitor_id = any($2::text[]))
          and ${CLAIM_FREE}
        order by updated_at, competitor_id
        limit $3`,
      [cutoff, tried, BATCH],
    );
    if (!rows.length) break;
    for (const { competitor_id: id } of rows) {
      if (Date.now() - started >= TIME_BUDGET_MS) break;
      tried.push(id);
      const outcome = await archiveOne(id, cutoff);
      if (outcome === "archived") archived += 1;
      else if (outcome === "failed") failed += 1;
    }
  }
  return { archived, failed };
}

/**
 * Deletes the archive objects of these competitors (best effort: a failure is
 * logged, never thrown). Call it after the transaction that deleted their rows
 * has committed. Objects that do not exist are fine.
 */
export async function deleteArchivedFor(competitorIds: string[]): Promise<void> {
  const ids = [...new Set(competitorIds)];
  if (!ids.length || !storageConfigured()) return;
  const storage = getStorage();
  const results = await mapPool(ids, DELETE_CONCURRENCY, (id) => storage.deleteObject(ARCHIVE_BUCKET, archiveObjectPath(id)));
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length) {
    console.warn(
      `[archive] ${failures.length} of ${ids.length} archive object(s) could not be deleted: ${errorText(failures[0].reason)}`,
    );
  }
}

/* ── scheduler ── */

let ticking = false;
let schedulerStarted = false;

/** One scheduled run; null when the previous one is still going or it failed (logged). */
export async function archiveTick(): Promise<{ archived: number; failed: number } | null> {
  if (ticking) return null;
  ticking = true;
  try {
    const result = await archiveOldPages();
    if (result.archived || result.failed) {
      console.log(`[archive] archived ${result.archived} page(s), ${result.failed} failed`);
    }
    return result;
  } catch (err) {
    console.error(`[archive] run failed: ${errorText(err)}`);
    return null;
  } finally {
    ticking = false;
  }
}

/**
 * Archives old pages hourly, first 60 s after start. Off (one log line, false)
 * when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. Timers are unref'd.
 */
export function startArchiveScheduler(): boolean {
  if (schedulerStarted) return true;
  if (!storageConfigured()) {
    console.log("[archive] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set: recreated pages are not archived");
    return false;
  }
  schedulerStarted = true;
  const first = setTimeout(() => {
    void archiveTick();
    const every = setInterval(() => void archiveTick(), HOUR_MS);
    every.unref();
  }, FIRST_RUN_DELAY_MS);
  first.unref();
  return true;
}
