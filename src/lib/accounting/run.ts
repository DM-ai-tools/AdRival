import { getAppSettings } from "@/lib/db";
import type { AppUser, ProjectKind } from "@/lib/types";
import { runWithBillingContext } from "./context";
import {
  InsufficientCreditsError,
  LOW_CREDIT_MESSAGE,
  SpendAuthorizationRevokedError,
} from "./errors";
import {
  countOpenReservations,
  creditsForRun,
  getCreditSummary,
  releaseReservation,
  reserveCredits,
  sweepAbandonedReservations,
} from "./service";
import { creditsToSubunits } from "./units";

/** Opening hold for a run whose eventual size is not yet known. */
const DEFAULT_INITIAL_HOLD = creditsToSubunits(25);

export class TooManyConcurrentRunsError extends Error {
  readonly code = "too_many_concurrent_runs";
  constructor(limit: number) {
    super(
      `You already have ${limit} task(s) running. Wait for one to finish before starting another.`,
    );
    this.name = "TooManyConcurrentRunsError";
  }
}

export interface BillableRunOptions {
  user: AppUser;
  operation: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  /** Opening hold in subunits. */
  initialHoldSubunits?: number;
  /** Cap on this run's total spend, in subunits. Clamped by app settings. */
  runBudgetSubunits?: number;
}

export interface RunPrecheck {
  ok: boolean;
  reason?: "insufficient_credits" | "too_many_concurrent_runs" | "suspended";
  message?: string;
  requiredSubunits: number;
  availableSubunits: number;
}

/**
 * Cheap read-only check so the UI can warn before a run is attempted. The
 * authoritative check is the atomic reservation inside `runBillable`.
 */
export function precheckRun(
  user: AppUser,
  initialHoldSubunits = DEFAULT_INITIAL_HOLD,
): RunPrecheck {
  const summary = getCreditSummary(user.id);
  if (user.status !== "active") {
    return {
      ok: false,
      reason: "suspended",
      message: "Your account is suspended. Contact your administrator.",
      requiredSubunits: initialHoldSubunits,
      availableSubunits: summary.availableSubunits,
    };
  }
  const settings = getAppSettings();
  const limit = user.maxConcurrentRuns ?? settings.maxConcurrentRunsPerUser;
  if (countOpenReservations(user.id) >= limit) {
    return {
      ok: false,
      reason: "too_many_concurrent_runs",
      message: new TooManyConcurrentRunsError(limit).message,
      requiredSubunits: initialHoldSubunits,
      availableSubunits: summary.availableSubunits,
    };
  }
  if (user.role === "admin") {
    return {
      ok: true,
      requiredSubunits: initialHoldSubunits,
      availableSubunits: summary.availableSubunits,
    };
  }
  if (summary.availableSubunits < initialHoldSubunits) {
    return {
      ok: false,
      reason: "insufficient_credits",
      message: LOW_CREDIT_MESSAGE,
      requiredSubunits: initialHoldSubunits,
      availableSubunits: summary.availableSubunits,
    };
  }
  return {
    ok: true,
    requiredSubunits: initialHoldSubunits,
    availableSubunits: summary.availableSubunits,
  };
}

/**
 * Run billable work inside a credit reservation and a billing context.
 *
 * Order matters: the account and concurrency checks happen first, then the
 * atomic reservation, and only then is `fn` invoked — so no provider is
 * contacted for a run that could not be funded. Whatever is left of the hold is
 * released when `fn` settles, unless the run parked a call as pending
 * reconciliation.
 */
export async function runBillable<T>(
  options: BillableRunOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const { user } = options;
  if (user.status !== "active") {
    throw new SpendAuthorizationRevokedError(
      "Your account is suspended. Contact your administrator.",
    );
  }

  // Reclaim holds abandoned by a crashed process before measuring the balance.
  sweepAbandonedReservations();

  const settings = getAppSettings();
  const concurrencyLimit =
    user.maxConcurrentRuns ?? settings.maxConcurrentRunsPerUser;
  if (countOpenReservations(user.id) >= concurrencyLimit) {
    throw new TooManyConcurrentRunsError(concurrencyLimit);
  }

  const runBudget = Math.min(
    options.runBudgetSubunits ?? settings.maxRunReservationSubunits,
    settings.maxRunReservationSubunits,
  );
  const initialHold = Math.min(
    options.initialHoldSubunits ?? DEFAULT_INITIAL_HOLD,
    runBudget,
  );

  const reserved = reserveCredits({
    userId: user.id,
    amountSubunits: initialHold,
    operation: options.operation,
    projectKind: options.projectKind,
    projectId: options.projectId,
    runId: options.runId,
  });
  if (!reserved.ok) {
    if (reserved.reason === "account_not_active") {
      throw new SpendAuthorizationRevokedError();
    }
    throw new InsufficientCreditsError(
      reserved.requiredSubunits,
      reserved.availableSubunits,
    );
  }

  const reservationId = reserved.reservation.id;
  try {
    return await runWithBillingContext(
      {
        initiatedByUserId: user.id,
        // The runner always pays, including inside a project shared with them.
        chargedUserId: user.id,
        projectKind: options.projectKind,
        projectId: options.projectId,
        runId: options.runId,
        reservationId,
        runBudgetSubunits: runBudget,
      },
      fn,
    );
  } finally {
    // No-op when the run already parked the reservation for reconciliation.
    releaseReservation(reservationId, "Run finished", "settled");
  }
}

export interface RunCreditReport {
  runCreditsCharged: number;
  availableSubunits: number;
  pendingCalls: number;
}

/** Numbers behind "This run used X credits. You have Y credits available." */
export function reportRunCredits(userId: string, runId: string): RunCreditReport {
  // Scoped to this payer: inside a shared project each user sees only their own
  // charges, never the project owner's.
  const { creditsCharged, pendingCalls } = creditsForRun(runId, userId);
  return {
    runCreditsCharged: creditsCharged,
    availableSubunits: getCreditSummary(userId).availableSubunits,
    pendingCalls,
  };
}
