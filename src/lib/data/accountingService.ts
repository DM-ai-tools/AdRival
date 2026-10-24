import type {
  CreditLedgerEntry,
  CreditPeriod,
  CreditReservation,
  ProjectKind,
  ProviderCallRecord,
  ProviderCallStatus,
  ProviderId,
  ProviderUsageUnits,
  ResetCadence,
  UsageConfidence,
} from "../types";
import { getDb, withTx, type Queryable } from "./client";
import {
  insertLedger,
  insertProviderCall,
  insertReservation,
  lockCreditUsers,
  lockCurrentPeriod,
  lockIdempotencyKey,
  savePeriod,
  selectCurrentPeriod,
  selectExpiredReservationOwners,
  selectExpiredReservations,
  selectHeldReservationsForPeriod,
  selectLedger,
  selectPeriodById,
  selectPeriodsForUser,
  selectProviderCallByKey,
  selectReservation,
  selectReservations,
  updateReservation,
  type LedgerDraft,
  type LedgerQuery,
} from "./credits";
import { getUserById } from "./identity";
import { getAppSettings } from "./settings";

/*
 * Async port of accounting/service.ts and the ledger half of
 * accounting/records.ts (appendLedgerEntries, queryLedger) over Postgres.
 * Same names and behaviour; functions that took the file store's `db` now
 * take a transaction handle (`ensureCurrentPeriod`, `recoverAbandonedReservations`,
 * `appendLedgerEntries`).
 *
 * Every balance change runs in one withTx and first locks the user's credits
 * (credits.ts: per-user advisory key, then the current period row FOR UPDATE),
 * so two operations on one user serialize and neither sees a stale balance.
 * Transactions touching several users lock them in sorted id order first.
 * Reservation lookups read the reservation once only to learn its owner, lock
 * the owner, then re-read it FOR UPDATE before deciding anything.
 */

export type { LedgerDraft, LedgerQuery } from "./credits";

/** How long a reservation may go without a heartbeat before it is recoverable. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

/** Admins are not stopped by an allowance. Usage is still recorded. */
export function userHasUnlimitedCredits(
  user: { role: string; status: string } | null | undefined,
): boolean {
  return user?.role === "admin" && user.status === "active";
}

function addMonthsIso(from: string, months: number): string {
  const d = new Date(from);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

export function availableSubunits(period: CreditPeriod): number {
  return (
    period.allowanceSubunits - period.consumedSubunits - period.reservedSubunits
  );
}

async function readUser(q: Queryable, id: string): Promise<{ role: string; status: string } | null> {
  const { rows } = await q.query<{ role: string; status: string }>(
    "select data->>'role' as role, data->>'status' as status from users where id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** A ledger draft with every optional reference empty. */
function draft(fields: Pick<LedgerDraft, "userId" | "periodId" | "type" | "deltaSubunits" | "balanceAfterSubunits" | "reason" | "actorUserId"> & Partial<LedgerDraft>): LedgerDraft {
  return {
    providerCallId: null,
    reservationId: null,
    projectKind: null,
    projectId: null,
    runId: null,
    provider: null,
    conversionRuleVersion: null,
    idempotencyKey: null,
    ...fields,
  };
}

/* ──────────────────────────── Append-only ledger ────────────────────────── */

/**
 * Append ledger rows in order. Pass the transaction handle so the entries
 * commit atomically with the balance change they describe.
 */
export async function appendLedgerEntries(tx: Queryable, drafts: LedgerDraft[]): Promise<CreditLedgerEntry[]> {
  const created: CreditLedgerEntry[] = [];
  for (const d of drafts) created.push(await insertLedger(tx, d));
  return created;
}

export async function queryLedger(query: LedgerQuery = {}): Promise<CreditLedgerEntry[]> {
  return selectLedger(getDb(), query);
}

/* ───────────────────────────── Allocation periods ───────────────────────── */

async function openPeriod(
  tx: Queryable,
  userId: string,
  input: {
    allowanceSubunits: number;
    resetCadence: ResetCadence;
    actorUserId: string | null;
    reason: string;
  },
): Promise<CreditPeriod> {
  const startsAt = now();
  const period: CreditPeriod = {
    id: crypto.randomUUID(),
    userId,
    startsAt,
    endsAt: null,
    nextResetAt:
      input.resetCadence === "monthly" ? addMonthsIso(startsAt, 1) : null,
    resetCadence: input.resetCadence,
    allowanceSubunits: input.allowanceSubunits,
    consumedSubunits: 0,
    reservedSubunits: 0,
    status: "current",
    createdAt: startsAt,
    updatedAt: startsAt,
  };
  await savePeriod(tx, period);
  await appendLedgerEntries(tx, [
    draft({
      userId,
      periodId: period.id,
      type: "period_open",
      deltaSubunits: 0,
      balanceAfterSubunits: 0,
      reason: input.reason,
      actorUserId: input.actorUserId,
    }),
    draft({
      userId,
      periodId: period.id,
      type: "allowance_set",
      deltaSubunits: input.allowanceSubunits,
      balanceAfterSubunits: input.allowanceSubunits,
      reason: input.reason,
      actorUserId: input.actorUserId,
    }),
  ]);
  return period;
}

/**
 * Roll a monthly period when its reset date has passed. The caller holds the
 * user's credits lock.
 *
 * The closed period keeps its allowance/consumed figures for history. Open
 * reservations move to the new period along with their held amount, so credits
 * held by an in-flight run are neither lost nor spendable twice.
 */
async function maybeRollPeriod(tx: Queryable, period: CreditPeriod): Promise<CreditPeriod> {
  if (period.resetCadence !== "monthly" || !period.nextResetAt) return period;
  if (period.nextResetAt > now()) return period;

  const timestamp = now();
  const closed: CreditPeriod = { ...period, status: "closed", endsAt: timestamp, updatedAt: timestamp };

  const openReservations = await selectHeldReservationsForPeriod(tx, period.id);
  const carriedHold = openReservations.reduce((sum, r) => sum + r.amountSubunits, 0);
  closed.reservedSubunits -= carriedHold;

  // Closed first: one current period per user.
  await savePeriod(tx, closed);
  await appendLedgerEntries(tx, [
    draft({
      userId: closed.userId,
      periodId: closed.id,
      type: "period_close",
      deltaSubunits: 0,
      balanceAfterSubunits: availableSubunits(closed),
      reason: `Allocation period closed; ${openReservations.length} reservation(s) carried forward`,
      actorUserId: null,
    }),
  ]);

  const next = await openPeriod(tx, closed.userId, {
    allowanceSubunits: closed.allowanceSubunits,
    resetCadence: "monthly",
    actorUserId: null,
    reason: "Monthly allowance reset",
  });
  next.startsAt = period.nextResetAt;
  next.nextResetAt = addMonthsIso(period.nextResetAt, 1);

  for (const reservation of openReservations) {
    await updateReservation(tx, { ...reservation, periodId: next.id, updatedAt: timestamp });
    next.reservedSubunits += reservation.amountSubunits;
  }
  await savePeriod(tx, next);
  return next;
}

/**
 * Return the user's current allocation period, opening one on first use, and
 * rolling it when a monthly reset is due. Locks the user's credits first
 * (re-taking a lock this transaction already holds is fine).
 *
 * A lazily-opened period starts at zero allowance — never at the configured
 * default — so an existing account can't silently gain credits.
 */
export async function ensureCurrentPeriod(
  tx: Queryable,
  userId: string,
  seed?: { allowanceSubunits: number; resetCadence: ResetCadence; reason: string },
): Promise<CreditPeriod> {
  const existing = await lockCurrentPeriod(tx, userId);
  if (existing) return maybeRollPeriod(tx, existing);
  return openPeriod(tx, userId, {
    allowanceSubunits: seed?.allowanceSubunits ?? 0,
    resetCadence: seed?.resetCadence ?? (await getAppSettings(tx)).defaultResetCadence,
    actorUserId: null,
    reason: seed?.reason ?? "First allocation period opened",
  });
}

/** Called at registration/creation so the account starts with a real period. */
export async function initializeUserCredits(
  userId: string,
  input: { allowanceSubunits: number; resetCadence: ResetCadence; reason: string },
): Promise<CreditPeriod> {
  return withTx((tx) => ensureCurrentPeriod(tx, userId, input));
}

export async function listPeriods(userId: string): Promise<CreditPeriod[]> {
  return selectPeriodsForUser(getDb(), userId);
}

/* ─────────────────────── Admin allowance adjustments ────────────────────── */

export interface AllowanceChange {
  userId: string;
  actorUserId: string;
  reason: string;
}

export async function setAllowance(
  input: AllowanceChange & { allowanceSubunits: number },
): Promise<CreditPeriod> {
  return withTx(async (tx) => {
    const period = await ensureCurrentPeriod(tx, input.userId);
    const delta = input.allowanceSubunits - period.allowanceSubunits;
    period.allowanceSubunits = input.allowanceSubunits;
    period.updatedAt = now();
    await savePeriod(tx, period);
    await appendLedgerEntries(tx, [
      draft({
        userId: input.userId,
        periodId: period.id,
        type: "allowance_set",
        deltaSubunits: delta,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
      }),
    ]);
    return period;
  });
}

export async function addCredits(
  input: AllowanceChange & { amountSubunits: number },
): Promise<CreditPeriod> {
  return withTx(async (tx) => {
    const period = await ensureCurrentPeriod(tx, input.userId);
    period.allowanceSubunits += input.amountSubunits;
    period.updatedAt = now();
    await savePeriod(tx, period);
    await appendLedgerEntries(tx, [
      draft({
        userId: input.userId,
        periodId: period.id,
        type: "allowance_added",
        deltaSubunits: input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
      }),
    ]);
    return period;
  });
}

/**
 * Correct a past charge without rewriting it. A positive amount refunds the
 * user; a negative amount bills them. The original charge row is untouched.
 */
export async function recordAdjustment(
  input: AllowanceChange & { amountSubunits: number; providerCallId?: string | null },
): Promise<CreditPeriod> {
  return withTx(async (tx) => {
    const period = await ensureCurrentPeriod(tx, input.userId);
    period.consumedSubunits -= input.amountSubunits;
    period.updatedAt = now();
    await savePeriod(tx, period);
    await appendLedgerEntries(tx, [
      draft({
        userId: input.userId,
        periodId: period.id,
        type: "adjustment",
        deltaSubunits: input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
        providerCallId: input.providerCallId ?? null,
      }),
    ]);
    return period;
  });
}

export async function setResetCadence(
  input: AllowanceChange & { cadence: ResetCadence },
): Promise<CreditPeriod> {
  return withTx(async (tx) => {
    const period = await ensureCurrentPeriod(tx, input.userId);
    period.resetCadence = input.cadence;
    period.nextResetAt =
      input.cadence === "monthly" ? addMonthsIso(now(), 1) : null;
    period.updatedAt = now();
    await savePeriod(tx, period);
    return period;
  });
}

/* ──────────────────────────────── Reservations ──────────────────────────── */

/**
 * Locks the owners of expired open reservations together with `alsoLock`
 * (sorted, all at once), then releases those reservations' holds.
 */
async function recoverAbandoned(tx: Queryable, alsoLock: string[]): Promise<number> {
  const timestamp = now();
  const owners = await selectExpiredReservationOwners(tx, timestamp);
  const users = [...new Set([...owners, ...alsoLock])].sort();
  await lockCreditUsers(tx, users);
  for (const userId of users) await lockCurrentPeriod(tx, userId);

  // Re-read under the locks: only reservations of users this transaction holds.
  const expired = await selectExpiredReservations(tx, timestamp, users);
  const periods = new Map<string, CreditPeriod | null>();
  const changedPeriods = new Set<string>();
  let recovered = 0;
  for (const reservation of expired) {
    if (reservation.status !== "open") continue;
    if (reservation.expiresAt > timestamp) continue;
    if (!periods.has(reservation.periodId)) {
      periods.set(reservation.periodId, await selectPeriodById(tx, reservation.periodId, true));
    }
    const period = periods.get(reservation.periodId) ?? null;
    const held = reservation.amountSubunits;
    if (period && held > 0) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.updatedAt = timestamp;
      changedPeriods.add(period.id);
    }
    await updateReservation(tx, {
      ...reservation,
      amountSubunits: 0,
      status: "expired",
      closedAt: timestamp,
      updatedAt: timestamp,
    });
    if (held > 0) {
      await appendLedgerEntries(tx, [
        draft({
          userId: reservation.userId,
          periodId: reservation.periodId,
          type: "reservation_release",
          deltaSubunits: held,
          balanceAfterSubunits: period ? availableSubunits(period) : null,
          reason: "Abandoned reservation recovered",
          actorUserId: null,
          reservationId: reservation.id,
          projectKind: reservation.projectKind,
          projectId: reservation.projectId,
          runId: reservation.runId,
        }),
      ]);
    }
    recovered += 1;
  }
  for (const id of changedPeriods) {
    const period = periods.get(id);
    if (period) await savePeriod(tx, period);
  }
  return recovered;
}

/**
 * Release holds for reservations whose owning process stopped heartbeating.
 * Reservations explicitly parked as `pending_reconciliation` are left alone —
 * their billing outcome is unknown and an admin must resolve them.
 *
 * Locks every affected user (sorted), so call it before this transaction
 * takes any other credits lock.
 */
export async function recoverAbandonedReservations(tx: Queryable): Promise<number> {
  return recoverAbandoned(tx, []);
}

export async function sweepAbandonedReservations(): Promise<number> {
  return withTx((tx) => recoverAbandonedReservations(tx));
}

export type ReserveResult =
  | { ok: true; reservation: CreditReservation; availableSubunits: number }
  | {
      ok: false;
      reason: "insufficient_credits" | "account_not_active";
      requiredSubunits: number;
      availableSubunits: number;
    };

/**
 * Atomically hold credits. The balance read and the hold run under the user's
 * credits lock, so two concurrent runs cannot both see the same available
 * balance and overspend it.
 */
export async function reserveCredits(input: {
  userId: string;
  amountSubunits: number;
  operation: string;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  runId?: string | null;
  note?: string | null;
  ttlMs?: number;
}): Promise<ReserveResult> {
  return withTx(async (tx): Promise<ReserveResult> => {
    // Locks this user together with any user whose holds it recovers.
    await recoverAbandoned(tx, [input.userId]);

    const user = await readUser(tx, input.userId);
    if (!user || user.status !== "active") {
      return {
        ok: false,
        reason: "account_not_active",
        requiredSubunits: input.amountSubunits,
        availableSubunits: 0,
      };
    }

    const period = await ensureCurrentPeriod(tx, input.userId);
    const unlimited = userHasUnlimitedCredits(user);
    const available = availableSubunits(period);
    if (!unlimited && input.amountSubunits > available) {
      return {
        ok: false,
        reason: "insufficient_credits",
        requiredSubunits: input.amountSubunits,
        availableSubunits: available,
      };
    }

    const timestamp = now();
    const reservation: CreditReservation = {
      id: crypto.randomUUID(),
      userId: input.userId,
      periodId: period.id,
      projectKind: input.projectKind ?? null,
      projectId: input.projectId ?? null,
      runId: input.runId ?? null,
      operation: input.operation,
      amountSubunits: input.amountSubunits,
      settledSubunits: 0,
      status: "open",
      expiresAt: new Date(
        Date.now() + (input.ttlMs ?? RESERVATION_TTL_MS),
      ).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: null,
      note: input.note ?? null,
    };
    await insertReservation(tx, reservation);

    period.reservedSubunits += input.amountSubunits;
    period.updatedAt = timestamp;
    await savePeriod(tx, period);

    await appendLedgerEntries(tx, [
      draft({
        userId: input.userId,
        periodId: period.id,
        type: "reservation_hold",
        deltaSubunits: -input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: `Hold for ${input.operation}`,
        actorUserId: input.userId,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
      }),
    ]);

    return {
      ok: true,
      reservation,
      availableSubunits: availableSubunits(period),
    };
  });
}

/**
 * Finds a reservation's owner, locks the owner's credits, then re-reads the
 * reservation FOR UPDATE. Null when it does not exist.
 */
async function lockReservation(tx: Queryable, id: string): Promise<CreditReservation | null> {
  const peek = await selectReservation(tx, id, false);
  if (!peek) return null;
  await lockCurrentPeriod(tx, peek.userId);
  return selectReservation(tx, id, true);
}

/** Extend a long-running reservation so recovery does not reclaim it. */
export async function touchReservation(reservationId: string, ttlMs = RESERVATION_TTL_MS): Promise<void> {
  await withTx(async (tx) => {
    // Only the reservation row changes; its row lock is enough.
    const reservation = await selectReservation(tx, reservationId, true);
    if (!reservation || reservation.status !== "open") return;
    await updateReservation(tx, {
      ...reservation,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      updatedAt: now(),
    });
  });
}

/** Grow an existing hold for a workflow whose size was not known up front. */
export async function extendReservation(
  reservationId: string,
  additionalSubunits: number,
): Promise<{ ok: boolean; availableSubunits: number }> {
  return withTx(async (tx) => {
    const reservation = await lockReservation(tx, reservationId);
    if (!reservation || reservation.status !== "open") {
      return { ok: false, availableSubunits: 0 };
    }
    const period = await selectPeriodById(tx, reservation.periodId, true);
    if (!period) return { ok: false, availableSubunits: 0 };
    const owner = await readUser(tx, reservation.userId);
    const unlimited = userHasUnlimitedCredits(owner);
    const available = availableSubunits(period);
    if (!unlimited && additionalSubunits > available) {
      return { ok: false, availableSubunits: available };
    }
    reservation.amountSubunits += additionalSubunits;
    reservation.updatedAt = now();
    period.reservedSubunits += additionalSubunits;
    period.updatedAt = now();
    await updateReservation(tx, reservation);
    await savePeriod(tx, period);
    await appendLedgerEntries(tx, [
      draft({
        userId: reservation.userId,
        periodId: period.id,
        type: "reservation_hold",
        deltaSubunits: -additionalSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: `Incremental hold for ${reservation.operation}`,
        actorUserId: reservation.userId,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
      }),
    ]);
    return { ok: true, availableSubunits: availableSubunits(period) };
  });
}

/** Release whatever is still held. Charges already settled are untouched. */
export async function releaseReservation(
  reservationId: string,
  reason: string,
  finalStatus: Extract<
    CreditReservation["status"],
    "settled" | "released" | "pending_reconciliation"
  > = "released",
): Promise<void> {
  await withTx(async (tx) => {
    const reservation = await lockReservation(tx, reservationId);
    if (!reservation) return;
    if (reservation.status !== "open") return;

    if (finalStatus === "pending_reconciliation") {
      // Keep the hold: the provider may still have billed for this work.
      await updateReservation(tx, {
        ...reservation,
        status: "pending_reconciliation",
        note: reason,
        updatedAt: now(),
      });
      return;
    }

    const period = await selectPeriodById(tx, reservation.periodId, true);
    const held = reservation.amountSubunits;
    if (period && held > 0) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.updatedAt = now();
      await savePeriod(tx, period);
    }
    await updateReservation(tx, {
      ...reservation,
      amountSubunits: 0,
      status: finalStatus,
      closedAt: now(),
      updatedAt: now(),
    });
    if (held > 0) {
      await appendLedgerEntries(tx, [
        draft({
          userId: reservation.userId,
          periodId: reservation.periodId,
          type: "reservation_release",
          deltaSubunits: held,
          balanceAfterSubunits: period ? availableSubunits(period) : null,
          reason,
          actorUserId: null,
          reservationId: reservation.id,
          projectKind: reservation.projectKind,
          projectId: reservation.projectId,
          runId: reservation.runId,
        }),
      ]);
    }
  });
}

export async function getReservation(id: string): Promise<CreditReservation | null> {
  return selectReservation(getDb(), id, false);
}

/* ────────────────────────── Provider call settlement ───────────────────── */

export interface SettleInput {
  idempotencyKey: string;
  initiatedByUserId: string;
  chargedUserId: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  provider: ProviderId;
  model: string | null;
  endpoint: string | null;
  operation: string;
  providerRequestId: string | null;
  usage: ProviderUsageUnits;
  usageConfidence: UsageConfidence;
  creditsCharged: number;
  estimatedCostUsdMicros: number | null;
  conversionRuleVersion: number;
  status: ProviderCallStatus;
  errorMessage: string | null;
  reservationId: string | null;
  startedAt: string;
  durationMs: number;
  /** Held subunits to give back now (typically this step's per-call ceiling). */
  releaseSubunits: number;
}

export interface SettleResult {
  call: ProviderCallRecord;
  /** True when an identical settlement had already been recorded. */
  duplicate: boolean;
  availableSubunits: number | null;
  /** Charge in excess of what was held — surfaced to admins. */
  overageSubunits: number;
}

/**
 * Record a provider call and charge for it exactly once.
 *
 * Idempotent on `idempotencyKey`: a retried settlement (duplicate callback,
 * repeated request, re-entrant error handler) returns the original record and
 * changes no balance. Settlements of one key serialize on an advisory key
 * (taken before any credits lock); a unique index backs it up.
 */
export async function settleProviderCall(input: SettleInput): Promise<SettleResult> {
  return withTx(async (tx) => {
    await lockIdempotencyKey(tx, input.idempotencyKey);
    const existing = await selectProviderCallByKey(tx, input.idempotencyKey);
    if (existing) {
      const period = await selectCurrentPeriod(tx, existing.chargedUserId);
      return {
        call: existing,
        duplicate: true,
        availableSubunits: period ? availableSubunits(period) : null,
        overageSubunits: 0,
      };
    }

    const timestamp = now();
    // Lock the charged user and the reservation's owner (normally the same), sorted.
    const peek = input.reservationId ? await selectReservation(tx, input.reservationId, false) : null;
    const owners = [input.chargedUserId, ...(peek ? [peek.userId] : [])];
    await lockCreditUsers(tx, owners);
    for (const userId of [...new Set(owners)].sort()) await lockCurrentPeriod(tx, userId);

    let reservation = input.reservationId ? await selectReservation(tx, input.reservationId, true) : null;
    let period = reservation ? await selectPeriodById(tx, reservation.periodId, true) : null;
    if (!period) {
      period = await ensureCurrentPeriod(tx, input.chargedUserId);
      // A roll may have moved the reservation to the new period.
      if (reservation) reservation = await selectReservation(tx, reservation.id, true);
    }

    const pending = input.usageConfidence === "pending_reconciliation";
    const charge = pending ? 0 : Math.max(0, input.creditsCharged);

    const call: ProviderCallRecord = {
      id: crypto.randomUUID(),
      idempotencyKey: input.idempotencyKey,
      initiatedByUserId: input.initiatedByUserId,
      chargedUserId: input.chargedUserId,
      projectKind: input.projectKind,
      projectId: input.projectId,
      runId: input.runId,
      provider: input.provider,
      model: input.model,
      endpoint: input.endpoint,
      operation: input.operation,
      providerRequestId: input.providerRequestId,
      usage: input.usage,
      usageConfidence: input.usageConfidence,
      creditsCharged: charge,
      estimatedCostUsdMicros: input.estimatedCostUsdMicros,
      conversionRuleVersion: input.conversionRuleVersion,
      status: input.status,
      errorMessage: input.errorMessage,
      reservationId: input.reservationId,
      startedAt: input.startedAt,
      completedAt: timestamp,
      durationMs: input.durationMs,
      settledAt: pending ? null : timestamp,
    };
    if (!(await insertProviderCall(tx, call))) {
      // Unreachable while the key lock is held; refuse rather than double-charge.
      throw new Error(`settleProviderCall: idempotency key already recorded: ${input.idempotencyKey}`);
    }

    // Release the slice of the hold this step reserved. When the actual charge
    // exceeds the hold the excess is still billed and reported as an overage
    // rather than silently absorbed.
    let released = 0;
    let reservationChanged = false;
    if (reservation && reservation.status === "open" && !pending) {
      released = Math.min(reservation.amountSubunits, input.releaseSubunits);
      reservation.amountSubunits -= released;
      reservation.settledSubunits += charge;
      reservation.updatedAt = timestamp;
      period.reservedSubunits = Math.max(0, period.reservedSubunits - released);
      reservationChanged = true;
    }
    const overage = Math.max(0, charge - released);

    if (charge > 0) {
      period.consumedSubunits += charge;
    }
    period.updatedAt = timestamp;

    const drafts: LedgerDraft[] = [];
    if (released > 0) {
      drafts.push(
        draft({
          userId: input.chargedUserId,
          periodId: period.id,
          type: "reservation_release",
          deltaSubunits: released,
          balanceAfterSubunits: null,
          reason: `Hold released on settlement of ${input.operation}`,
          actorUserId: null,
          providerCallId: call.id,
          reservationId: input.reservationId,
          projectKind: input.projectKind,
          projectId: input.projectId,
          runId: input.runId,
          provider: input.provider,
          conversionRuleVersion: input.conversionRuleVersion,
        }),
      );
    }
    if (charge > 0) {
      drafts.push(
        draft({
          userId: input.chargedUserId,
          periodId: period.id,
          type: "charge",
          deltaSubunits: -charge,
          balanceAfterSubunits: availableSubunits(period),
          reason:
            overage > 0
              ? `${input.operation} (${input.usageConfidence}); exceeded hold by ${overage} subunits`
              : `${input.operation} (${input.usageConfidence})`,
          actorUserId: input.initiatedByUserId,
          providerCallId: call.id,
          reservationId: input.reservationId,
          projectKind: input.projectKind,
          projectId: input.projectId,
          runId: input.runId,
          provider: input.provider,
          conversionRuleVersion: input.conversionRuleVersion,
          idempotencyKey: input.idempotencyKey,
        }),
      );
    }
    if (drafts.length) await appendLedgerEntries(tx, drafts);

    if (pending && reservation && reservation.status === "open") {
      // Do not hand the credits back: the call may have been billed upstream.
      reservation.status = "pending_reconciliation";
      reservation.note = "Billing outcome unknown (timeout)";
      reservation.updatedAt = timestamp;
      reservationChanged = true;
    }

    if (reservation && reservationChanged) await updateReservation(tx, reservation);
    await savePeriod(tx, period);

    return {
      call,
      duplicate: false,
      availableSubunits: availableSubunits(period),
      overageSubunits: overage,
    };
  });
}

/* ─────────────────────────────── Read models ───────────────────────────── */

export interface CreditSummary {
  allowanceSubunits: number;
  consumedSubunits: number;
  reservedSubunits: number;
  availableSubunits: number;
  periodId: string | null;
  periodStartsAt: string | null;
  nextResetAt: string | null;
  resetCadence: ResetCadence;
  lowCreditWarningSubunits: number;
  lowCredit: boolean;
  pendingReconciliationCount: number;
  pendingReconciliationSubunits: number;
  /** Active admins are not blocked by an allowance. */
  unlimited: boolean;
}

export async function getCreditSummary(userId: string): Promise<CreditSummary> {
  const db = getDb();
  const appSettings = await getAppSettings(db);
  const period = await selectCurrentPeriod(db, userId);
  const pending = await selectReservations(db, { userId, status: "pending_reconciliation" });
  const user = await readUser(db, userId);
  const unlimited = userHasUnlimitedCredits(user);
  const available = period ? availableSubunits(period) : 0;
  return {
    allowanceSubunits: period?.allowanceSubunits ?? 0,
    consumedSubunits: period?.consumedSubunits ?? 0,
    reservedSubunits: period?.reservedSubunits ?? 0,
    availableSubunits: available,
    periodId: period?.id ?? null,
    periodStartsAt: period?.startsAt ?? null,
    nextResetAt: period?.nextResetAt ?? null,
    resetCadence: period?.resetCadence ?? appSettings.defaultResetCadence,
    lowCreditWarningSubunits: appSettings.lowCreditWarningSubunits,
    lowCredit: unlimited
      ? false
      : available <= appSettings.lowCreditWarningSubunits,
    unlimited,
    pendingReconciliationCount: pending.length,
    pendingReconciliationSubunits: pending.reduce(
      (sum, r) => sum + r.amountSubunits,
      0,
    ),
  };
}

export interface UsageQuery {
  chargedUserId?: string;
  /** Limit to calls charged to any of these users (an organisation). */
  chargedUserIds?: Set<string> | null;
  projectId?: string;
  projectKind?: ProjectKind;
  runId?: string;
  provider?: ProviderId;
  status?: ProviderCallStatus;
  confidence?: UsageConfidence;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function queryProviderCalls(query: UsageQuery = {}): Promise<{
  rows: ProviderCallRecord[];
  total: number;
}> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const param = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.chargedUserId) conditions.push(`user_id = ${param(query.chargedUserId)}`);
  if (query.chargedUserIds) conditions.push(`user_id = any(${param([...query.chargedUserIds])}::text[])`);
  if (query.projectId) conditions.push(`data->>'projectId' = ${param(query.projectId)}`);
  if (query.projectKind) conditions.push(`data->>'projectKind' = ${param(query.projectKind)}`);
  if (query.runId) conditions.push(`run_id = ${param(query.runId)}`);
  if (query.provider) conditions.push(`provider = ${param(query.provider)}`);
  if (query.status) conditions.push(`data->>'status' = ${param(query.status)}`);
  if (query.confidence) conditions.push(`data->>'usageConfidence' = ${param(query.confidence)}`);
  // String comparison, as service.ts did with ISO strings.
  if (query.from) conditions.push(`(data->>'startedAt') collate "C" >= ${param(query.from)}`);
  if (query.to) conditions.push(`(data->>'startedAt') collate "C" <= ${param(query.to)}`);
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";

  const db = getDb();
  const { rows: count } = await db.query<{ n: string | number }>(
    `select count(*) as n from provider_calls ${where}`,
    params,
  );
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  // Newest first; ties keep settlement order, as the store's stable sort did.
  const { rows } = await db.query<{ data: ProviderCallRecord }>(
    `select data from provider_calls ${where}
      order by (data->>'startedAt') collate "C" desc, (data->>'completedAt') collate "C" asc, id asc
      limit ${param(limit)} offset ${param(offset)}`,
    params,
  );
  return { rows: rows.map((r) => r.data), total: Number(count[0]?.n ?? 0) };
}

export interface ProviderBreakdownRow {
  provider: ProviderId;
  calls: number;
  creditsCharged: number;
  estimatedCostUsdMicros: number | null;
  confirmedCalls: number;
  estimatedCalls: number;
  pendingCalls: number;
  failedCalls: number;
}

export async function usageByProvider(query: UsageQuery = {}): Promise<ProviderBreakdownRow[]> {
  const { rows } = await queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
  const map = new Map<ProviderId, ProviderBreakdownRow>();
  for (const call of rows) {
    const row =
      map.get(call.provider) ??
      ({
        provider: call.provider,
        calls: 0,
        creditsCharged: 0,
        estimatedCostUsdMicros: null,
        confirmedCalls: 0,
        estimatedCalls: 0,
        pendingCalls: 0,
        failedCalls: 0,
      } satisfies ProviderBreakdownRow);
    row.calls += 1;
    row.creditsCharged += call.creditsCharged;
    if (call.estimatedCostUsdMicros !== null) {
      row.estimatedCostUsdMicros =
        (row.estimatedCostUsdMicros ?? 0) + call.estimatedCostUsdMicros;
    }
    if (call.usageConfidence === "confirmed") row.confirmedCalls += 1;
    if (call.usageConfidence === "estimated") row.estimatedCalls += 1;
    if (call.usageConfidence === "pending_reconciliation") row.pendingCalls += 1;
    if (call.status === "failed" || call.status === "timeout") {
      row.failedCalls += 1;
    }
    map.set(call.provider, row);
  }
  return [...map.values()].sort((a, b) => b.creditsCharged - a.creditsCharged);
}

export async function usageByDate(query: UsageQuery = {}): Promise<Array<{
  date: string;
  calls: number;
  creditsCharged: number;
}>> {
  const { rows } = await queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
  const map = new Map<string, { date: string; calls: number; creditsCharged: number }>();
  for (const call of rows) {
    const date = call.startedAt.slice(0, 10);
    const row = map.get(date) ?? { date, calls: 0, creditsCharged: 0 };
    row.calls += 1;
    row.creditsCharged += call.creditsCharged;
    map.set(date, row);
  }
  return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface RunUsageRow {
  runId: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  operation: string;
  calls: number;
  creditsCharged: number;
  pendingCalls: number;
  failedCalls: number;
  startedAt: string;
  completedAt: string;
}

/** Per-run credit totals, newest first. */
export async function usageByRun(query: UsageQuery = {}): Promise<RunUsageRow[]> {
  const { rows } = await queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
  const map = new Map<string, RunUsageRow>();
  for (const call of rows) {
    const key = call.runId ?? `${call.projectKind ?? "none"}:${call.projectId ?? call.id}`;
    const row =
      map.get(key) ??
      ({
        runId: key,
        projectKind: call.projectKind,
        projectId: call.projectId,
        operation: call.operation,
        calls: 0,
        creditsCharged: 0,
        pendingCalls: 0,
        failedCalls: 0,
        startedAt: call.startedAt,
        completedAt: call.completedAt,
      } satisfies RunUsageRow);
    row.calls += 1;
    row.creditsCharged += call.creditsCharged;
    if (call.usageConfidence === "pending_reconciliation") row.pendingCalls += 1;
    if (call.status === "failed" || call.status === "timeout") row.failedCalls += 1;
    if (call.startedAt < row.startedAt) row.startedAt = call.startedAt;
    if (call.completedAt > row.completedAt) row.completedAt = call.completedAt;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
}

/**
 * Credits charged against one run. Pass `chargedUserId` to scope the total to a
 * single payer — required anywhere a shared project is shown, because each
 * participant pays from their own allowance and must not see the others' spend.
 */
export async function creditsForRun(
  runId: string,
  chargedUserId?: string,
): Promise<{
  creditsCharged: number;
  pendingCalls: number;
}> {
  const params: unknown[] = [runId];
  if (chargedUserId !== undefined) params.push(chargedUserId);
  const { rows } = await getDb().query<{ credits: string | number | null; pending: string | number }>(
    `select coalesce(sum((data->>'creditsCharged')::numeric), 0) as credits,
            count(*) filter (where data->>'usageConfidence' = 'pending_reconciliation') as pending
       from provider_calls
      where run_id = $1${chargedUserId !== undefined ? " and user_id = $2" : ""}`,
    params,
  );
  return {
    creditsCharged: Number(rows[0]?.credits ?? 0),
    pendingCalls: Number(rows[0]?.pending ?? 0),
  };
}

export async function countOpenReservations(userId: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    "select count(*)::int as n from credit_reservations where user_id = $1 and status = 'open'",
    [userId],
  );
  return rows[0]?.n ?? 0;
}

/** Credits charged per run id (calls without a run id are not counted). */
export async function creditsByRun(runIds: string[]): Promise<Map<string, number>> {
  if (!runIds.length) return new Map();
  const { rows } = await getDb().query<{ run_id: string; credits: string | number }>(
    `select run_id, coalesce(sum((data->>'creditsCharged')::numeric), 0) as credits
       from provider_calls
      where run_id = any($1::text[])
      group by run_id`,
    [runIds],
  );
  return new Map(rows.map((r) => [r.run_id, Number(r.credits)]));
}

/** Sum of `usage.requests` over a provider's calls for one provider request (e.g. a Manus task). */
export async function sumProviderRequestUsage(provider: ProviderId, providerRequestId: string): Promise<number> {
  const { rows } = await getDb().query<{ total: string | number | null }>(
    `select coalesce(sum((data->'usage'->>'requests')::numeric), 0) as total
       from provider_calls
      where provider = $1 and data->>'providerRequestId' = $2`,
    [provider, providerRequestId],
  );
  return Number(rows[0]?.total ?? 0);
}

export interface PeriodTotals {
  allocatedSubunits: number;
  consumedSubunits: number;
  reservedSubunits: number;
}

/** Totals over current periods; `userIds` limits them to those users (an organisation). */
export async function currentPeriodTotals(userIds?: Set<string> | null): Promise<PeriodTotals> {
  const { rows } = await getDb().query<{ allocated: string | number; consumed: string | number; reserved: string | number }>(
    `select coalesce(sum(allowance), 0) as allocated,
            coalesce(sum(consumed), 0)  as consumed,
            coalesce(sum(reserved), 0)  as reserved
       from credit_periods
      where status = 'current'${userIds ? " and user_id = any($1::text[])" : ""}`,
    userIds ? [[...userIds]] : [],
  );
  return {
    allocatedSubunits: Number(rows[0]?.allocated ?? 0),
    consumedSubunits: Number(rows[0]?.consumed ?? 0),
    reservedSubunits: Number(rows[0]?.reserved ?? 0),
  };
}

/** Reservations held for one run, oldest first; `userIds` limits them to those users. */
export async function listRunReservations(runId: string, userIds?: Set<string> | null): Promise<CreditReservation[]> {
  const { rows } = await getDb().query<{ data: CreditReservation }>(
    `select data from credit_reservations
      where data->>'runId' = $1${userIds ? " and user_id = any($2::text[])" : ""}
      order by (data->>'createdAt') collate "C" asc, id asc`,
    userIds ? [runId, [...userIds]] : [runId],
  );
  return rows.map((r) => r.data);
}

/** Reservations an admin still needs to resolve. */
export async function listPendingReconciliation(): Promise<CreditReservation[]> {
  const rows = await selectReservations(getDb(), { status: "pending_reconciliation" });
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function resolveReconciliation(input: {
  reservationId: string;
  actorUserId: string;
  chargeSubunits: number;
  reason: string;
}): Promise<boolean> {
  return withTx(async (tx) => {
    const reservation = await lockReservation(tx, input.reservationId);
    if (!reservation || reservation.status !== "pending_reconciliation") {
      return false;
    }
    const period = await selectPeriodById(tx, reservation.periodId, true);
    const timestamp = now();
    const held = reservation.amountSubunits;
    const charge = Math.max(0, Math.min(input.chargeSubunits, held));

    if (period) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.consumedSubunits += charge;
      period.updatedAt = timestamp;
      await savePeriod(tx, period);
    }
    await updateReservation(tx, {
      ...reservation,
      amountSubunits: 0,
      settledSubunits: reservation.settledSubunits + charge,
      status: "settled",
      closedAt: timestamp,
      updatedAt: timestamp,
      note: input.reason,
    });

    await appendLedgerEntries(tx, [
      draft({
        userId: reservation.userId,
        periodId: reservation.periodId,
        type: "reservation_release",
        deltaSubunits: held,
        balanceAfterSubunits: null,
        reason: `Reconciliation resolved: ${input.reason}`,
        actorUserId: input.actorUserId,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
      }),
      ...(charge > 0
        ? [
            draft({
              userId: reservation.userId,
              periodId: reservation.periodId,
              type: "charge",
              deltaSubunits: -charge,
              balanceAfterSubunits: period ? availableSubunits(period) : null,
              reason: `Reconciled charge: ${input.reason}`,
              actorUserId: input.actorUserId,
              reservationId: reservation.id,
              projectKind: reservation.projectKind,
              projectId: reservation.projectId,
              runId: reservation.runId,
            }),
          ]
        : []),
    ]);
    return true;
  });
}

/** Confirms the account is still allowed to spend before a queued job runs. */
export async function assertSpendStillAuthorized(userId: string): Promise<boolean> {
  const user = await getUserById(userId);
  return !!user && user.status === "active";
}
