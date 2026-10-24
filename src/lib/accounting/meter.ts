import { getAppSettings, getUserById, recordProviderCreditAlert } from "@/lib/db";
import type {
  ProjectKind,
  ProviderCallRecord,
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
import { priceTokenUsage, priceUnitUsage } from "./priceBook";
import {
  ensureReservationHold,
  releaseReservation,
  reserveCredits,
  settleProviderCall,
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

async function assertProviderPermitted(provider: ProviderId, model: string | null, userId: string): Promise<void> {
  const settings = await getAppSettings();
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
  const user = await getUserById(userId);
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
 *
 * The read of the hold and the top-up are one transaction
 * (ensureReservationHold), so parallel steps of one run cannot both top up.
 */
async function ensureHoldForStep(
  reservationId: string,
  ceiling: number,
  runBudgetSubunits: number,
): Promise<void> {
  const result = await ensureReservationHold({
    reservationId,
    ceilingSubunits: ceiling,
    runBudgetSubunits,
    topUpMultiple: TOPUP_MULTIPLE,
  });
  if (result.ok) return;
  if (result.reason === "reservation_inactive") {
    throw new SpendAuthorizationRevokedError(
      "The credit reservation for this task is no longer active.",
    );
  }
  throw new InsufficientCreditsError(result.requiredSubunits, result.availableSubunits);
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
  await assertProviderPermitted(spec.provider, model, context.chargedUserId);

  const ruleSet = await getActiveConversionRuleSet();
  const ceiling = reservationCeiling(ruleSet, spec.provider);
  if (ceiling <= 0) throw new UnboundedOperationError(spec.provider);

  // Single calls made outside a run get their own short-lived reservation.
  let reservationId = context.reservationId;
  let adHocReservation = false;
  if (!reservationId) {
    const reserved = await reserveCredits({
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
    await ensureHoldForStep(reservationId, ceiling, context.runBudgetSubunits);
  }

  const idempotencyKey = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const rateKey = model ?? spec.endpoint ?? null;

  const settle = async (
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
        listed.usdMicros ??
        priceUnitUsage(spec.provider, usage).usdMicros;
    }

    const result = await settleProviderCall({
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
      await releaseReservation(reservationId!, "Single-call hold settled", "settled");
    }
    return result;
  };

  try {
    const result = await fn();
    const reported = spec.extractUsage ? spec.extractUsage(result) : null;
    await settle("succeeded", reported, null);
    return result;
  } catch (err) {
    const status = classifyFailure(err);
    await settle(status, null, safeErrorMessage(err));
    if (
      looksLikeProviderCreditFailure(err) &&
      !(err instanceof ProviderCreditsExhaustedError) &&
      !(err instanceof InsufficientCreditsError)
    ) {
      const user = await getUserById(context.chargedUserId);
      if (user) {
        await recordProviderCreditAlert({
          userId: user.id,
          username: user.username,
          displayName: user.displayName,
          provider: spec.provider,
          runId: context.runId,
        });
      }
      // Admins see which shared API wallet failed; everyone else gets a generic message.
      const raw = err instanceof Error ? err.message : String(err);
      const adminDetail = raw.replace(/\s+/g, " ").trim().slice(0, 280);
      const message = userHasUnlimitedCredits(user)
        ? `${spec.provider} API wallet is out of credits (this is separate from Unlimited app credits). ${adminDetail}`
        : USER_PROVIDER_CREDIT_MESSAGE;
      throw new ProviderCreditsExhaustedError(spec.provider, message);
    }
    throw err;
  }
}

/**
 * Usage a provider has already billed outside a metered request: a Manus
 * task reports the credits it used only once it stops. It goes straight to
 * the ledger with no hold, since the spend happened either way. Charged to
 * the active billing context, else to `fallbackUserId` (a run picked up
 * again after a restart has no context). Returns null when nobody can be
 * charged; a repeated idempotency key is recorded once.
 */
export async function recordIncurredUsage(input: {
  provider: ProviderId;
  operation: string;
  usage: ProviderUsageUnits;
  providerRequestId: string | null;
  idempotencyKey: string;
  fallbackUserId?: string | null;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  runId?: string | null;
  startedAt?: string;
}): Promise<ProviderCallRecord | null> {
  const context = getBillingContext();
  const userId = context?.chargedUserId ?? input.fallbackUserId ?? null;
  if (!userId || !(await getUserById(userId))) {
    console.warn(`[accounting] ${input.operation}: no user to record ${input.provider} usage against`);
    return null;
  }
  const ruleSet = await getActiveConversionRuleSet();
  const converted = convertUsage(ruleSet, input.provider, null, input.usage);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const result = await settleProviderCall({
    idempotencyKey: input.idempotencyKey,
    initiatedByUserId: context?.initiatedByUserId ?? userId,
    chargedUserId: userId,
    projectKind: context?.projectKind ?? input.projectKind ?? null,
    projectId: context?.projectId ?? input.projectId ?? null,
    runId: context?.runId ?? input.runId ?? null,
    provider: input.provider,
    model: null,
    endpoint: null,
    operation: input.operation,
    providerRequestId: input.providerRequestId,
    usage: converted.usage,
    usageConfidence: "confirmed",
    creditsCharged: converted.creditsCharged,
    estimatedCostUsdMicros:
      converted.estimatedCostUsdMicros ?? priceUnitUsage(input.provider, converted.usage).usdMicros,
    conversionRuleVersion: ruleSet.version,
    status: "succeeded",
    errorMessage: null,
    reservationId: context?.reservationId ?? null,
    startedAt,
    durationMs: Math.max(0, Date.now() - Date.parse(startedAt)),
    releaseSubunits: 0,
  });
  if (context && !result.duplicate) context.chargedSubunits.value += result.call.creditsCharged;
  return result.call;
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

/**
 * Firecrawl v2 reports the credits a call used (`creditsUsed`, top level or in
 * the page metadata). Missing: one call is one credit.
 */
export function extractFirecrawlUsage(result: unknown): ReportedUsage {
  const body = result as {
    creditsUsed?: number;
    data?: { creditsUsed?: number; metadata?: { creditsUsed?: number } } | unknown[];
  } | null;
  const data = body?.data && !Array.isArray(body.data) ? body.data : null;
  const used = body?.creditsUsed ?? data?.creditsUsed ?? data?.metadata?.creditsUsed;
  if (typeof used === "number" && Number.isFinite(used) && used >= 0) {
    return { usage: { requests: used } };
  }
  return singleRequestUsage();
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
