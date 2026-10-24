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

/** Light fields of a page (heavy and marker keys removed), and its heavy fields when it carries any. */
function splitPage(page: IncomingPage): {
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
  for (const key of MARKER_KEYS) delete rest[key];
  return {
    light: rest as Omit<RecreatedPageLight, keyof PageMarker>,
    heavy: carriesHeavy
      ? ({ ...heavy, html: typeof heavy.html === "string" ? heavy.html : "" } as RecreatedPageHeavy)
      : undefined,
  };
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
 * - `explicitHeavy` (the new API) wins over heavy keys inside `incoming`.
 * - Heavy keys inside `incoming` (today's callers) replace the stored content.
 * - No heavy at all keeps the stored content and its marker.
 * - A null page drops the content row.
 * `stored` is the light page currently on the row; `existed` whether the
 * competitor row exists (a new competitor has no content row to delete).
 */
export function planPage(
  incoming: IncomingPage | null | undefined,
  explicitHeavy: RecreatedPageHeavy | undefined,
  stored: unknown,
  existed: boolean,
): { page: RecreatedPageLight | null; action: HeavyAction } {
  if (!incoming) {
    if (explicitHeavy) return { page: null, action: heavyAction(explicitHeavy, existed).action };
    return { page: null, action: existed ? { kind: "delete" } : { kind: "keep" } };
  }
  const { light, heavy: inline } = splitPage(incoming);
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
export async function getRecreatedPage(competitorId: string): Promise<RecreatedPageHeavy | null> {
  const { rows } = await getDb().query<{ content: Buffer | Uint8Array | null; archive_path: string | null }>(
    "select content, archive_path from recreated_pages where competitor_id = $1",
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
 * Stores new content for a competitor's page (back in the database: clears
 * archive_path and archived_at) and updates the marker on its light page.
 * Returns false when the competitor does not exist. When the competitor has
 * no light page yet only the content row is written.
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
          set data = jsonb_set(data, '{recreatedPage}', (data->'recreatedPage') || $2::jsonb)
        where id = $1 and jsonb_typeof(data->'recreatedPage') = 'object'`,
      [competitorId, JSON.stringify(marker)],
    );
    return true;
  });
}
