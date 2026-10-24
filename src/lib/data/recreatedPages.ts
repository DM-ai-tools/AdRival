import { gunzipSync, gzipSync } from "node:zlib";

import {
  RECREATED_PAGE_HEAVY_KEYS,
  type RecreatedLandingPage,
  type RecreatedPageHeavy,
  type RecreatedPageLight,
} from "../types";
import { ArchivedPageUnavailableError, fetchArchived } from "./archive";
import { getDb, withTx, type Queryable } from "./client";
import { lockRun } from "./runs";

/*
 * Recreated page content (html, sourceArchive, generatedImages, previousHtml)
 * lives in `recreated_pages`, gzip of its JSON, one row per competitor. The
 * competitor row keeps the light fields plus a marker (hasPage, pageBytes,
 * pageUpdatedAt), so list and history reads never touch this table. Content is
 * either in the row (`content`) or archived to Storage (`archive_path`).
 */

export type PageMarker = Pick<RecreatedPageLight, "hasPage" | "pageBytes" | "pageUpdatedAt">;

const NO_PAGE: PageMarker = { hasPage: false, pageBytes: 0, pageUpdatedAt: null };
const MARKER_KEYS = ["hasPage", "pageBytes", "pageUpdatedAt"] as const;

/** A page as callers pass it: today's full page, or a light one. */
export type IncomingPage = RecreatedLandingPage | RecreatedPageLight;

/** What to do with the content row after the competitor row is written. */
export type HeavyAction =
  | { kind: "keep" }
  | { kind: "delete" }
  | { kind: "write"; content: Buffer; bytes: number; at: string };

/** The marker a stored light page carries (no page when it has none). */
export function markerOf(page: unknown): PageMarker {
  if (!page || typeof page !== "object") return NO_PAGE;
  const p = page as Partial<PageMarker>;
  if (typeof p.hasPage !== "boolean") return NO_PAGE;
  return {
    hasPage: p.hasPage,
    pageBytes: typeof p.pageBytes === "number" ? p.pageBytes : 0,
    pageUpdatedAt: typeof p.pageUpdatedAt === "string" ? p.pageUpdatedAt : null,
  };
}

function hasContent(heavy: RecreatedPageHeavy): boolean {
  return Boolean(
    heavy.html ||
      heavy.previousHtml ||
      heavy.sourceArchive ||
      (Array.isArray(heavy.generatedImages) && heavy.generatedImages.length > 0),
  );
}

/**
 * Light fields of a page (heavy and marker keys removed), and its heavy fields
 * when it carries any. A page with marker keys is a light page read back from
 * the store; heavy keys on it would replace only part of the content (the
 * stored fields it lacks would be lost), so that is refused.
 */
function splitPage(
  page: IncomingPage,
  heavyGivenApart: boolean,
): {
  light: Omit<RecreatedPageLight, keyof PageMarker>;
  heavy: RecreatedPageHeavy | undefined;
} {
  const rest: Record<string, unknown> = { ...page };
  const heavy: Record<string, unknown> = {};
  let carriesHeavy = false;
  for (const key of RECREATED_PAGE_HEAVY_KEYS) {
    if (!(key in rest)) continue;
    carriesHeavy = true;
    if (rest[key] !== undefined) heavy[key] = rest[key];
    delete rest[key];
  }
  const isLight = MARKER_KEYS.some((key) => key in rest);
  // With the content passed apart, heavy keys on the page are ignored.
  if (carriesHeavy && isLight && !heavyGivenApart) {
    throw new Error(
      "A light recreatedPage cannot carry page content (html, sourceArchive, generatedImages, previousHtml): " +
        "write the whole content with setRecreatedPage (or recreatedPageHeavy) instead.",
    );
  }
  for (const key of MARKER_KEYS) delete rest[key];
  return {
    light: rest as Omit<RecreatedPageLight, keyof PageMarker>,
    // A full (legacy) page replaces the whole content; html keeps null vs "".
    heavy: carriesHeavy ? ({ ...heavy, html: heavy.html ?? null } as RecreatedPageHeavy) : undefined,
  };
}

/**
 * A page row value for content stored without a light page: the marker alone,
 * so `hasPage` never reads false while content exists.
 */
function markerOnly(marker: PageMarker): RecreatedPageLight | null {
  return marker.hasPage ? (marker as RecreatedPageLight) : null;
}

function heavyAction(heavy: RecreatedPageHeavy, rowMayExist: boolean): { action: HeavyAction; marker: PageMarker } {
  if (!hasContent(heavy)) {
    return { action: rowMayExist ? { kind: "delete" } : { kind: "keep" }, marker: NO_PAGE };
  }
  const json = JSON.stringify(heavy);
  const bytes = Buffer.byteLength(json);
  const at = new Date().toISOString();
  return {
    action: { kind: "write", content: gzipSync(json), bytes, at },
    marker: { hasPage: true, pageBytes: bytes, pageUpdatedAt: at },
  };
}

/**
 * Decides the light page to store on the competitor row and what happens to
 * its content row. Pure: the caller writes the competitor row first (the
 * content row references it), then calls applyHeavy.
 *
 * - `explicitHeavy` (the new API) wins over heavy keys inside `incoming` and
 *   replaces the whole stored content.
 * - A full (legacy) page in `incoming` replaces the whole stored content.
 * - A light page carrying heavy keys throws (see splitPage) unless
 *   `explicitHeavy` is given.
 * - No heavy at all keeps the stored content and its marker.
 * - An undefined page keeps the stored page and content as they are.
 * - A null page drops the content row.
 * - Content without a light page gets a marker-only page.
 * `stored` is the page currently on the row (undefined for none); `existed`
 * whether the competitor row exists (a new one has no content row to delete).
 */
export function planPage(
  incoming: IncomingPage | null | undefined,
  explicitHeavy: RecreatedPageHeavy | undefined,
  stored: RecreatedPageLight | RecreatedLandingPage | null | undefined,
  existed: boolean,
): { page: RecreatedPageLight | null | undefined; action: HeavyAction } {
  if (!incoming) {
    if (explicitHeavy) {
      const { action, marker } = heavyAction(explicitHeavy, existed);
      const keepLight = incoming === undefined && stored && typeof stored === "object";
      return { page: keepLight ? { ...(stored as RecreatedPageLight), ...marker } : markerOnly(marker), action };
    }
    if (incoming === undefined) return { page: stored as RecreatedPageLight | null | undefined, action: { kind: "keep" } };
    return { page: null, action: existed ? { kind: "delete" } : { kind: "keep" } };
  }
  const { light, heavy: inline } = splitPage(incoming, explicitHeavy !== undefined);
  const heavy = explicitHeavy ?? inline;
  if (!heavy) return { page: { ...light, ...markerOf(stored) }, action: { kind: "keep" } };
  const { action, marker } = heavyAction(heavy, existed);
  return { page: { ...light, ...marker }, action };
}

/** Writes or removes the content row (the competitor row must exist). */
export async function applyHeavy(tx: Queryable, competitorId: string, action: HeavyAction): Promise<void> {
  if (action.kind === "keep") return;
  if (action.kind === "delete") {
    await tx.query("delete from recreated_pages where competitor_id = $1", [competitorId]);
    return;
  }
  await tx.query(
    `insert into recreated_pages (competitor_id, content, archive_path, bytes, updated_at, archived_at)
     values ($1, $2, null, $3, $4::timestamptz, null)
     on conflict (competitor_id) do update set
       content      = excluded.content,
       archive_path = null,
       bytes        = excluded.bytes,
       updated_at   = excluded.updated_at,
       archived_at  = null`,
    [competitorId, action.content, action.bytes, action.at],
  );
}

function decode(gz: Buffer | Uint8Array): RecreatedPageHeavy {
  return JSON.parse(gunzipSync(Buffer.from(gz)).toString("utf8")) as RecreatedPageHeavy;
}

/**
 * The page content for one competitor, or null when none is stored. An
 * archived page is fetched from Storage; when that fails this throws
 * ArchivedPageUnavailableError.
 */
export function getRecreatedPage(competitorId: string): Promise<RecreatedPageHeavy | null> {
  return readRecreatedPage(getDb(), competitorId, false);
}

/** getRecreatedPage on a given handle; `forUpdate` locks the content row (inside a transaction). */
export async function readRecreatedPage(
  q: Queryable,
  competitorId: string,
  forUpdate: boolean,
): Promise<RecreatedPageHeavy | null> {
  const { rows } = await q.query<{ content: Buffer | Uint8Array | null; archive_path: string | null }>(
    `select content, archive_path from recreated_pages where competitor_id = $1${forUpdate ? " for update" : ""}`,
    [competitorId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.content) return decode(row.content);
  const path = row.archive_path as string;
  let gz: Buffer;
  try {
    gz = await fetchArchived(path);
  } catch (err) {
    if (err instanceof ArchivedPageUnavailableError) throw err;
    throw new ArchivedPageUnavailableError(`archived page for ${competitorId} could not be read`, { cause: err });
  }
  try {
    return decode(gz);
  } catch (err) {
    throw new ArchivedPageUnavailableError(`archived page for ${competitorId} is corrupt`, { cause: err });
  }
}

/**
 * Replaces the whole stored content of a competitor's page with `heavy` (a
 * field left out is gone afterwards) and moves it back into the database
 * (clears archive_path and archived_at). Updates the marker on its light page;
 * a competitor without a light page gets a marker-only page. Returns false
 * when the competitor does not exist.
 */
export async function setRecreatedPage(competitorId: string, heavy: RecreatedPageHeavy): Promise<boolean> {
  return withTx(async (tx) => {
    const owner = await tx.query<{ run_id: string }>("select run_id from competitors where id = $1", [competitorId]);
    const runId = owner.rows[0]?.run_id;
    if (runId === undefined) return false;
    await lockRun(tx, runId);
    const { rows } = await tx.query("select 1 from competitors where id = $1 for update", [competitorId]);
    if (!rows.length) return false;
    const { action, marker } = heavyAction(heavy, true);
    await applyHeavy(tx, competitorId, action);
    await tx.query(
      `update competitors
          set data = jsonb_set(
                data,
                '{recreatedPage}',
                case when jsonb_typeof(data->'recreatedPage') = 'object'
                     then (data->'recreatedPage') || $2::jsonb
                     else $2::jsonb end)
        where id = $1 and (jsonb_typeof(data->'recreatedPage') = 'object' or $3::boolean)`,
      [competitorId, JSON.stringify(marker), marker.hasPage],
    );
    return true;
  });
}
