import {
  defaultAppSettings,
  getUserById,
  readDb,
  transaction,
} from "@/lib/db";
import type {
  AppSettings,
  CreditPeriod,
  CreditReservation,
  DatabaseShape,
  ProjectKind,
  ProviderCallRecord,
  ProviderCallStatus,
  ProviderId,
  ProviderUsageUnits,
  ResetCadence,
  UsageConfidence,
} from "@/lib/types";
import { appendLedgerEntries } from "./records";

/** How long a reservation may go without a heartbeat before it is recoverable. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

function now(): string {
  return new Date().toISOString();
}

function settings(db: DatabaseShape): AppSettings {
  return db.appSettings ?? defaultAppSettings();
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

/* ───────────────────────────── Allocation periods ───────────────────────── */

export function availableSubunits(period: CreditPeriod): number {
  return (
    period.allowanceSubunits - period.consumedSubunits - period.reservedSubunits
  );
}

function findCurrentPeriod(
  db: DatabaseShape,
  userId: string,
): CreditPeriod | null {
  return (
    (db.creditPeriods ?? []).find(
      (p) => p.userId === userId && p.status === "current",
    ) ?? null
  );
}

function openPeriod(
  db: DatabaseShape,
  userId: string,
  input: {
    allowanceSubunits: number;
    resetCadence: ResetCadence;
    actorUserId: string | null;
    reason: string;
  },
): CreditPeriod {
  if (!db.creditPeriods) db.creditPeriods = [];
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
  db.creditPeriods.push(period);
  appendLedgerEntries(db, [
    {
      userId,
      periodId: period.id,
      type: "period_open",
      deltaSubunits: 0,
      balanceAfterSubunits: 0,
      reason: input.reason,
      actorUserId: input.actorUserId,
      providerCallId: null,
      reservationId: null,
      projectKind: null,
      projectId: null,
      runId: null,
      provider: null,
      conversionRuleVersion: null,
      idempotencyKey: null,
    },
    {
      userId,
      periodId: period.id,
      type: "allowance_set",
      deltaSubunits: input.allowanceSubunits,
      balanceAfterSubunits: input.allowanceSubunits,
      reason: input.reason,
      actorUserId: input.actorUserId,
      providerCallId: null,
      reservationId: null,
      projectKind: null,
      projectId: null,
      runId: null,
      provider: null,
      conversionRuleVersion: null,
      idempotencyKey: null,
    },
  ]);
  return period;
}

/**
 * Roll a monthly period when its reset date has passed.
 *
 * The closed period keeps its allowance/consumed figures for history. Open
 * reservations move to the new period along with their held amount, so credits
 * held by an in-flight run are neither lost nor spendable twice.
 */
function maybeRollPeriod(db: DatabaseShape, period: CreditPeriod): CreditPeriod {
  if (period.resetCadence !== "monthly" || !period.nextResetAt) return period;
  if (period.nextResetAt > now()) return period;

  const timestamp = now();
  period.status = "closed";
  period.endsAt = timestamp;
  period.updatedAt = timestamp;

  const openReservations = (db.creditReservations ?? []).filter(
    (r) =>
      r.periodId === period.id &&
      (r.status === "open" || r.status === "pending_reconciliation"),
  );
  const carriedHold = openReservations.reduce(
    (sum, r) => sum + r.amountSubunits,
    0,
  );
  period.reservedSubunits -= carriedHold;

  appendLedgerEntries(db, [
    {
      userId: period.userId,
      periodId: period.id,
      type: "period_close",
      deltaSubunits: 0,
      balanceAfterSubunits: availableSubunits(period),
      reason: `Allocation period closed; ${openReservations.length} reservation(s) carried forward`,
      actorUserId: null,
      providerCallId: null,
      reservationId: null,
      projectKind: null,
      projectId: null,
      runId: null,
      provider: null,
      conversionRuleVersion: null,
      idempotencyKey: null,
    },
  ]);

  const next = openPeriod(db, period.userId, {
    allowanceSubunits: period.allowanceSubunits,
    resetCadence: "monthly",
    actorUserId: null,
    reason: "Monthly allowance reset",
  });
  next.startsAt = period.nextResetAt;
  next.nextResetAt = addMonthsIso(period.nextResetAt, 1);

  for (const reservation of openReservations) {
    reservation.periodId = next.id;
    reservation.updatedAt = timestamp;
    next.reservedSubunits += reservation.amountSubunits;
  }
  return next;
}

/**
 * Return the user's current allocation period, opening one on first use.
 *
 * A lazily-opened period starts at zero allowance — never at the configured
 * default — so an existing account can't silently gain credits.
 */
export function ensureCurrentPeriod(
  db: DatabaseShape,
  userId: string,
  seed?: { allowanceSubunits: number; resetCadence: ResetCadence; reason: string },
): CreditPeriod {
  const existing = findCurrentPeriod(db, userId);
  if (existing) return maybeRollPeriod(db, existing);
  return openPeriod(db, userId, {
    allowanceSubunits: seed?.allowanceSubunits ?? 0,
    resetCadence: seed?.resetCadence ?? settings(db).defaultResetCadence,
    actorUserId: null,
    reason: seed?.reason ?? "First allocation period opened",
  });
}

/** Called at registration/creation so the account starts with a real period. */
export function initializeUserCredits(
  userId: string,
  input: { allowanceSubunits: number; resetCadence: ResetCadence; reason: string },
): CreditPeriod {
  return transaction((db) => ensureCurrentPeriod(db, userId, input));
}

export function listPeriods(userId: string): CreditPeriod[] {
  return (readDb().creditPeriods ?? [])
    .filter((p) => p.userId === userId)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
}

/* ─────────────────────── Admin allowance adjustments ────────────────────── */

export interface AllowanceChange {
  userId: string;
  actorUserId: string;
  reason: string;
}

export function setAllowance(
  input: AllowanceChange & { allowanceSubunits: number },
): CreditPeriod {
  return transaction((db) => {
    const period = ensureCurrentPeriod(db, input.userId);
    const delta = input.allowanceSubunits - period.allowanceSubunits;
    period.allowanceSubunits = input.allowanceSubunits;
    period.updatedAt = now();
    appendLedgerEntries(db, [
      {
        userId: input.userId,
        periodId: period.id,
        type: "allowance_set",
        deltaSubunits: delta,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
        providerCallId: null,
        reservationId: null,
        projectKind: null,
        projectId: null,
        runId: null,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
    ]);
    return period;
  });
}

export function addCredits(
  input: AllowanceChange & { amountSubunits: number },
): CreditPeriod {
  return transaction((db) => {
    const period = ensureCurrentPeriod(db, input.userId);
    period.allowanceSubunits += input.amountSubunits;
    period.updatedAt = now();
    appendLedgerEntries(db, [
      {
        userId: input.userId,
        periodId: period.id,
        type: "allowance_added",
        deltaSubunits: input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
        providerCallId: null,
        reservationId: null,
        projectKind: null,
        projectId: null,
        runId: null,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
    ]);
    return period;
  });
}

/**
 * Correct a past charge without rewriting it. A positive amount refunds the
 * user; a negative amount bills them. The original charge row is untouched.
 */
export function recordAdjustment(
  input: AllowanceChange & { amountSubunits: number; providerCallId?: string | null },
): CreditPeriod {
  return transaction((db) => {
    const period = ensureCurrentPeriod(db, input.userId);
    period.consumedSubunits -= input.amountSubunits;
    period.updatedAt = now();
    appendLedgerEntries(db, [
      {
        userId: input.userId,
        periodId: period.id,
        type: "adjustment",
        deltaSubunits: input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: input.reason,
        actorUserId: input.actorUserId,
        providerCallId: input.providerCallId ?? null,
        reservationId: null,
        projectKind: null,
        projectId: null,
        runId: null,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
    ]);
    return period;
  });
}

export function setResetCadence(
  input: AllowanceChange & { cadence: ResetCadence },
): CreditPeriod {
  return transaction((db) => {
    const period = ensureCurrentPeriod(db, input.userId);
    period.resetCadence = input.cadence;
    period.nextResetAt =
      input.cadence === "monthly" ? addMonthsIso(now(), 1) : null;
    period.updatedAt = now();
    return period;
  });
}

/* ──────────────────────────────── Reservations ──────────────────────────── */

/**
 * Release holds for reservations whose owning process stopped heartbeating.
 * Reservations explicitly parked as `pending_reconciliation` are left alone —
 * their billing outcome is unknown and an admin must resolve them.
 */
export function recoverAbandonedReservations(db: DatabaseShape): number {
  const timestamp = now();
  let recovered = 0;
  for (const reservation of db.creditReservations ?? []) {
    if (reservation.status !== "open") continue;
    if (reservation.expiresAt > timestamp) continue;
    const period = (db.creditPeriods ?? []).find(
      (p) => p.id === reservation.periodId,
    );
    const held = reservation.amountSubunits;
    if (period && held > 0) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.updatedAt = timestamp;
    }
    reservation.amountSubunits = 0;
    reservation.status = "expired";
    reservation.closedAt = timestamp;
    reservation.updatedAt = timestamp;
    if (held > 0) {
      appendLedgerEntries(db, [
        {
          userId: reservation.userId,
          periodId: reservation.periodId,
          type: "reservation_release",
          deltaSubunits: held,
          balanceAfterSubunits: period ? availableSubunits(period) : null,
          reason: "Abandoned reservation recovered",
          actorUserId: null,
          providerCallId: null,
          reservationId: reservation.id,
          projectKind: reservation.projectKind,
          projectId: reservation.projectId,
          runId: reservation.runId,
          provider: null,
          conversionRuleVersion: null,
          idempotencyKey: null,
        },
      ]);
    }
    recovered += 1;
  }
  return recovered;
}

export function sweepAbandonedReservations(): number {
  return transaction((db) => recoverAbandonedReservations(db));
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
 * Atomically hold credits. Runs under the store's exclusive lock together with
 * the balance read, so two concurrent runs cannot both see the same available
 * balance and overspend it.
 */
export function reserveCredits(input: {
  userId: string;
  amountSubunits: number;
  operation: string;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  runId?: string | null;
  note?: string | null;
  ttlMs?: number;
}): ReserveResult {
  return transaction((db) => {
    recoverAbandonedReservations(db);

    const user = (db.users ?? []).find((u) => u.id === input.userId);
    if (!user || user.status !== "active") {
      return {
        ok: false as const,
        reason: "account_not_active" as const,
        requiredSubunits: input.amountSubunits,
        availableSubunits: 0,
      };
    }

    const period = ensureCurrentPeriod(db, input.userId);
    const unlimited = userHasUnlimitedCredits(user);
    const available = availableSubunits(period);
    if (!unlimited && input.amountSubunits > available) {
      return {
        ok: false as const,
        reason: "insufficient_credits" as const,
        requiredSubunits: input.amountSubunits,
        availableSubunits: available,
      };
    }

    if (!db.creditReservations) db.creditReservations = [];
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
    db.creditReservations.push(reservation);

    period.reservedSubunits += input.amountSubunits;
    period.updatedAt = timestamp;

    appendLedgerEntries(db, [
      {
        userId: input.userId,
        periodId: period.id,
        type: "reservation_hold",
        deltaSubunits: -input.amountSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: `Hold for ${input.operation}`,
        actorUserId: input.userId,
        providerCallId: null,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
    ]);

    return {
      ok: true as const,
      reservation,
      availableSubunits: availableSubunits(period),
    };
  });
}

/** Extend a long-running reservation so recovery does not reclaim it. */
export function touchReservation(reservationId: string, ttlMs = RESERVATION_TTL_MS) {
  transaction((db) => {
    const reservation = (db.creditReservations ?? []).find(
      (r) => r.id === reservationId,
    );
    if (!reservation || reservation.status !== "open") return;
    reservation.expiresAt = new Date(Date.now() + ttlMs).toISOString();
    reservation.updatedAt = now();
  });
}

/** Grow an existing hold for a workflow whose size was not known up front. */
export function extendReservation(
  reservationId: string,
  additionalSubunits: number,
): { ok: boolean; availableSubunits: number } {
  return transaction((db) => {
    const reservation = (db.creditReservations ?? []).find(
      (r) => r.id === reservationId,
    );
    if (!reservation || reservation.status !== "open") {
      return { ok: false, availableSubunits: 0 };
    }
    const period = (db.creditPeriods ?? []).find(
      (p) => p.id === reservation.periodId,
    );
    if (!period) return { ok: false, availableSubunits: 0 };
    const owner = (db.users ?? []).find((u) => u.id === reservation.userId);
    const unlimited = userHasUnlimitedCredits(owner);
    const available = availableSubunits(period);
    if (!unlimited && additionalSubunits > available) {
      return { ok: false, availableSubunits: available };
    }
    reservation.amountSubunits += additionalSubunits;
    reservation.updatedAt = now();
    period.reservedSubunits += additionalSubunits;
    period.updatedAt = now();
    appendLedgerEntries(db, [
      {
        userId: reservation.userId,
        periodId: period.id,
        type: "reservation_hold",
        deltaSubunits: -additionalSubunits,
        balanceAfterSubunits: availableSubunits(period),
        reason: `Incremental hold for ${reservation.operation}`,
        actorUserId: reservation.userId,
        providerCallId: null,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
    ]);
    return { ok: true, availableSubunits: availableSubunits(period) };
  });
}

/** Release whatever is still held. Charges already settled are untouched. */
export function releaseReservation(
  reservationId: string,
  reason: string,
  finalStatus: Extract<
    CreditReservation["status"],
    "settled" | "released" | "pending_reconciliation"
  > = "released",
): void {
  transaction((db) => {
    const reservation = (db.creditReservations ?? []).find(
      (r) => r.id === reservationId,
    );
    if (!reservation) return;
    if (reservation.status !== "open") return;

    if (finalStatus === "pending_reconciliation") {
      // Keep the hold: the provider may still have billed for this work.
      reservation.status = "pending_reconciliation";
      reservation.note = reason;
      reservation.updatedAt = now();
      return;
    }

    const period = (db.creditPeriods ?? []).find(
      (p) => p.id === reservation.periodId,
    );
    const held = reservation.amountSubunits;
    if (period && held > 0) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.updatedAt = now();
    }
    reservation.amountSubunits = 0;
    reservation.status = finalStatus;
    reservation.closedAt = now();
    reservation.updatedAt = now();
    if (held > 0) {
      appendLedgerEntries(db, [
        {
          userId: reservation.userId,
          periodId: reservation.periodId,
          type: "reservation_release",
          deltaSubunits: held,
          balanceAfterSubunits: period ? availableSubunits(period) : null,
          reason,
          actorUserId: null,
          providerCallId: null,
          reservationId: reservation.id,
          projectKind: reservation.projectKind,
          projectId: reservation.projectId,
          runId: reservation.runId,
          provider: null,
          conversionRuleVersion: null,
          idempotencyKey: null,
        },
      ]);
    }
  });
}

export function getReservation(id: string): CreditReservation | null {
  return (readDb().creditReservations ?? []).find((r) => r.id === id) ?? null;
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
 * changes no balance.
 */
export function settleProviderCall(input: SettleInput): SettleResult {
  return transaction((db) => {
    if (!db.providerCalls) db.providerCalls = [];

    const existing = db.providerCalls.find(
      (c) => c.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      const period = (db.creditPeriods ?? []).find(
        (p) => p.userId === existing.chargedUserId && p.status === "current",
      );
      return {
        call: existing,
        duplicate: true,
        availableSubunits: period ? availableSubunits(period) : null,
        overageSubunits: 0,
      };
    }

    const timestamp = now();
    const reservation = input.reservationId
      ? (db.creditReservations ?? []).find((r) => r.id === input.reservationId)
      : undefined;
    const period =
      (reservation &&
        (db.creditPeriods ?? []).find((p) => p.id === reservation.periodId)) ||
      ensureCurrentPeriod(db, input.chargedUserId);

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
    db.providerCalls.push(call);

    // Release the slice of the hold this step reserved. When the actual charge
    // exceeds the hold the excess is still billed and reported as an overage
    // rather than silently absorbed.
    let released = 0;
    if (reservation && reservation.status === "open" && !pending) {
      released = Math.min(reservation.amountSubunits, input.releaseSubunits);
      reservation.amountSubunits -= released;
      reservation.settledSubunits += charge;
      reservation.updatedAt = timestamp;
      period.reservedSubunits = Math.max(0, period.reservedSubunits - released);
    }
    const overage = Math.max(0, charge - released);

    if (charge > 0) {
      period.consumedSubunits += charge;
    }
    period.updatedAt = timestamp;

    const drafts = [];
    if (released > 0) {
      drafts.push({
        userId: input.chargedUserId,
        periodId: period.id,
        type: "reservation_release" as const,
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
        idempotencyKey: null,
      });
    }
    if (charge > 0) {
      drafts.push({
        userId: input.chargedUserId,
        periodId: period.id,
        type: "charge" as const,
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
      });
    }
    if (drafts.length) appendLedgerEntries(db, drafts);

    if (pending && reservation && reservation.status === "open") {
      // Do not hand the credits back: the call may have been billed upstream.
      reservation.status = "pending_reconciliation";
      reservation.note = "Billing outcome unknown (timeout)";
      reservation.updatedAt = timestamp;
    }

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

export function getCreditSummary(userId: string): CreditSummary {
  const db = readDb();
  const appSettings = settings(db);
  const period =
    (db.creditPeriods ?? []).find(
      (p) => p.userId === userId && p.status === "current",
    ) ?? null;
  const pending = (db.creditReservations ?? []).filter(
    (r) => r.userId === userId && r.status === "pending_reconciliation",
  );
  const user = (db.users ?? []).find((u) => u.id === userId);
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

export function queryProviderCalls(query: UsageQuery = {}): {
  rows: ProviderCallRecord[];
  total: number;
} {
  const all = (readDb().providerCalls ?? []).filter((c) => {
    if (query.chargedUserId && c.chargedUserId !== query.chargedUserId) {
      return false;
    }
    if (query.projectId && c.projectId !== query.projectId) return false;
    if (query.projectKind && c.projectKind !== query.projectKind) return false;
    if (query.runId && c.runId !== query.runId) return false;
    if (query.provider && c.provider !== query.provider) return false;
    if (query.status && c.status !== query.status) return false;
    if (query.confidence && c.usageConfidence !== query.confidence) return false;
    if (query.from && c.startedAt < query.from) return false;
    if (query.to && c.startedAt > query.to) return false;
    return true;
  });
  all.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 100;
  return { rows: all.slice(offset, offset + limit), total: all.length };
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

export function usageByProvider(query: UsageQuery = {}): ProviderBreakdownRow[] {
  const { rows } = queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
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

export function usageByDate(query: UsageQuery = {}): Array<{
  date: string;
  calls: number;
  creditsCharged: number;
}> {
  const { rows } = queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
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
export function usageByRun(query: UsageQuery = {}): RunUsageRow[] {
  const { rows } = queryProviderCalls({ ...query, limit: Number.MAX_SAFE_INTEGER });
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

/** Total credits charged for one run — used for the post-run message. */
/**
 * Credits charged against one run. Pass `chargedUserId` to scope the total to a
 * single payer — required anywhere a shared project is shown, because each
 * participant pays from their own allowance and must not see the others' spend.
 */
export function creditsForRun(
  runId: string,
  chargedUserId?: string,
): {
  creditsCharged: number;
  pendingCalls: number;
} {
  const rows = (readDb().providerCalls ?? []).filter(
    (c) =>
      c.runId === runId &&
      (chargedUserId === undefined || c.chargedUserId === chargedUserId),
  );
  return {
    creditsCharged: rows.reduce((sum, c) => sum + c.creditsCharged, 0),
    pendingCalls: rows.filter(
      (c) => c.usageConfidence === "pending_reconciliation",
    ).length,
  };
}

export function countOpenReservations(userId: string): number {
  return (readDb().creditReservations ?? []).filter(
    (r) => r.userId === userId && r.status === "open",
  ).length;
}

/** Reservations an admin still needs to resolve. */
export function listPendingReconciliation(): CreditReservation[] {
  return (readDb().creditReservations ?? [])
    .filter((r) => r.status === "pending_reconciliation")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function resolveReconciliation(input: {
  reservationId: string;
  actorUserId: string;
  chargeSubunits: number;
  reason: string;
}): boolean {
  return transaction((db) => {
    const reservation = (db.creditReservations ?? []).find(
      (r) => r.id === input.reservationId,
    );
    if (!reservation || reservation.status !== "pending_reconciliation") {
      return false;
    }
    const period = (db.creditPeriods ?? []).find(
      (p) => p.id === reservation.periodId,
    );
    const timestamp = now();
    const held = reservation.amountSubunits;
    const charge = Math.max(0, Math.min(input.chargeSubunits, held));

    if (period) {
      period.reservedSubunits = Math.max(0, period.reservedSubunits - held);
      period.consumedSubunits += charge;
      period.updatedAt = timestamp;
    }
    reservation.amountSubunits = 0;
    reservation.settledSubunits += charge;
    reservation.status = "settled";
    reservation.closedAt = timestamp;
    reservation.updatedAt = timestamp;
    reservation.note = input.reason;

    appendLedgerEntries(db, [
      {
        userId: reservation.userId,
        periodId: reservation.periodId,
        type: "reservation_release",
        deltaSubunits: held,
        balanceAfterSubunits: null,
        reason: `Reconciliation resolved: ${input.reason}`,
        actorUserId: input.actorUserId,
        providerCallId: null,
        reservationId: reservation.id,
        projectKind: reservation.projectKind,
        projectId: reservation.projectId,
        runId: reservation.runId,
        provider: null,
        conversionRuleVersion: null,
        idempotencyKey: null,
      },
      ...(charge > 0
        ? [
            {
              userId: reservation.userId,
              periodId: reservation.periodId,
              type: "charge" as const,
              deltaSubunits: -charge,
              balanceAfterSubunits: period ? availableSubunits(period) : null,
              reason: `Reconciled charge: ${input.reason}`,
              actorUserId: input.actorUserId,
              providerCallId: null,
              reservationId: reservation.id,
              projectKind: reservation.projectKind,
              projectId: reservation.projectId,
              runId: reservation.runId,
              provider: null,
              conversionRuleVersion: null,
              idempotencyKey: null,
            },
          ]
        : []),
    ]);
    return true;
  });
}

/** Confirms the account is still allowed to spend before a queued job runs. */
export function assertSpendStillAuthorized(userId: string): boolean {
  const user = getUserById(userId);
  return !!user && user.status === "active";
}
