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

export const SEED_RULE_VERSION = 1;

export function seedConversionRuleSet(): ConversionRuleSet {
  return {
    version: SEED_RULE_VERSION,
    createdAt: new Date().toISOString(),
    createdByUserId: null,
    note:
      "Seeded defaults. Credit rates are starting points and monetary prices " +
      "are intentionally unset — configure both in Admin → Settings.",
    rates: {
      sociavault: {
        // Application credits per SociaVault request-unit. When the API
        // reports `credits_used`, that value is used; otherwise one call is
        // treated as one estimated request.
        default: { perRequest: C(1) },
      },
      openrouter: {
        default: {
          perThousandInputTokens: C(0.3),
          perThousandOutputTokens: C(1.5),
          estimatedInputTokens: 4000,
          estimatedOutputTokens: 1500,
        },
      },
      openai: {
        default: {
          perThousandInputTokens: C(0.3),
          perThousandOutputTokens: C(1.5),
          estimatedInputTokens: 4000,
          estimatedOutputTokens: 1500,
        },
      },
      anthropic: {
        default: {
          perThousandInputTokens: C(0.4),
          perThousandOutputTokens: C(2),
          estimatedInputTokens: 6000,
          estimatedOutputTokens: 2000,
        },
      },
      firecrawl: {
        default: { perRequest: C(1) },
      },
      brandfetch: {
        default: { perRequest: C(1) },
      },
      runway: {
        default: { perImage: C(10), perRequest: C(10) },
      },
    },
    /**
     * Conservative ceiling held before a single call of unknown size. Chosen so
     * a pathological response cannot exceed the hold; leftovers are released.
     */
    perCallReservationCeiling: {
      sociavault: C(2),
      openrouter: C(60),
      openai: C(60),
      anthropic: C(80),
      firecrawl: C(2),
      brandfetch: C(2),
      runway: C(15),
    },
  };
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
