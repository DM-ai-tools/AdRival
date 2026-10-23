import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Queryable } from "./client";

/** Any constant works; it only has to be the same for every migrating process. */
const MIGRATION_LOCK_KEY = 7_302_001;
const MIGRATION_NAME = /^[A-Za-z0-9_.-]+\.sql$/;
/** Transaction-local flag the apply block sets when it actually ran the file. */
const APPLIED_FLAG = "adrival.migration_applied";

const LOCK = `select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});`;
const CREATE_TABLE =
  "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now());";

export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), "db", "migrations");
}

/** A dollar-quote tag that does not occur in `body`. */
function dollarTag(body: string): string {
  for (;;) {
    const tag = `$m${randomBytes(6).toString("hex")}$`;
    if (!body.includes(tag)) return tag;
  }
}

/**
 * Applies `*.sql` files from `dir` in name order, skipping those already in
 * `schema_migrations`. Returns the names applied by this call (empty when the
 * database is current).
 *
 * Every step is one multi-statement simple query, which Postgres runs as a
 * single implicit transaction, and every step first takes the same
 * transaction-level advisory lock. So:
 * - creating `schema_migrations` cannot race another process doing the same;
 * - each file is applied fully or not at all, together with its row;
 * - the "already applied?" check is repeated under the lock, so a second
 *   process that read the list before the first one finished skips the file
 *   instead of failing on the duplicate name.
 * The re-check needs a conditional, so the file runs through EXECUTE inside a
 * DO block; this works with any Queryable (pool, single connection, PGlite).
 */
export async function migrate(db: Queryable, dir: string = defaultMigrationsDir()): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `${LOCK}\n${CREATE_TABLE}\nselect name from schema_migrations;`,
  );
  const done = new Set(rows.map((r) => r.name));

  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const applied: string[] = [];
  for (const name of files) {
    if (done.has(name)) continue;
    if (!MIGRATION_NAME.test(name)) {
      throw new Error(`migration file name not allowed: ${name}`);
    }
    const sql = await readFile(path.join(dir, name), "utf8");
    const inner = dollarTag(sql);
    const block = `
begin
  if exists (select 1 from schema_migrations where name = '${name}') then
    return;
  end if;
  insert into schema_migrations (name, applied_at) values ('${name}', now());
  execute ${inner}${sql}${inner};
  perform set_config('${APPLIED_FLAG}', 'yes', true);
end`;
    const outer = dollarTag(block);
    const result = await db.query<{ applied: string | null }>(
      [
        LOCK,
        CREATE_TABLE,
        `do ${outer}${block}${outer};`,
        `select current_setting('${APPLIED_FLAG}', true) as applied;`,
      ].join("\n"),
    );
    if (result.rows[0]?.applied === "yes") applied.push(name);
  }
  return applied;
}
