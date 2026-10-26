import type {
  CreditLedgerEntry,
  CreditPeriod,
  CreditReservation,
  ProviderCallRecord,
} from "../types";
import type { Queryable } from "./client";

/*
 * Credit tables: building blocks for accountingService.ts. Each row keeps the
 * whole record in `data`; the other columns are copies kept in sync here
 * (credit_periods.allowance/consumed/reserved mirror the *Subunits fields).
 *
 * Locking (replaces the file store's whole-store lock):
 * - Every transaction that reads a balance and then changes it first takes the
 *   per-user credits key (`lockCreditUsers` / `lockCurrentPeriod`), then the
 *   user's current period row FOR UPDATE. The advisory key makes period
 *   creation and the monthly roll safe too: a plain FOR UPDATE that waited on
 *   a period being closed would find no current row afterwards (its snapshot
 *   predates the new one) and try to open a second one.
 * - A transaction that touches several users takes all their keys first, in
 *   sorted user-id order, and takes no other user's key afterwards.
 * - Reservation and period rows are read FOR UPDATE only after the owner's key.
 */

/* ── locks ── */

function creditsKey(userId: string): string {
  return `credits:${userId}`;
}

/**
 * Takes the per-user credits key for every user, in sorted id order, so two
 * transactions locking overlapping sets cannot deadlock. Re-taking a key
 * already held in this transaction is a no-op.
 */
export async function lockCreditUsers(tx: Queryable, userIds: Iterable<string>): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [creditsKey(id)]);
  }
}

/**
 * Locks the user's credits (advisory key, then the current period row FOR
 * UPDATE) and returns the current period, or null when the user has none yet.
 * Call before reading anything a balance change depends on.
 */
export async function lockCurrentPeriod(tx: Queryable, userId: string): Promise<CreditPeriod | null> {
  await lockCreditUsers(tx, [userId]);
  const { rows } = await tx.query<{ data: CreditPeriod }>(
    "select data from credit_periods where user_id = $1 and status = 'current' for update",
    [userId],
  );
  return rows[0]?.data ?? null;
}

/* ── periods ── */

/** The user's current period without locking it (read models, duplicate settlements). */
export async function selectCurrentPeriod(q: Queryable, userId: string): Promise<CreditPeriod | null> {
  const { rows } = await q.query<{ data: CreditPeriod }>(
    "select data from credit_periods where user_id = $1 and status = 'current'",
    [userId],
  );
  return rows[0]?.data ?? null;
}

/** One period by id; `forUpdate` only after the owner's credits key is held. */
export async function selectPeriodById(
  q: Queryable,
  id: string,
  forUpdate: boolean,
): Promise<CreditPeriod | null> {
  const { rows } = await q.query<{ data: CreditPeriod }>(
    `select data from credit_periods where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Newest first by startsAt. */
export async function selectPeriodsForUser(q: Queryable, userId: string): Promise<CreditPeriod[]> {
  const { rows } = await q.query<{ data: CreditPeriod }>(
    `select data from credit_periods where user_id = $1
      order by (data->>'startsAt') collate "C" desc, id desc`,
    [userId],
  );
  return rows.map((r) => r.data);
}

/**
 * Upserts a period. A period that stops being current must be saved before
 * the user's next current period is inserted (one current period per user).
 */
export async function savePeriod(tx: Queryable, period: CreditPeriod): Promise<void> {
  await tx.query(
    `insert into credit_periods (id, user_id, status, allowance, consumed, reserved, data)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)
     on conflict (id) do update set
       user_id   = excluded.user_id,
       status    = excluded.status,
       allowance = excluded.allowance,
       consumed  = excluded.consumed,
       reserved  = excluded.reserved,
       data      = excluded.data`,
    [
      period.id,
      period.userId,
      period.status,
      period.allowanceSubunits,
      period.consumedSubunits,
      period.reservedSubunits,
      JSON.stringify(period),
    ],
  );
}

/* ── ledger ── */

export type LedgerDraft = Omit<CreditLedgerEntry, "id" | "seq" | "createdAt"> & { createdAt?: string };

/**
 * Appends one ledger row. `seq` comes from ledger_seq and is written into both
 * the column and `data` in one statement. Use the transaction handle so the
 * entry commits with the balance change it describes.
 */
export async function insertLedger(tx: Queryable, draft: LedgerDraft): Promise<CreditLedgerEntry> {
  const entry: Omit<CreditLedgerEntry, "seq"> = {
    ...draft,
    id: crypto.randomUUID(),
    createdAt: draft.createdAt ?? new Date().toISOString(),
  };
  const { rows } = await tx.query<{ seq: string | number }>(
    `insert into credit_ledger (seq, id, user_id, period_id, created_at, data)
     select n.seq, $1, $2, $3, $4::timestamptz, $5::jsonb || jsonb_build_object('seq', n.seq)
       from (select nextval('ledger_seq') as seq) n
     returning seq`,
    [entry.id, entry.userId, entry.periodId, entry.createdAt, JSON.stringify(entry)],
  );
  if (!rows[0]) throw new Error("insertLedger: insert returned no row");
  return { ...entry, seq: Number(rows[0].seq) } as CreditLedgerEntry;
}

export interface LedgerQuery {
  userId?: string;
  periodId?: string;
  types?: CreditLedgerEntry["type"][];
  from?: string;
  to?: string;
  limit?: number;
}

/** Newest first (seq desc); every row when `limit` is unset or 0, as records.ts did. */
export async function selectLedger(q: Queryable, query: LedgerQuery = {}): Promise<CreditLedgerEntry[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.userId) conditions.push(`user_id = ${param(query.userId)}`);
  if (query.periodId) conditions.push(`period_id = ${param(query.periodId)}`);
  if (query.types) conditions.push(`data->>'type' = any(${param(query.types)}::text[])`);
  // String comparison, as records.ts did with ISO strings.
  if (query.from) conditions.push(`(data->>'createdAt') collate "C" >= ${param(query.from)}`);
  if (query.to) conditions.push(`(data->>'createdAt') collate "C" <= ${param(query.to)}`);
  const limit = query.limit ? ` limit ${param(query.limit)}` : "";
  const { rows } = await q.query<{ data: CreditLedgerEntry }>(
    `select data from credit_ledger ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      order by seq desc${limit}`,
    params,
  );
  return rows.map((r) => r.data);
}

/* ── reservations ── */

/** Inserts or replaces one reservation row (also used by the store import). */
export async function upsertReservation(tx: Queryable, reservation: CreditReservation): Promise<void> {
  await tx.query(
    `insert into credit_reservations (id, user_id, period_id, status, expires_at, data)
     values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
     on conflict (id) do update set
       user_id    = excluded.user_id,
       period_id  = excluded.period_id,
       status     = excluded.status,
       expires_at = excluded.expires_at,
       data       = excluded.data`,
    [
      reservation.id,
      reservation.userId,
      reservation.periodId,
      reservation.status,
      reservation.expiresAt,
      JSON.stringify(reservation),
    ],
  );
}

export async function insertReservation(tx: Queryable, reservation: CreditReservation): Promise<void> {
  await upsertReservation(tx, reservation);
}

export async function updateReservation(tx: Queryable, reservation: CreditReservation): Promise<void> {
  await upsertReservation(tx, reservation);
}

/** One reservation; `forUpdate` only after the owner's credits key is held. */
export async function selectReservation(
  q: Queryable,
  id: string,
  forUpdate: boolean,
): Promise<CreditReservation | null> {
  const { rows } = await q.query<{ data: CreditReservation }>(
    `select data from credit_reservations where id = $1${forUpdate ? " for update" : ""}`,
    [id],
  );
  return rows[0]?.data ?? null;
}

/** Order the file store kept reservations in (insertion order ≈ createdAt). */
const RESERVATION_ORDER = `order by (data->>'createdAt') collate "C" asc, id asc`;

/** Open and pending reservations held against one period, locked (caller holds the owner's key). */
export async function selectHeldReservationsForPeriod(
  tx: Queryable,
  periodId: string,
): Promise<CreditReservation[]> {
  const { rows } = await tx.query<{ data: CreditReservation }>(
    `select data from credit_reservations
      where period_id = $1 and status in ('open', 'pending_reconciliation')
      ${RESERVATION_ORDER} for update`,
    [periodId],
  );
  return rows.map((r) => r.data);
}

/** Owners of open reservations whose heartbeat deadline is at or before `at` (no lock). */
export async function selectExpiredReservationOwners(q: Queryable, at: string): Promise<string[]> {
  const { rows } = await q.query<{ user_id: string }>(
    "select distinct user_id from credit_reservations where status = 'open' and expires_at <= $1::timestamptz",
    [at],
  );
  return rows.map((r) => r.user_id);
}

/** Expired open reservations of these users, locked (caller holds their keys). */
export async function selectExpiredReservations(
  tx: Queryable,
  at: string,
  userIds: string[],
): Promise<CreditReservation[]> {
  if (!userIds.length) return [];
  const { rows } = await tx.query<{ data: CreditReservation }>(
    `select data from credit_reservations
      where status = 'open' and expires_at <= $1::timestamptz and user_id = any($2::text[])
      ${RESERVATION_ORDER} for update`,
    [at, userIds],
  );
  return rows.map((r) => r.data);
}

export async function selectReservations(
  q: Queryable,
  filter: { userId?: string; status?: CreditReservation["status"] },
): Promise<CreditReservation[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filter.userId) {
    params.push(filter.userId);
    conditions.push(`user_id = $${params.length}`);
  }
  if (filter.status) {
    params.push(filter.status);
    conditions.push(`status = $${params.length}`);
  }
  const { rows } = await q.query<{ data: CreditReservation }>(
    `select data from credit_reservations ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
      ${RESERVATION_ORDER}`,
    params,
  );
  return rows.map((r) => r.data);
}

/* ── provider calls ── */

/** Serializes settlements of one idempotency key. Take it before any credits key. */
export async function lockIdempotencyKey(tx: Queryable, key: string): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`provider-call:${key}`]);
}

export async function selectProviderCallByKey(q: Queryable, key: string): Promise<ProviderCallRecord | null> {
  const { rows } = await q.query<{ data: ProviderCallRecord }>(
    "select data from provider_calls where data->>'idempotencyKey' = $1",
    [key],
  );
  return rows[0]?.data ?? null;
}

/**
 * Inserts a provider call. Returns false, writing nothing, when a call with
 * the same idempotency key already exists (unique index from migration 003).
 * user_id is the charged user and created_at is startedAt.
 */
export async function insertProviderCall(tx: Queryable, call: ProviderCallRecord): Promise<boolean> {
  const result = await tx.query(
    `insert into provider_calls (id, user_id, run_id, provider, created_at, data)
     values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
     on conflict ((data->>'idempotencyKey')) do nothing`,
    [call.id, call.chargedUserId, call.runId, call.provider, call.startedAt, JSON.stringify(call)],
  );
  return result.rowCount > 0;
}
