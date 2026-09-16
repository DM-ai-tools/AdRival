import { getAppSettings, getUserById, recordProviderCreditAlert } from "@/lib/db";
import type {
  ProviderCallStatus,
  ProviderId,
  ProviderUsageUnits,
  UsageConfidence,
} from "@/lib/types";
import { convertUsage, reservationCeiling } from "./conversion";
import { getActiveConversionRuleSet } from "./records";
import { getBillingContext } from "./context";
import {
  InsufficientCreditsError,
  ProviderCreditsExhaustedError,
  ProviderNotPermittedError,
  SpendAuthorizationRevokedError,
  UnboundedOperationError,
  USER_PROVIDER_CREDIT_MESSAGE,
  looksLikeProviderCreditFailure,
} from "./errors";
import { priceTokenUsage } from "./priceBook";
import {
  extendReservation,
  getReservation,
  releaseReservation,
  reserveCredits,
  settleProviderCall,
  touchReservation,
  userHasUnlimitedCredits,
} from "./service";
import { USD_MICROS } from "./units";

/** Raw usage as reported by a provider, plus its request id. */
export interface ReportedUsage {
  usage: ProviderUsageUnits | null;
  providerRequestId?: string | null;
  /**
   * Monetary cost the provider itself reported (not a local estimate).
   * Only OpenRouter returns this today, as `usage.cost` in USD.
   */
  reportedCostUsdMicros?: number | null;
}

export interface MeterSpec<T> {
  provider: ProviderId;
  /** Model id for LLMs. Used for rate lookup. */
  model?: string | null;
  /** API path for HTTP providers. Used for rate lookup when no model. */
  endpoint?: string | null;
  /** Short stable label, e.g. "sociavault.company-ads". */
  operation: string;
  /** Pull provider-reported usage out of a successful result. */
  extractUsage?: (result: T) => ReportedUsage;
}

/**
 * How much extra hold to take when topping up a run's reservation, expressed
 * as a multiple of one call's ceiling. Batching keeps the number of store
 * transactions down without over-holding.
 */
const TOPUP_MULTIPLE = 4;

function classifyFailure(err: unknown): ProviderCallStatus {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const lowered = message.toLowerCase();

  // The request was sent but we never learned the outcome — the provider may
  // well have billed for it, so this must not be treated as free.
  if (
    lowered.includes("aborterror") ||
    lowered.includes("timeout") ||
    lowered.includes("timed out") ||
    lowered.includes("etimedout") ||
    lowered.includes("socket hang up") ||
    lowered.includes("econnreset")
  ) {
    return "timeout";
  }

  // Never reached the provider: configuration or DNS/connection refusal.
  if (
    lowered.includes("is not set") ||
    lowered.includes("not configured") ||
    lowered.includes("enotfound") ||
    lowered.includes("econnrefused") ||
    lowered.includes("eai_again")
  ) {
    return "not_billable";
  }

  return "failed";
}

/** Sanitized, user-safe error text. Never includes keys or prompt content. */
function safeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/(key|token|secret|authorization)[^,;\s]*/gi, "[redacted]").slice(0, 300);
}

function assertProviderPermitted(provider: ProviderId, model: string | null, userId: string) {
  const settings = getAppSettings();
  if (settings.disabledProviders.includes(provider)) {
    throw new ProviderNotPermittedError(
      "This capability is currently disabled by your administrator.",
    );
  }
  if (model && settings.disabledModels.includes(model)) {
    throw new ProviderNotPermittedError(
      "This capability is currently disabled by your administrator.",
    );
  }
  const user = getUserById(userId);
  if (!user) throw new SpendAuthorizationRevokedError("Account not found.");
  if (user.status !== "active") {
    throw new SpendAuthorizationRevokedError(
      user.status === "suspended"
        ? "Your account is suspended. Contact your administrator."
        : "This account no longer has access.",
    );
  }
  if (user.allowedProviders && !user.allowedProviders.includes(provider)) {
    throw new ProviderNotPermittedError(
      "Your account is not permitted to use this capability.",
    );
  }
  if (model && user.blockedModels?.includes(model)) {
    throw new ProviderNotPermittedError(
      "Your account is not permitted to use this capability.",
    );
  }
}

/**
 * Make sure at least `ceiling` subunits are still held for this run, topping up
 * the reservation when they are not. Throws before the provider is contacted
 * when the next step cannot be funded.
 */
function ensureHoldForStep(
  reservationId: string,
  ceiling: number,
  runBudgetSubunits: number,
) {
  const reservation = getReservation(reservationId);
  if (!reservation) {
    throw new SpendAuthorizationRevokedError(
      "The credit reservation for this task is no longer active.",
    );
  }
  if (reservation.status !== "open") {
    throw new SpendAuthorizationRevokedError(
      "The credit reservation for this task is no longer active.",
    );
  }
  if (reservation.amountSubunits >= ceiling) {
    touchReservation(reservationId);
    return;
  }

  const alreadyCommitted = reservation.settledSubunits + reservation.amountSubunits;
  const unlimited = userHasUnlimitedCredits(getUserById(reservation.userId));
  const roomInBudget = unlimited
    ? Number.MAX_SAFE_INTEGER
    : Math.max(0, runBudgetSubunits - alreadyCommitted);
  if (!unlimited && roomInBudget < ceiling) {
    // The configured per-run cap, not the balance, is the binding limit.
    throw new InsufficientCreditsError(ceiling, roomInBudget);
  }

  const want = Math.min(ceiling * TOPUP_MULTIPLE, roomInBudget);
  const topUp = Math.max(ceiling, want) - reservation.amountSubunits;
  const result = extendReservation(reservationId, topUp);
  if (!result.ok) {
    // Retry with the bare minimum before giving up.
    const minimum = ceiling - reservation.amountSubunits;
    const retry = extendReservation(reservationId, minimum);
    if (!retry.ok) {
      throw new InsufficientCreditsError(minimum, retry.availableSubunits);
    }
  }
  touchReservation(reservationId);
}

/**
 * Wrap one billable provider call: authorize it, hold credits for it, run it,
 * then settle the actual usage exactly once.
 *
 * Every provider client routes through here, so there is no code path that can
 * spend at a provider without producing a ledger entry.
 */
export async function meterProviderCall<T>(
  spec: MeterSpec<T>,
  fn: () => Promise<T>,
): Promise<T> {
  const context = getBillingContext();
  if (!context) {
    // Loud failure by design: an unmetered provider call would be unbilled
    // spend against a shared API key.
    throw new Error(
      `Refusing to call ${spec.provider} (${spec.operation}) without a billing ` +
        `context. Wrap the entry point in runWithBillingContext().`,
    );
  }

  const model = spec.model ?? null;
  assertProviderPermitted(spec.provider, model, context.chargedUserId);

  const ruleSet = getActiveConversionRuleSet();
  const ceiling = reservationCeiling(ruleSet, spec.provider);
  if (ceiling <= 0) throw new UnboundedOperationError(spec.provider);

  // Single calls made outside a run get their own short-lived reservation.
  let reservationId = context.reservationId;
  let adHocReservation = false;
  if (!reservationId) {
    const reserved = reserveCredits({
      userId: context.chargedUserId,
      amountSubunits: ceiling,
      operation: spec.operation,
      projectKind: context.projectKind,
      projectId: context.projectId,
      runId: context.runId,
      note: "Single-call hold",
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
    reservationId = reserved.reservation.id;
    adHocReservation = true;
  } else {
    ensureHoldForStep(reservationId, ceiling, context.runBudgetSubunits);
  }

  const idempotencyKey = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const rateKey = model ?? spec.endpoint ?? null;

  const settle = (
    status: ProviderCallStatus,
    reported: ReportedUsage | null,
    errorMessage: string | null,
  ) => {
    let usage: ProviderUsageUnits;
    let confidence: UsageConfidence;
    let credits: number;
    let costMicros: number | null;

    if (status === "timeout") {
      // Unknown billing outcome: park it, keep the hold, charge nothing yet.
      usage = reported?.usage ?? {};
      confidence = "pending_reconciliation";
      credits = 0;
      costMicros = null;
    } else if (status === "not_billable" || status === "blocked") {
      usage = {};
      confidence = "confirmed";
      credits = 0;
      costMicros = null;
    } else if (status === "failed") {
      // A rejected request produced no reported usage; charge nothing but keep
      // the row so the failure is visible in usage history.
      usage = reported?.usage ?? {};
      confidence = "confirmed";
      credits = 0;
      costMicros = null;
    } else {
      const converted = convertUsage(ruleSet, spec.provider, rateKey, reported?.usage ?? null);
      usage = converted.usage;
      confidence = converted.usageConfidence;
      credits = converted.creditsCharged;
      const listed = priceTokenUsage(spec.provider, model, usage);
      costMicros =
        reported?.reportedCostUsdMicros ??
        converted.estimatedCostUsdMicros ??
        listed.usdMicros;
    }

    const result = settleProviderCall({
      idempotencyKey,
      initiatedByUserId: context.initiatedByUserId,
      chargedUserId: context.chargedUserId,
      projectKind: context.projectKind,
      projectId: context.projectId,
      runId: context.runId,
      provider: spec.provider,
      model,
      endpoint: spec.endpoint ?? null,
      operation: spec.operation,
      providerRequestId: reported?.providerRequestId ?? null,
      usage,
      usageConfidence: confidence,
      creditsCharged: credits,
      estimatedCostUsdMicros: costMicros,
      conversionRuleVersion: ruleSet.version,
      status,
      errorMessage,
      reservationId,
      startedAt,
      durationMs: Date.now() - startedMs,
      releaseSubunits: ceiling,
    });
    context.chargedSubunits.value += result.call.creditsCharged;

    if (adHocReservation && confidence !== "pending_reconciliation") {
      releaseReservation(reservationId!, "Single-call hold settled", "settled");
    }
    return result;
  };

  try {
    const result = await fn();
    const reported = spec.extractUsage ? spec.extractUsage(result) : null;
    settle("succeeded", reported, null);
    return result;
  } catch (err) {
    const status = classifyFailure(err);
    settle(status, null, safeErrorMessage(err));
    if (
      looksLikeProviderCreditFailure(err) &&
      !(err instanceof ProviderCreditsExhaustedError) &&
      !(err instanceof InsufficientCreditsError)
    ) {
      const user = getUserById(context.chargedUserId);
      if (user) {
        recordProviderCreditAlert({
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          provider: spec.provider,
          runId: context.runId,
        });
      }
      // The main app never names the vendor. Admin → Alerts keeps the name.
      throw new ProviderCreditsExhaustedError(
        spec.provider,
        USER_PROVIDER_CREDIT_MESSAGE,
      );
    }
    throw err;
  }
}

/* ───────────────────── Provider usage extraction helpers ────────────────── */

interface OpenAiStyleUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /** OpenRouter only: cost in USD. Documented on chat completions. */
  cost?: number;
}

/**
 * Usage from an OpenAI-compatible chat completion. Covers OpenAI and
 * OpenRouter; OpenRouter additionally reports `usage.cost` in USD.
 */
export function extractOpenAiUsage(result: unknown): ReportedUsage {
  const body = result as {
    id?: string;
    usage?: OpenAiStyleUsage;
  } | null;
  const usage = body?.usage;
  if (!usage) return { usage: null, providerRequestId: body?.id ?? null };
  return {
    usage: {
      requests: 1,
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens,
    },
    providerRequestId: body?.id ?? null,
    reportedCostUsdMicros:
      typeof usage.cost === "number"
        ? Math.round(usage.cost * USD_MICROS)
        : null,
  };
}

/** Usage from an Anthropic Messages response. */
export function extractAnthropicUsage(result: unknown): ReportedUsage {
  const body = result as {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
    };
  } | null;
  const usage = body?.usage;
  if (!usage) return { usage: null, providerRequestId: body?.id ?? null };
  return {
    usage: {
      requests: 1,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedInputTokens: usage.cache_read_input_tokens,
    },
    providerRequestId: body?.id ?? null,
  };
}

/** Providers that return no usage body: one call is one billable request. */
export function singleRequestUsage(providerRequestId?: string | null): ReportedUsage {
  return { usage: { requests: 1 }, providerRequestId: providerRequestId ?? null };
}

/**
 * SociaVault's documented response envelope may include `credits_used`
 * (https://sociavault.com/blog/getting-started-sociavault-api). When that
 * field is missing we return null usage so convertUsage can label the
 * per-request fallback as estimated rather than confirmed.
 */
export function extractSociavaultUsage(result: unknown): ReportedUsage {
  const body = result as {
    credits_used?: number;
    creditsUsed?: number;
    data?: { credits_used?: number };
  } | null;
  const used = body?.credits_used ?? body?.creditsUsed ?? body?.data?.credits_used;
  if (typeof used === "number" && Number.isFinite(used) && used >= 0) {
    return { usage: { requests: used } };
  }
  return { usage: null };
}
