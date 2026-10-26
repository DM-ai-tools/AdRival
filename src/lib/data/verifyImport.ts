import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { RECREATED_PAGE_HEAVY_KEYS, type DatabaseShape } from "../types";
import { fetchArchived } from "./archive";
import type { Queryable } from "./client";
import { storageConfigured } from "./storageClient";
import {
  CUTOVER_MESSAGE,
  MARKER_KEYS,
  isoTime,
  pageTime,
  planCounts,
  planImport,
  withoutMarker,
  type ImportPlan,
} from "./importStore";

/*
 * Checks a database against the store.json it was imported from (the cutover
 * gate). Expectations come from the import's own plan (migrateDb, first copy
 * per id, newest ICP per stage, first provider call per key, NOT NULL skips),
 * so every difference is either explained by the plan or reported:
 *
 * - every row's `data` against the expected record, by sha-256 of canonical
 *   (key-sorted) JSON, in every collection (competitors: the light page with
 *   the marker the import adds; interrupted runs: their failed form);
 * - every column copied from the record (owner, space, org, status, run,
 *   provider, user, period, seq, timestamps, ...) against its source field;
 * - every recreated page's content (from the row or from Storage): byte
 *   length, the bytes column and sha-256, plus its updated_at;
 * - credit period counters, ledger counts and sums per user, sequences;
 * - the file's array lengths against what was written: each record the import
 *   left out must be one the plan left out. Collapses (a later copy of an id,
 *   a later provider call with a used key, an older ICP of a stage, repeated
 *   seen ids) are listed in `skipped`; a record the database could not hold
 *   (lost data) is a mismatch.
 *
 * Never throws: a check that fails to run is reported as a mismatch.
 * Reads every page's content one at a time (archived pages from Storage).
 */

export interface VerifyResult {
  ok: boolean;
  mismatches: string[];
  /** Records the import left out on purpose (collapses), one line each. Not mismatches. */
  skipped: string[];
}

type AnyRecord = Record<string, unknown>;

/** How many ids one mismatch line lists (all are counted). */
const LIST_IDS = 20;

function listIds(ids: string[]): string {
  const shown = ids.slice(0, LIST_IDS).join(", ");
  return ids.length > LIST_IDS ? `${shown}, … (${ids.length} in all)` : shown;
}

/** JSON with object keys sorted (undefined members left out, as JSON.stringify does). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as AnyRecord)
      .filter((key) => (value as AnyRecord)[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as AnyRecord)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The content a page in the file carries, built the way the import splits it
 * (heavy keys in their fixed order, html defaulting to null), or null when it
 * carries none (no content row is expected).
 */
export function expectedHeavy(page: unknown): AnyRecord | null {
  if (!isRecord(page)) return null;
  const heavy: AnyRecord = {};
  let carries = false;
  for (const key of RECREATED_PAGE_HEAVY_KEYS) {
    if (!(key in page)) continue;
    carries = true;
    if (page[key] !== undefined) heavy[key] = page[key];
  }
  if (!carries) return null;
  const full: AnyRecord = { ...heavy, html: heavy.html ?? null };
  const images = full.generatedImages;
  const hasContent = Boolean(
    full.html || full.previousHtml || full.sourceArchive || (Array.isArray(images) && images.length > 0),
  );
  return hasContent ? full : null;
}

/** The competitor row's `data` the import writes: light page plus marker, run id fixed. */
function expectedCompetitor(competitor: AnyRecord): AnyRecord {
  const out: AnyRecord = { ...competitor };
  if (!("recreatedPage" in competitor) || competitor.recreatedPage === undefined) {
    delete out.recreatedPage;
    return out;
  }
  const page = withoutMarker(competitor.recreatedPage);
  if (!isRecord(page)) {
    out.recreatedPage = null;
    return out;
  }
  const heavy = expectedHeavy(page);
  const light: AnyRecord = { ...page };
  for (const key of RECREATED_PAGE_HEAVY_KEYS) delete light[key];
  for (const key of MARKER_KEYS) delete light[key];
  out.recreatedPage = heavy
    ? { ...light, hasPage: true, pageBytes: Buffer.byteLength(JSON.stringify(heavy)), pageUpdatedAt: pageTime(page, competitor) }
    : { ...light, hasPage: false, pageBytes: 0, pageUpdatedAt: null };
  return out;
}

type Kind = "text" | "int" | "time";

interface Column {
  /** Name in messages; also the SQL alias. */
  name: string;
  /** SQL for the column's value (text, a number, or the time as an ISO string). */
  sql: string;
  kind: Kind;
  /** The value the record says it should have; `undefined` skips the check (e.g. a time the import set to now()). */
  want: (record: AnyRecord) => unknown;
}

interface Spec {
  name: string;
  table: string;
  /** SQL for the row key (text). */
  key: string;
  records: Array<{ key: string; record: AnyRecord }>;
  /** The expected `data` (default: the record itself). `row` is the stored data. */
  expect?: (record: AnyRecord, row: AnyRecord) => unknown;
  columns: Column[];
  /** Tables without a data column compare keys only. */
  noData?: boolean;
}

const TIME_SQL = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const text = (name: string, sql: string, want: Column["want"]): Column => ({ name, sql, kind: "text", want });
const int = (name: string, sql: string, want: Column["want"]): Column => ({ name, sql: `${sql}::text`, kind: "int", want });
/**
 * A timestamptz column. `nullable` columns hold null when the record has no
 * time; the others were filled with now() then, which is not checked.
 */
const time = (name: string, col: string, want: (r: AnyRecord) => unknown, nullable = false): Column => ({
  name,
  sql: TIME_SQL(col),
  kind: "time",
  want: (r) => isoTime(want(r)) ?? (nullable ? null : undefined),
});

function sameValue(kind: Kind, got: unknown, want: unknown): boolean {
  if (want === undefined) return true;
  if (kind === "int") return got !== null && got !== undefined && Number(got) === Number(want);
  if (want === null) return got === null || got === undefined;
  return String(got) === String(want);
}

async function checkTable(db: Queryable, spec: Spec, mismatches: string[]): Promise<void> {
  const cols = spec.columns.map((c) => `${c.sql} as "${c.name}"`);
  const select = [`${spec.key} as k`, ...(spec.noData ? [] : ["data"]), ...cols].join(", ");
  const { rows } = await db.query<AnyRecord & { k: string; data: AnyRecord }>(`select ${select} from ${spec.table}`);
  const stored = new Map(rows.map((r) => [String(r.k), r]));
  const wanted = new Map(spec.records.map((r) => [r.key, r.record]));

  const missing = [...wanted.keys()].filter((k) => !stored.has(k));
  const extra = [...stored.keys()].filter((k) => !wanted.has(k));
  if (stored.size !== wanted.size) mismatches.push(`${spec.name}: ${stored.size} row(s) in the database, ${wanted.size} expected`);
  if (missing.length) mismatches.push(`${spec.name}: missing ${missing.length}: ${listIds(missing)}`);
  if (extra.length) mismatches.push(`${spec.name}: not in the store ${extra.length}: ${listIds(extra)}`);

  const dataDiffers: string[] = [];
  const columnDiffers = new Map<string, string[]>();
  for (const [key, record] of wanted) {
    const row = stored.get(key);
    if (!row) continue;
    if (!spec.noData) {
      const expected = spec.expect ? spec.expect(record, row.data) : record;
      if (sha256(canonical(row.data)) !== sha256(canonical(expected))) dataDiffers.push(key);
    }
    for (const column of spec.columns) {
      const want = column.want(record);
      if (!sameValue(column.kind, row[column.name], want)) {
        const ids = columnDiffers.get(column.name) ?? [];
        ids.push(`${key} (${String(row[column.name])} ≠ ${String(want)})`);
        columnDiffers.set(column.name, ids);
      }
    }
  }
  if (dataDiffers.length) {
    mismatches.push(`${spec.name}: data differs from the store for ${dataDiffers.length}: ${listIds(dataDiffers)}`);
  }
  for (const [column, ids] of columnDiffers) {
    mismatches.push(`${spec.name}.${column}: differs from the record for ${ids.length}: ${listIds(ids)}`);
  }
}

const field = (name: string) => (r: AnyRecord) => r[name] ?? null;
const keyed = <T>(rows: T[], key: (r: T) => string) =>
  rows.map((r) => ({ key: key(r), record: r as unknown as AnyRecord }));

export async function verifyImport(
  db: Queryable,
  store: DatabaseShape,
  opts: { log?: (message: string) => void } = {},
): Promise<VerifyResult> {
  const log = opts.log ?? (() => {});
  const mismatches: string[] = [];
  const skipped: string[] = [];
  const check = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
    } catch (err) {
      mismatches.push(`check "${name}" could not run: ${errorText(err)}`);
    }
  };

  // What the file said before migrateDb normalizes it in place.
  const raw = store as unknown as AnyRecord;
  const rawSchema = typeof raw?.schemaVersion === "number" ? raw.schemaVersion : 1;
  const hadSettings = isRecord(raw?.appSettings);
  const rawRuleVersions = new Set(
    (Array.isArray(raw?.conversionRuleSets) ? (raw.conversionRuleSets as AnyRecord[]) : []).map((s) => s?.version),
  );

  let plan: ImportPlan;
  try {
    plan = planImport(store);
  } catch (err) {
    return { ok: false, mismatches: [`the store could not be read: ${errorText(err)}`], skipped };
  }
  // Interrupted runs carry the import's time: plan again with it, so their
  // failed form is compared exactly.
  const interruptedIds = [...plan.prepared.interrupted];
  if (interruptedIds.length) {
    let at: string | null | undefined;
    try {
      const { rows } = await db.query<{ at: string | null }>(
        `select data->>'updatedAt' as at from jobs where id = any($1::text[])
         union all select data->>'updatedAt' as at from lookup_jobs where id = any($1::text[])`,
        [interruptedIds],
      );
      at = rows.find((r) => r.at)?.at;
    } catch (err) {
      return { ok: false, mismatches: [`database error while reading interrupted runs: ${errorText(err)}`], skipped };
    }
    if (at) {
      try {
        plan = planImport(store, at);
      } catch (err) {
        return { ok: false, mismatches: [`the store could not be read: ${errorText(err)}`], skipped };
      }
    }
  }
  const prepared = plan.prepared;

  /* 1. every record of the file is written or left out by the plan */
  await check("file vs plan", () => {
    const counts = planCounts(plan);
    const store2 = store as unknown as Record<string, unknown>;
    for (const [collection, expected] of Object.entries(counts)) {
      if (collection === "appSettings") continue;
      const rawLength = Array.isArray(store2[collection]) ? (store2[collection] as unknown[]).length : 0;
      const drops = plan.drops.filter((d) => d.collection === collection);
      if (rawLength - drops.length !== expected) {
        mismatches.push(
          `${collection}: ${rawLength} in the file, ${drops.length} left out, but ${expected} to write (unexplained difference)`,
        );
      }
    }
    for (const d of plan.drops) {
      const line = `${d.collection} ${d.id}: ${d.reason}`;
      if (d.lost) mismatches.push(`lost (not imported): ${line}`);
      else skipped.push(line);
    }
  });

  /* 2. every row's data and copied columns */
  const orgOf = new Map(plan.users.map((u) => [u.id, u.orgId ?? null]));
  const jobOwner = new Map(prepared.jobs.map((j) => [j.id, j.ownerUserId ?? null]));
  const specs: Spec[] = [
    {
      name: "organizations",
      table: "organizations",
      key: "id",
      records: keyed(prepared.organizations, (r) => r.id),
      columns: [time("archived_at", "archived_at", (r) => r.archivedAt || null, true)],
    },
    {
      name: "users",
      table: "users",
      key: "id",
      records: keyed(plan.users, (r) => r.id),
      columns: [
        text("username", "username", field("username")),
        text("lower_username", "lower(username)", (r) => String(r.username).toLowerCase()),
        text("org_id", "org_id", field("orgId")),
        text("role", "role", field("role")),
        text("status", "status", field("status")),
      ],
    },
    {
      name: "appSettings",
      table: "app_settings",
      key: "id",
      records: prepared.appSettings ? [{ key: "singleton", record: prepared.appSettings as unknown as AnyRecord }] : [],
      // Settings migrateDb created or changed carry the time of that run.
      expect: (r, row) => (rawSchema < 4 || !hadSettings ? { ...r, updatedAt: row.updatedAt } : r),
      columns: [],
    },
    {
      name: "conversionRuleSets",
      table: "conversion_rule_sets",
      key: "version::text",
      records: keyed(prepared.conversionRuleSets, (r) => String(r.version)),
      // A rule set migrateDb added (seed or softened) carries the time of that run.
      expect: (r, row) => (rawRuleVersions.has(r.version) ? r : { ...r, createdAt: row.createdAt }),
      columns: [],
    },
    {
      name: "projectSpaces",
      table: "project_spaces",
      key: "id",
      records: keyed(plan.projectSpaces, (r) => r.id),
      columns: [
        text("org_id", "org_id", (r) => orgOf.get(String(r.ownerUserId)) ?? null),
        text("owner_user_id", "owner_user_id", field("ownerUserId")),
        time("archived_at", "archived_at", (r) => r.archivedAt || null, true),
      ],
    },
    {
      name: "spaceMemberships",
      table: "space_memberships",
      key: "id",
      records: keyed(plan.spaceMemberships, (r) => r.id),
      columns: [text("space_id", "space_id", field("spaceId")), text("user_id", "user_id", field("userId"))],
    },
    {
      name: "projectMemberships",
      table: "project_memberships",
      key: "id",
      records: keyed(plan.projectMemberships, (r) => r.id),
      columns: [
        text("project_kind", "project_kind", field("projectKind")),
        text("project_id", "project_id", field("projectId")),
        text("user_id", "user_id", field("userId")),
      ],
    },
    {
      name: "creditPeriods",
      table: "credit_periods",
      key: "id",
      records: keyed(plan.creditPeriods, (r) => r.id),
      columns: [
        text("user_id", "user_id", field("userId")),
        text("status", "status", field("status")),
        int("allowance", "allowance", field("allowanceSubunits")),
        int("consumed", "consumed", field("consumedSubunits")),
        int("reserved", "reserved", field("reservedSubunits")),
      ],
    },
    {
      name: "creditReservations",
      table: "credit_reservations",
      key: "id",
      records: keyed(plan.creditReservations, (r) => r.id),
      columns: [
        text("user_id", "user_id", field("userId")),
        text("period_id", "period_id", field("periodId")),
        text("status", "status", field("status")),
        time("expires_at", "expires_at", field("expiresAt")),
      ],
    },
    {
      name: "creditLedger",
      table: "credit_ledger",
      key: "id",
      records: keyed(plan.creditLedger, (r) => r.id),
      columns: [
        int("seq", "seq", field("seq")),
        text("user_id", "user_id", field("userId")),
        text("period_id", "period_id", field("periodId")),
        time("created_at", "created_at", field("createdAt")),
      ],
    },
    {
      name: "providerCalls",
      table: "provider_calls",
      key: "id",
      records: keyed(plan.providerCalls, (r) => r.id),
      columns: [
        text("user_id", "user_id", field("chargedUserId")),
        text("run_id", "run_id", field("runId")),
        text("provider", "provider", field("provider")),
        time("created_at", "created_at", field("startedAt")),
      ],
    },
    {
      name: "auditLogs",
      table: "audit_logs",
      key: "id",
      records: keyed(prepared.auditLogs, (r) => r.id),
      columns: [int("seq", "seq", field("seq")), time("created_at", "created_at", field("createdAt"))],
    },
    {
      name: "adminAlerts",
      table: "admin_alerts",
      key: "id",
      records: keyed(prepared.adminAlerts, (r) => r.id),
      columns: [time("created_at", "created_at", field("createdAt"))],
    },
    {
      name: "loginAttempts",
      table: "login_attempts",
      key: "id",
      records: keyed(prepared.loginAttempts, (r) => r.key),
      columns: [time("created_at", "created_at", field("firstAttemptAt"))],
    },
    ...(["jobs", "lookupJobs"] as const).map(
      (name): Spec => ({
        name,
        table: name === "jobs" ? "jobs" : "lookup_jobs",
        key: "id",
        records: keyed<{ id: string }>(plan[name], (r) => r.id),
        columns: [
          text("owner_user_id", "owner_user_id", field("ownerUserId")),
          text("space_id", "space_id", field("spaceId")),
          text("status", "status", field("status")),
          time("created_at", "created_at", field("createdAt")),
        ],
      }),
    ),
    {
      name: "competitors",
      table: "competitors",
      key: "id",
      records: keyed(plan.competitors, (r) => r.id),
      expect: (r) => expectedCompetitor(r),
      columns: [
        text("run_id", "run_id", field("runId")),
        text("owner_user_id", "owner_user_id", (r) => jobOwner.get(String(r.runId)) ?? null),
        time("created_at", "created_at", field("createdAt")),
      ],
    },
    {
      name: "lookupAds",
      table: "lookup_ads",
      key: "id",
      records: keyed(plan.lookupAds, (r) => r.id),
      columns: [text("lookup_id", "lookup_id", field("lookupId"))],
    },
    {
      name: "searchCompetitorAds",
      table: "search_competitor_ads",
      key: "id",
      records: keyed(plan.searchCompetitorAds, (r) => r.id),
      columns: [text("run_id", "run_id", field("runId")), text("competitor_id", "competitor_id", field("competitorId"))],
    },
    {
      name: "icps",
      table: "icps",
      key: "id",
      records: keyed(plan.icps, (r) => r.id),
      columns: [
        text("source_kind", "source_kind", (r) => (r.source as AnyRecord | undefined)?.kind ?? null),
        text("source_id", "source_id", (r) => (r.source as AnyRecord | undefined)?.id ?? null),
        text("stage", "stage", field("stage")),
      ],
    },
    {
      name: "seenPageIds",
      table: "seen_page_ids",
      key: "id",
      records: prepared.seenPageIds.map((id) => ({ key: id, record: {} })),
      columns: [],
      noData: true,
    },
    {
      name: "deletedRunIds",
      table: "deleted_run_ids",
      key: "id",
      records: prepared.deletedRunIds.map((id) => ({ key: id, record: {} })),
      columns: [],
      noData: true,
    },
  ];
  for (const spec of specs) {
    await check(spec.name, () => checkTable(db, spec, mismatches));
  }
  log(`rows, data and columns checked (${mismatches.length} mismatch line(s) so far)`);

  /* 3. credentials, roles and run states, by name (also covered by the data hash) */
  await check("users", async () => {
    const { rows } = await db.query<{ id: string; data: AnyRecord }>("select id, data from users");
    const byId = new Map(rows.map((r) => [r.id, r.data]));
    for (const user of plan.users) {
      const data = byId.get(user.id);
      if (!data) continue;
      if (data.passwordHash !== user.passwordHash) mismatches.push(`users ${user.id}: password hash differs`);
      if (data.role !== user.role) mismatches.push(`users ${user.id}: role ${String(data.role)}, expected ${user.role}`);
    }
  });
  for (const [name, table] of [
    ["jobs", "jobs"],
    ["lookupJobs", "lookup_jobs"],
  ] as const) {
    await check(`${name} interrupted`, async () => {
      const { rows } = await db.query<{ id: string; status: string; data: AnyRecord }>(
        `select id, status, data from ${table} where id = any($1::text[])`,
        [[...prepared.interrupted]],
      );
      for (const row of rows) {
        const progress = isRecord(row.data.progress) ? row.data.progress : {};
        if (row.status !== "failed" || progress.message !== CUTOVER_MESSAGE || progress.stage !== "failed") {
          mismatches.push(`${name} ${row.id}: was running; expected failed with "${CUTOVER_MESSAGE}"`);
        }
      }
    });
  }

  /* 4. ledger sums per user and the sequences */
  await check("ledger sums", async () => {
    const sum = (rows: AnyRecord[]) => {
      const out = new Map<string, { n: number; sum: number }>();
      for (const entry of rows) {
        const user = String(entry.userId);
        const held = out.get(user) ?? { n: 0, sum: 0 };
        held.n += 1;
        held.sum += typeof entry.deltaSubunits === "number" ? entry.deltaSubunits : 0;
        out.set(user, held);
      }
      return out;
    };
    const want = sum(plan.creditLedger as unknown as AnyRecord[]);
    const { rows } = await db.query<{ data: AnyRecord }>("select data from credit_ledger");
    const got = sum(rows.map((r) => r.data));
    for (const userId of new Set([...want.keys(), ...got.keys()])) {
      const a = got.get(userId) ?? { n: 0, sum: 0 };
      const b = want.get(userId) ?? { n: 0, sum: 0 };
      if (a.n !== b.n || a.sum !== b.sum) {
        mismatches.push(`creditLedger user ${userId}: ${a.n} entries summing ${a.sum}, expected ${b.n} summing ${b.sum}`);
      }
    }
  });
  for (const [sequence, table, counter] of [
    ["ledger_seq", "credit_ledger", prepared.ledgerSeq],
    ["audit_seq", "audit_logs", prepared.auditSeq],
  ] as const) {
    await check(sequence, async () => {
      const { rows } = await db.query<{ last: string; called: boolean; max: string }>(
        `select s.last_value::text as last, s.is_called as called, (select coalesce(max(seq), 0) from ${table})::text as max
           from ${sequence} s`,
      );
      const row = rows[0];
      // The last value handed out (or about to be: not called yet means nextval returns last_value).
      const used = Number(row.last) - (row.called ? 0 : 1);
      if (used < Number(row.max) || used < counter) {
        mismatches.push(`${sequence}: next value ${used + 1} is not past max seq ${row.max} and the stored counter ${counter}`);
      }
    });
  }

  /* 5. recreated pages: every content byte, by length and hash */
  await check("recreated pages", async () => {
    const { rows: stored } = await db.query<{ id: string; at: string }>(
      `select competitor_id as id, ${TIME_SQL("updated_at")} as at from recreated_pages`,
    );
    const rowAt = new Map(stored.map((r) => [r.id, r.at]));
    let checked = 0;
    // Archived content lives in Storage; without its settings it cannot be read.
    const storageReady = storageConfigured();
    const archivedUnchecked: string[] = [];
    for (const competitor of plan.competitors) {
      await check(`page ${competitor.id}`, async () => {
        const page = withoutMarker(competitor.recreatedPage);
        const heavy = expectedHeavy(page);
        if (!heavy) {
          if (rowAt.has(competitor.id)) mismatches.push(`recreatedPages ${competitor.id}: content stored, but the file has none`);
          return;
        }
        if (!rowAt.has(competitor.id)) {
          mismatches.push(`recreatedPages ${competitor.id}: content missing`);
          return;
        }
        const wantAt = pageTime(page, competitor);
        if (rowAt.get(competitor.id) !== wantAt) {
          mismatches.push(`recreatedPages ${competitor.id}: updated_at ${rowAt.get(competitor.id)}, expected ${wantAt}`);
        }
        const { rows } = await db.query<{ content: Buffer | Uint8Array | null; archive_path: string | null; bytes: number }>(
          "select content, archive_path, bytes from recreated_pages where competitor_id = $1",
          [competitor.id],
        );
        const row = rows[0];
        if (!row.content && row.archive_path && !storageReady) {
          // Reported once below, not as one "unreadable" line per page.
          archivedUnchecked.push(competitor.id);
          return;
        }
        let textContent: string;
        try {
          const gz = row.content ? Buffer.from(row.content) : await fetchArchived(String(row.archive_path));
          textContent = gunzipSync(gz).toString("utf8");
        } catch (err) {
          mismatches.push(`recreatedPages ${competitor.id}: content unreadable (${errorText(err)})`);
          return;
        }
        const wantBytes = Buffer.byteLength(JSON.stringify(heavy));
        const gotBytes = Buffer.byteLength(textContent);
        if (gotBytes !== wantBytes) mismatches.push(`recreatedPages ${competitor.id}: ${gotBytes} content bytes, expected ${wantBytes}`);
        if (Number(row.bytes) !== wantBytes) {
          mismatches.push(`recreatedPages ${competitor.id}: bytes column ${row.bytes}, expected ${wantBytes}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(textContent);
        } catch {
          mismatches.push(`recreatedPages ${competitor.id}: content is not valid JSON`);
          return;
        }
        if (sha256(canonical(parsed)) !== sha256(canonical(heavy))) {
          mismatches.push(`recreatedPages ${competitor.id}: content differs from the file (sha-256)`);
        }
        checked += 1;
      });
    }
    // Content rows of competitors the file does not have.
    const known = new Set(plan.competitors.map((c) => c.id));
    const orphans = [...rowAt.keys()].filter((id) => !known.has(id));
    if (orphans.length) mismatches.push(`recreatedPages: content of unknown competitors ${orphans.length}: ${listIds(orphans)}`);
    if (archivedUnchecked.length) {
      mismatches.unshift(
        `archived pages cannot be checked: Storage not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ` +
          `of the database's Supabase project); ${archivedUnchecked.length} archived page(s) not checked: ${listIds(archivedUnchecked)}`,
      );
    }
    log(`recreated pages checked: ${checked}`);
  });

  return { ok: mismatches.length === 0, mismatches, skipped };
}
