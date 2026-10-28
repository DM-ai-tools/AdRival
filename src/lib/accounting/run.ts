import { getAppSettings } from "@/lib/db";
import type { AppSettings, AppUser, ProjectKind } from "@/lib/types";
import { scopeOf, type ConcurrencyScope } from "./scope";
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
import type { CreditSummary } from "./service";
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

/** Landing-page builds use their own limit; everything else keeps the shared one. */
function concurrencyLimitFor(
  user: AppUser,
  settings: AppSettings,
  scope: ConcurrencyScope,
): number {
  if (scope === "recreate") {
    // Settings saved before this field existed have no value.
    return settings.maxConcurrentRecreationsPerUser ?? 3;
  }
  return user.maxConcurrentRuns ?? settings.maxConcurrentRunsPerUser;
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
export async function precheckRun(
  user: AppUser,
  initialHoldSubunits = DEFAULT_INITIAL_HOLD,
  operation = "",
): Promise<RunPrecheck> {
  const summary = await getCreditSummary(user.id);
  if (user.status !== "active") {
    return {
      ok: false,
      reason: "suspended",
      message: "Your account is suspended. Contact your administrator.",
      requiredSubunits: initialHoldSubunits,
      availableSubunits: summary.availableSubunits,
    };
  }
  const settings = await getAppSettings();
  const scope = scopeOf(operation);
  const limit = concurrencyLimitFor(user, settings, scope);
  if ((await countOpenReservations(user.id, scope)) >= limit) {
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
 *
 * The concurrency check runs inside the reservation's transaction (under the
 * user's credits lock), so two runs started at once cannot both pass it.
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
  await sweepAbandonedReservations();

  const settings = await getAppSettings();
  const scope = scopeOf(options.operation);
  const concurrencyLimit = concurrencyLimitFor(user, settings, scope);

  const runBudget = Math.min(
    options.runBudgetSubunits ?? settings.maxRunReservationSubunits,
    settings.maxRunReservationSubunits,
  );
  const initialHold = Math.min(
    options.initialHoldSubunits ?? DEFAULT_INITIAL_HOLD,
    runBudget,
  );

  const reserved = await reserveCredits({
    userId: user.id,
    amountSubunits: initialHold,
    operation: options.operation,
    projectKind: options.projectKind,
    projectId: options.projectId,
    runId: options.runId,
    // Counted under the credits lock, before the account and balance checks.
    maxOpenReservations: concurrencyLimit,
    scope,
  });
  if (!reserved.ok) {
    if (reserved.reason === "too_many_concurrent_runs") {
      throw new TooManyConcurrentRunsError(reserved.limit);
    }
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
    await releaseReservation(reservationId, "Run finished", "settled");
  }
}

export interface RunCreditReport {
  runCreditsCharged: number;
  availableSubunits: number;
  pendingCalls: number;
}

/** Numbers behind "This run used X credits. You have Y credits available." */
/**
 * `summary` is the caller's credit summary when the caller already loaded it
 * (status polling needs it anyway), so it is not read twice.
 */
export async function reportRunCredits(
  userId: string,
  runId: string,
  summary?: Pick<CreditSummary, "availableSubunits">,
): Promise<RunCreditReport> {
  // Scoped to this payer: inside a shared project each user sees only their own
  // charges, never the project owner's.
  const [{ creditsCharged, pendingCalls }, own] = await Promise.all([
    creditsForRun(runId, userId),
    summary ?? getCreditSummary(userId),
  ]);
  return {
    runCreditsCharged: creditsCharged,
    availableSubunits: own.availableSubunits,
    pendingCalls,
  };
}
