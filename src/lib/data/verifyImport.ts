import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { RECREATED_PAGE_HEAVY_KEYS, type DatabaseShape } from "../types";
import { fetchArchived } from "./archive";
import type { Queryable } from "./client";
import { CUTOVER_MESSAGE, prepareStore } from "./importStore";

/*
 * Checks a database against the store.json it was imported from (cutover
 * verification). Expectations come from the same normalization the import
 * uses (migrateDb, one record per key, newest ICP per stage, first provider
 * call per idempotency key); a record the import had to skip shows up here as
 * a missing id. Never throws on a mismatch: each one is reported with ids.
 *
 * Reads every page's content one at a time (archived pages from Storage).
 */

export interface VerifyResult {
  ok: boolean;
  mismatches: string[];
}

type AnyRecord = Record<string, unknown>;

/** How many ids one mismatch line lists. */
const LIST_IDS = 20;

function listIds(ids: string[]): string {
  const shown = ids.slice(0, LIST_IDS).join(", ");
  return ids.length > LIST_IDS ? `${shown}, … (${ids.length} in all)` : shown;
}

/** JSON with object keys sorted, so equal content hashes equal whatever the key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
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

/**
 * The content a page in the file carries, built the way the import splits it
 * (heavy keys in their fixed order, html defaulting to null), or null when it
 * carries none (no content row is expected).
 */
export function expectedHeavy(page: unknown): AnyRecord | null {
  if (!page || typeof page !== "object") return null;
  const source = page as AnyRecord;
  const heavy: AnyRecord = {};
  let carries = false;
  for (const key of RECREATED_PAGE_HEAVY_KEYS) {
    if (!(key in source)) continue;
    carries = true;
    if (source[key] !== undefined) heavy[key] = source[key];
  }
  if (!carries) return null;
  const full: AnyRecord = { ...heavy, html: heavy.html ?? null };
  const images = full.generatedImages;
  const hasContent = Boolean(
    full.html || full.previousHtml || full.sourceArchive || (Array.isArray(images) && images.length > 0),
  );
  return hasContent ? full : null;
}

async function idsOf(db: Queryable, sql: string): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string | number }>(sql);
  return new Set(rows.map((r) => String(r.id)));
}

export async function verifyImport(
  db: Queryable,
  store: DatabaseShape,
  opts: { log?: (message: string) => void } = {},
): Promise<VerifyResult> {
  const log = opts.log ?? (() => {});
  const mismatches: string[] = [];
  const expected = prepareStore(store);

  /* row ids per collection */
  const collections: Array<{ name: string; sql: string; ids: string[] }> = [
    { name: "organizations", sql: "select id from organizations", ids: expected.organizations.map((r) => r.id) },
    { name: "users", sql: "select id from users", ids: expected.users.map((r) => r.id) },
    { name: "conversionRuleSets", sql: "select version as id from conversion_rule_sets", ids: expected.conversionRuleSets.map((r) => String(r.version)) },
    { name: "creditPeriods", sql: "select id from credit_periods", ids: expected.creditPeriods.map((r) => r.id) },
    { name: "creditLedger", sql: "select id from credit_ledger", ids: expected.creditLedger.map((r) => r.id) },
    { name: "creditReservations", sql: "select id from credit_reservations", ids: expected.creditReservations.map((r) => r.id) },
    { name: "providerCalls", sql: "select id from provider_calls", ids: expected.providerCalls.map((r) => r.id) },
    { name: "projectMemberships", sql: "select id from project_memberships", ids: expected.projectMemberships.map((r) => r.id) },
    { name: "projectSpaces", sql: "select id from project_spaces", ids: expected.projectSpaces.map((r) => r.id) },
    { name: "spaceMemberships", sql: "select id from space_memberships", ids: expected.spaceMemberships.map((r) => r.id) },
    { name: "auditLogs", sql: "select id from audit_logs", ids: expected.auditLogs.map((r) => r.id) },
    { name: "adminAlerts", sql: "select id from admin_alerts", ids: expected.adminAlerts.map((r) => r.id) },
    { name: "loginAttempts", sql: "select id from login_attempts", ids: expected.loginAttempts.map((r) => r.key) },
    { name: "jobs", sql: "select id from jobs", ids: expected.jobs.map((r) => r.id) },
    { name: "lookupJobs", sql: "select id from lookup_jobs", ids: expected.lookupJobs.map((r) => r.id) },
    { name: "competitors", sql: "select id from competitors", ids: expected.competitors.map((r) => r.id) },
    { name: "lookupAds", sql: "select id from lookup_ads", ids: expected.lookupAds.map((r) => r.id) },
    { name: "searchCompetitorAds", sql: "select id from search_competitor_ads", ids: expected.searchCompetitorAds.map((r) => r.id) },
    { name: "icps", sql: "select id from icps", ids: expected.icps.map((r) => r.id) },
    { name: "seenPageIds", sql: "select id from seen_page_ids", ids: expected.seenPageIds },
    { name: "deletedRunIds", sql: "select id from deleted_run_ids", ids: expected.deletedRunIds },
  ];
  for (const { name, sql, ids } of collections) {
    const stored = await idsOf(db, sql);
    const wanted = new Set(ids);
    if (stored.size !== wanted.size) {
      mismatches.push(`${name}: ${stored.size} row(s) in the database, ${wanted.size} in the store`);
    }
    const missing = [...wanted].filter((id) => !stored.has(id));
    const extra = [...stored].filter((id) => !wanted.has(id));
    if (missing.length) mismatches.push(`${name}: missing ${missing.length}: ${listIds(missing)}`);
    if (extra.length) mismatches.push(`${name}: not in the store ${extra.length}: ${listIds(extra)}`);
  }
  {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from app_settings");
    const want = expected.appSettings ? 1 : 0;
    if (Number(rows[0]?.n) !== want) mismatches.push(`appSettings: ${rows[0]?.n} row(s), expected ${want}`);
  }
  log(`row ids checked (${mismatches.length} mismatch(es) so far)`);

  /* users: credentials and roles */
  {
    const { rows } = await db.query<{ id: string; username: string; role: string; status: string; data: AnyRecord }>(
      "select id, username, role, status, data from users",
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const user of expected.users) {
      const row = byId.get(user.id);
      if (!row) continue;
      if (row.data.passwordHash !== user.passwordHash) mismatches.push(`users ${user.id}: password hash differs`);
      if (row.role !== user.role || row.data.role !== user.role) mismatches.push(`users ${user.id}: role ${row.role}, expected ${user.role}`);
      if (row.status !== user.status || row.data.status !== user.status) {
        mismatches.push(`users ${user.id}: status ${row.status}, expected ${user.status}`);
      }
      if (row.username !== user.username) mismatches.push(`users ${user.id}: username ${row.username}, expected ${user.username}`);
      if ((row.data.orgId ?? null) !== (user.orgId ?? null)) mismatches.push(`users ${user.id}: orgId differs`);
    }
  }

  /* credit periods: counters (columns and record) per period, per user */
  {
    const { rows } = await db.query<{
      id: string;
      user_id: string;
      status: string;
      allowance: string;
      consumed: string;
      reserved: string;
      data: AnyRecord;
    }>("select id, user_id, status, allowance::text, consumed::text, reserved::text, data from credit_periods");
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const period of expected.creditPeriods) {
      const row = byId.get(period.id);
      if (!row) continue;
      const checks: Array<[string, unknown, unknown, unknown]> = [
        ["allowance", Number(row.allowance), row.data.allowanceSubunits, period.allowanceSubunits],
        ["consumed", Number(row.consumed), row.data.consumedSubunits, period.consumedSubunits],
        ["reserved", Number(row.reserved), row.data.reservedSubunits, period.reservedSubunits],
        ["status", row.status, row.data.status, period.status],
        ["user", row.user_id, row.data.userId, period.userId],
      ];
      for (const [field, column, record, want] of checks) {
        if (column !== want || record !== want) {
          mismatches.push(
            `creditPeriods ${period.id} (user ${period.userId}): ${field} is ${String(column)} (record ${String(record)}), expected ${String(want)}`,
          );
        }
      }
    }
  }

  /* ledger: count and sum per user, seq per row, sequence ahead of every seq */
  {
    const want = new Map<string, { n: number; sum: number }>();
    for (const entry of expected.creditLedger) {
      const held = want.get(entry.userId) ?? { n: 0, sum: 0 };
      held.n += 1;
      held.sum += Number(entry.deltaSubunits) || 0;
      want.set(entry.userId, held);
    }
    const { rows } = await db.query<{ user_id: string; n: number; sum: string | null }>(
      `select user_id, count(*)::int as n, sum(coalesce((data->>'deltaSubunits')::numeric, 0))::text as sum
         from credit_ledger group by user_id`,
    );
    const got = new Map(rows.map((r) => [r.user_id, { n: Number(r.n), sum: Number(r.sum ?? 0) }]));
    for (const userId of new Set([...want.keys(), ...got.keys()])) {
      const a = got.get(userId) ?? { n: 0, sum: 0 };
      const b = want.get(userId) ?? { n: 0, sum: 0 };
      if (a.n !== b.n || a.sum !== b.sum) {
        mismatches.push(`creditLedger user ${userId}: ${a.n} entries summing ${a.sum}, expected ${b.n} summing ${b.sum}`);
      }
    }
    const seqs = await db.query<{ id: string; seq: string; data_seq: string | null }>(
      "select id, seq::text, data->>'seq' as data_seq from credit_ledger",
    );
    const seqOf = new Map(seqs.rows.map((r) => [r.id, r]));
    const wrongSeq = expected.creditLedger
      .filter((e) => {
        const row = seqOf.get(e.id);
        return row && (Number(row.seq) !== e.seq || Number(row.data_seq) !== e.seq);
      })
      .map((e) => e.id);
    if (wrongSeq.length) mismatches.push(`creditLedger: seq differs for ${listIds(wrongSeq)}`);
    for (const [sequence, table, counter] of [
      ["ledger_seq", "credit_ledger", expected.ledgerSeq],
      ["audit_seq", "audit_logs", expected.auditSeq],
    ] as const) {
      const { rows: s } = await db.query<{ last: string; max: string }>(
        `select (select last_value from ${sequence})::text as last, (select coalesce(max(seq), 0) from ${table})::text as max`,
      );
      const last = Number(s[0]?.last);
      if (last < Number(s[0]?.max) || last < counter) {
        mismatches.push(`${sequence}: at ${last}, behind max seq ${s[0]?.max} or the stored counter ${counter}`);
      }
    }
  }

  /* runs: status (running ones must be failed with the cutover message) */
  for (const [name, table, runs] of [
    ["jobs", "jobs", expected.jobs],
    ["lookupJobs", "lookup_jobs", expected.lookupJobs],
  ] as const) {
    const { rows } = await db.query<{ id: string; status: string; data: AnyRecord }>(`select id, status, data from ${table}`);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const run of runs) {
      const row = byId.get(run.id);
      if (!row) continue;
      if (row.status !== run.status || row.data.status !== run.status) {
        mismatches.push(`${name} ${run.id}: status ${row.status}, expected ${run.status}`);
      }
      if (expected.interrupted.has(run.id)) {
        const progress = (row.data.progress ?? {}) as AnyRecord;
        if (row.status !== "failed" || progress.message !== CUTOVER_MESSAGE || progress.stage !== "failed") {
          mismatches.push(`${name} ${run.id}: was running; expected failed with "${CUTOVER_MESSAGE}"`);
        }
      }
    }
  }

  /* recreated pages: every content byte, by length and hash */
  {
    const { rows: stored } = await db.query<{ id: string }>("select competitor_id as id from recreated_pages");
    const withRow = new Set(stored.map((r) => r.id));
    let checked = 0;
    for (const competitor of expected.competitors) {
      const heavy = expectedHeavy(competitor.recreatedPage);
      if (!heavy) {
        if (withRow.has(competitor.id)) mismatches.push(`recreatedPages ${competitor.id}: content stored, but the file has none`);
        continue;
      }
      if (!withRow.has(competitor.id)) {
        mismatches.push(`recreatedPages ${competitor.id}: content missing`);
        continue;
      }
      const { rows } = await db.query<{ content: Buffer | Uint8Array | null; archive_path: string | null; bytes: number }>(
        "select content, archive_path, bytes from recreated_pages where competitor_id = $1",
        [competitor.id],
      );
      const row = rows[0];
      let text: string;
      try {
        const gz = row.content ? Buffer.from(row.content) : await fetchArchived(row.archive_path as string);
        text = gunzipSync(gz).toString("utf8");
      } catch (err) {
        mismatches.push(`recreatedPages ${competitor.id}: content unreadable (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const wantJson = JSON.stringify(heavy);
      const wantBytes = Buffer.byteLength(wantJson);
      const gotBytes = Buffer.byteLength(text);
      if (gotBytes !== wantBytes) {
        mismatches.push(`recreatedPages ${competitor.id}: ${gotBytes} content bytes, expected ${wantBytes}`);
      }
      if (Number(row.bytes) !== wantBytes) {
        mismatches.push(`recreatedPages ${competitor.id}: bytes column ${row.bytes}, expected ${wantBytes}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        mismatches.push(`recreatedPages ${competitor.id}: content is not valid JSON`);
        continue;
      }
      if (sha256(canonical(parsed)) !== sha256(canonical(heavy))) {
        mismatches.push(`recreatedPages ${competitor.id}: content differs from the file (sha-256)`);
      }
      checked += 1;
    }
    // The light rows must say a page is there.
    const { rows: markers } = await db.query<{ id: string; has: boolean | null; bytes: string | null }>(
      `select id, (data->'recreatedPage'->>'hasPage')::boolean as has, data->'recreatedPage'->>'pageBytes' as bytes
         from competitors where data ? 'recreatedPage'`,
    );
    const markerOf = new Map(markers.map((r) => [r.id, r]));
    for (const competitor of expected.competitors) {
      const heavy = expectedHeavy(competitor.recreatedPage);
      const marker = markerOf.get(competitor.id);
      if (!marker) continue;
      if (heavy && (marker.has !== true || Number(marker.bytes) !== Buffer.byteLength(JSON.stringify(heavy)))) {
        mismatches.push(`competitors ${competitor.id}: page marker does not match its content`);
      }
      if (!heavy && marker.has === true) mismatches.push(`competitors ${competitor.id}: page marker says content exists`);
    }
    log(`recreated pages checked: ${checked}`);
  }

  return { ok: mismatches.length === 0, mismatches };
}
