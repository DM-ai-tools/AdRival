import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Queryable } from "./client";

/** Any constant works; it only has to be the same for every migrating process. */
const MIGRATION_LOCK_KEY = 7_302_001;
const MIGRATION_NAME = /^[A-Za-z0-9_.-]+\.sql$/;

export function defaultMigrationsDir(): string {
  return path.join(process.cwd(), "db", "migrations");
}

/**
 * Applies `*.sql` files from `dir` in name order, skipping those already in
 * `schema_migrations`. Returns the names applied by this call (empty when the
 * database is current).
 *
 * Each file is sent as one multi-statement simple query together with an
 * advisory lock and its `schema_migrations` row. Postgres runs such a query as
 * a single implicit transaction, so a file is applied fully or not at all, and
 * a second process migrating at the same moment waits on the lock and then
 * fails on the duplicate name instead of half-applying anything.
 */
export async function migrate(db: Queryable, dir: string = defaultMigrationsDir()): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const { rows } = await db.query<{ name: string }>("select name from schema_migrations");
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
    await db.query(
      [
        `select pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});`,
        `insert into schema_migrations (name, applied_at) values ('${name}', now());`,
        sql,
      ].join("\n"),
    );
    applied.push(name);
  }
  return applied;
}
