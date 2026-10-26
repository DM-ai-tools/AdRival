import type { LoginAttemptRecord } from "../types";
import { getDb, withTx, type Queryable } from "./client";
import { isoOrNull } from "./runs";

/*
 * Failed-login counters (`login_attempts`), one row per lowercased username:
 * id is the key, created_at the start of the current window (firstAttemptAt).
 * The throttling policy lives in auth/rateLimit.ts.
 */

export async function getLoginAttempt(key: string): Promise<LoginAttemptRecord | null> {
  const { rows } = await getDb().query<{ data: LoginAttemptRecord }>(
    "select data from login_attempts where id = $1",
    [key],
  );
  return rows[0]?.data ?? null;
}

/**
 * Read-modify-write one counter in a transaction. A per-key advisory lock
 * serializes concurrent failures for the same username, including the first
 * one (when there is no row to lock yet), so no failure is lost.
 */
export async function changeLoginAttempt(
  key: string,
  change: (current: LoginAttemptRecord | null) => LoginAttemptRecord,
): Promise<LoginAttemptRecord> {
  return withTx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`login:${key}`]);
    const { rows } = await tx.query<{ data: LoginAttemptRecord }>(
      "select data from login_attempts where id = $1 for update",
      [key],
    );
    const next = change(rows[0]?.data ?? null);
    await upsertLoginAttemptRow(tx, key, next);
    return next;
  });
}

/** Inserts or replaces one counter row under `key` (also used by the store import). */
export async function upsertLoginAttemptRow(tx: Queryable, key: string, record: LoginAttemptRecord): Promise<void> {
  await tx.query(
    `insert into login_attempts (id, created_at, data)
     values ($1, coalesce($2::timestamptz, now()), $3::jsonb)
     on conflict (id) do update set created_at = excluded.created_at, data = excluded.data`,
    [key, isoOrNull(record.firstAttemptAt), JSON.stringify(record)],
  );
}

export async function deleteLoginAttempt(key: string): Promise<void> {
  await getDb().query("delete from login_attempts where id = $1", [key]);
}
