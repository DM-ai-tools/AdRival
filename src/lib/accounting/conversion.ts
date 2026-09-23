import type {
  ConversionRuleSet,
  ProviderId,
  ProviderRate,
  ProviderUsageUnits,
  UsageConfidence,
} from "@/lib/types";
import { CREDIT_SCALE, chargeCeil } from "./units";

/**
 * Conversion rules turn *provider* usage into *application* credits.
 *
 * Two deliberate omissions in the seeded rule set:
 *
 * 1. No `usdMicros*` prices. Real provider list prices are not hardcoded here —
 *    an admin must enter them from each provider's own pricing page. Until then
 *    estimated monetary cost is reported as `null` and rendered "Unavailable".
 * 2. Rates are *not* equal across providers. One SociaVault scrape, one Claude
 *    call and one Runway image each convert independently.
 *
 * Every charge stores the rule-set version it used, so editing rules never
 * rewrites historical usage.
 */

const C = (credits: number) => Math.round(credits * CREDIT_SCALE);

export const SEED_RULE_VERSION = 2;

/**
 * Softened rates so one landing-page redesign does not empty a typical allowance.
 * Historical charges still settle against the rule version stored on each call.
 */
export function seedConversionRuleSet(): ConversionRuleSet {
  return {
    version: SEED_RULE_VERSION,
    createdAt: new Date().toISOString(),
    createdByUserId: null,
    note:
      "Softened redesign-friendly defaults (v2). Anthropic/Firecrawl/Runway " +
      "rates are lower so a single recreate stays affordable. Monetary USD " +
      "prices stay unset — configure those in Admin → Settings if needed.",
    rates: {
      sociavault: {
        default: { perRequest: C(1) },
      },
      openrouter: {
        default: {
          perThousandInputTokens: C(0.2),
          perThousandOutputTokens: C(0.8),
          estimatedInputTokens: 4000,
          estimatedOutputTokens: 1500,
        },
      },
      openai: {
        default: {
          perThousandInputTokens: C(0.2),
          perThousandOutputTokens: C(0.8),
          estimatedInputTokens: 4000,
          estimatedOutputTokens: 1500,
        },
      },
      anthropic: {
        // ~4× softer on output vs v1 so a 30–60k HTML page stays within ~30–60 credits
        // instead of draining a 200+ allowance when a truncated retry also runs.
        default: {
          perThousandInputTokens: C(0.12),
          perThousandOutputTokens: C(0.45),
          estimatedInputTokens: 8000,
          estimatedOutputTokens: 16000,
        },
        "claude-haiku": {
          perThousandInputTokens: C(0.06),
          perThousandOutputTokens: C(0.2),
          estimatedInputTokens: 8000,
          estimatedOutputTokens: 16000,
        },
        "claude-sonnet-5": {
          perThousandInputTokens: C(0.1),
          perThousandOutputTokens: C(0.35),
          estimatedInputTokens: 8000,
          estimatedOutputTokens: 20000,
        },
        "claude-opus-5": {
          // Opus list price is higher; keep app credits soft so redesigns stay usable.
          perThousandInputTokens: C(0.18),
          perThousandOutputTokens: C(0.55),
          estimatedInputTokens: 8000,
          estimatedOutputTokens: 20000,
        },
        "claude-sonnet-4": {
          perThousandInputTokens: C(0.12),
          perThousandOutputTokens: C(0.45),
          estimatedInputTokens: 8000,
          estimatedOutputTokens: 16000,
        },
      },
      firecrawl: {
        default: { perRequest: C(0.4) },
      },
      brandfetch: {
        default: { perRequest: C(0.5) },
      },
      runway: {
        default: { perImage: C(4), perRequest: C(4) },
      },
    },
    /**
     * Conservative ceiling held before a single call of unknown size. Chosen so
     * a pathological response cannot exceed the hold; leftovers are released.
     */
    perCallReservationCeiling: {
      sociavault: C(2),
      openrouter: C(40),
      openai: C(40),
      anthropic: C(12),
      firecrawl: C(1),
      brandfetch: C(1),
      runway: C(6),
    },
  };
}

/** True when the active rule set still uses pre-softening Anthropic output rates or a high hold. */
export function conversionRulesNeedSoftening(ruleSet: ConversionRuleSet): boolean {
  const out = ruleSet.rates.anthropic?.default?.perThousandOutputTokens;
  // v1 charged C(2) = 20000 subunits per 1k output tokens.
  if (typeof out === "number" && out >= C(1.5)) return true;
  const ceiling = ruleSet.perCallReservationCeiling?.anthropic;
  // Lean redesign holds ~12 credits per call; legacy 50 blocked low balances.
  if (typeof ceiling === "number" && ceiling >= C(40)) return true;
  return false;
}

/** Longest-prefix model match, then provider default, then null. */
export function resolveRate(
  ruleSet: ConversionRuleSet,
  provider: ProviderId,
  key: string | null,
): ProviderRate | null {
  const providerRates = ruleSet.rates[provider];
  if (!providerRates) return null;
  if (key) {
    if (providerRates[key]) return providerRates[key];
    const lowered = key.toLowerCase();
    let best: { len: number; rate: ProviderRate } | null = null;
    for (const [candidate, rate] of Object.entries(providerRates)) {
      if (candidate === "default") continue;
      const c = candidate.toLowerCase();
      if (lowered.startsWith(c) && (!best || c.length > best.len)) {
        best = { len: c.length, rate };
      }
    }
    if (best) return best.rate;
  }
  return providerRates.default ?? null;
}

export function reservationCeiling(
  ruleSet: ConversionRuleSet,
  provider: ProviderId,
): number {
  const configured = ruleSet.perCallReservationCeiling[provider];
  if (typeof configured === "number" && configured > 0) return configured;
  // No configured ceiling means the call is not safely boundable.
  return 0;
}

export interface ConversionResult {
  creditsCharged: number;
  estimatedCostUsdMicros: number | null;
  usage: ProviderUsageUnits;
  usageConfidence: UsageConfidence;
}

/**
 * Convert reported (or estimated) usage into credits.
 *
 * `reported` is what the provider actually returned. When it is empty and the
 * rate configures an estimate, the estimate is used and the result is labeled
 * `estimated` so no screen presents a guess as a confirmed figure.
 */
export function convertUsage(
  ruleSet: ConversionRuleSet,
  provider: ProviderId,
  key: string | null,
  reported: ProviderUsageUnits | null,
): ConversionResult {
  const rate = resolveRate(ruleSet, provider, key);
  const hasReported =
    !!reported &&
    Object.values(reported).some((v) => typeof v === "number" && Number.isFinite(v));

  if (!rate) {
    return {
      creditsCharged: 0,
      estimatedCostUsdMicros: null,
      usage: reported ?? {},
      usageConfidence: hasReported ? "confirmed" : "pending_reconciliation",
    };
  }

  let usage: ProviderUsageUnits;
  let confidence: UsageConfidence;

  if (hasReported) {
    usage = reported!;
    confidence = "confirmed";
  } else if (
    rate.estimatedInputTokens !== undefined ||
    rate.estimatedOutputTokens !== undefined
  ) {
    usage = {
      requests: 1,
      inputTokens: rate.estimatedInputTokens,
      outputTokens: rate.estimatedOutputTokens,
    };
    confidence = "estimated";
  } else if (rate.perRequest !== undefined) {
    // Provider reported no usage. Charge the configured per-request rate and
    // label it estimated so the UI never presents a guess as confirmed.
    usage = { requests: 1 };
    confidence = "estimated";
  } else {
    return {
      creditsCharged: 0,
      estimatedCostUsdMicros: null,
      usage: {},
      usageConfidence: "pending_reconciliation",
    };
  }

  let credits = 0;
  let usdMicros = 0;
  let anyPriceConfigured = false;

  const apply = (
    units: number | undefined,
    perUnit: number | undefined,
    usdPerUnit: number | undefined,
    divisor = 1,
  ) => {
    if (!units || units <= 0) return;
    if (perUnit !== undefined) credits += (units * perUnit) / divisor;
    if (usdPerUnit !== undefined) {
      usdMicros += (units * usdPerUnit) / divisor;
      anyPriceConfigured = true;
    }
  };

  apply(usage.requests, rate.perRequest, rate.usdMicrosPerRequest);
  apply(
    usage.inputTokens,
    rate.perThousandInputTokens,
    rate.usdMicrosPerThousandInputTokens,
    1000,
  );
  apply(
    usage.outputTokens,
    rate.perThousandOutputTokens,
    rate.usdMicrosPerThousandOutputTokens,
    1000,
  );
  apply(usage.images, rate.perImage, rate.usdMicrosPerImage);

  return {
    creditsCharged: chargeCeil(credits),
    estimatedCostUsdMicros: anyPriceConfigured ? Math.round(usdMicros) : null,
    usage,
    usageConfidence: confidence,
  };
}
