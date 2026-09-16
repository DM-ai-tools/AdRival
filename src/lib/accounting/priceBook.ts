import type { ProviderId, ProviderUsageUnits } from "@/lib/types";
import { USD_MICROS } from "./units";

/**
 * Documented list prices, used only to turn stored token counts into a dollar
 * figure. These are not application-credit rates, and they are not a live
 * account balance.
 *
 * Sources (standard, non-batch, per 1M tokens):
 * - Claude Sonnet 4.5: $3 input / $15 output
 *   https://platform.claude.com/docs/en/about-claude/pricing
 * - gpt-4.1: $2 input / $8 output
 *   https://developers.openai.com/api/docs/models/gpt-4.1
 * - gpt-4o: $2.50 input / $10 output
 *   https://developers.openai.com/api/docs/models/gpt-4o
 * - gpt-4o-mini: $0.15 input / $0.60 output
 *   https://developers.openai.com/api/docs/models/gpt-4o-mini
 * - perplexity/sonar: $1 input / $1 output
 *   https://openrouter.ai/perplexity/sonar
 *   https://docs.perplexity.ai/docs/getting-started/pricing
 *
 * Models without a listed rate are left unpriced (null), never $0.
 * SociaVault, Firecrawl, Brandfetch and Runway are not token-priced here.
 */
export interface TokenListPrice {
  provider: ProviderId;
  /** Longest matching model prefix wins. */
  modelPrefix: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  source: string;
}

export const TOKEN_LIST_PRICES: TokenListPrice[] = [
  {
    provider: "anthropic",
    modelPrefix: "claude-sonnet-4-5",
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    source: "Anthropic pricing — Claude Sonnet 4.5",
  },
  {
    provider: "openai",
    modelPrefix: "gpt-4.1",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    source: "OpenAI pricing — gpt-4.1",
  },
  {
    provider: "openai",
    modelPrefix: "gpt-4o-mini",
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
    source: "OpenAI pricing — gpt-4o-mini",
  },
  {
    provider: "openai",
    modelPrefix: "gpt-4o",
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    source: "OpenAI pricing — gpt-4o",
  },
  {
    provider: "openrouter",
    modelPrefix: "openai/gpt-4.1",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 8,
    source: "OpenAI list price via OpenRouter — gpt-4.1",
  },
  {
    provider: "openrouter",
    modelPrefix: "openai/gpt-4o-mini",
    inputUsdPerMillion: 0.15,
    outputUsdPerMillion: 0.6,
    source: "OpenAI list price via OpenRouter — gpt-4o-mini",
  },
  {
    provider: "openrouter",
    modelPrefix: "openai/gpt-4o",
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 10,
    source: "OpenAI list price via OpenRouter — gpt-4o",
  },
  {
    provider: "openrouter",
    modelPrefix: "perplexity/sonar",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 1,
    source: "OpenRouter / Perplexity — sonar ($1 / $1 per 1M tokens)",
  },
];

export function findTokenListPrice(
  provider: ProviderId,
  model: string | null,
): TokenListPrice | null {
  if (!model) return null;
  const lowered = model.toLowerCase();
  let best: TokenListPrice | null = null;
  for (const price of TOKEN_LIST_PRICES) {
    if (price.provider !== provider) continue;
    if (!lowered.startsWith(price.modelPrefix.toLowerCase())) continue;
    if (!best || price.modelPrefix.length > best.modelPrefix.length) {
      best = price;
    }
  }
  return best;
}

export interface PricedUsage {
  /** Integer micro-USD, or null when no listed rate applies. */
  usdMicros: number | null;
  source: string | null;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Token cost = (input tokens / 1,000,000) * input price + the same for output.
 * Integer micro-USD. A missing price stays null so the UI never shows a fake $0.
 */
export function priceTokenUsage(
  provider: ProviderId,
  model: string | null,
  usage: ProviderUsageUnits,
): PricedUsage {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const rate = findTokenListPrice(provider, model);
  if (!rate || (inputTokens <= 0 && outputTokens <= 0)) {
    return {
      usdMicros: null,
      source: null,
      inputTokens,
      outputTokens,
    };
  }
  const micros =
    Math.round(inputTokens * rate.inputUsdPerMillion) +
    Math.round(outputTokens * rate.outputUsdPerMillion);
  return {
    usdMicros: micros,
    source: rate.source,
    inputTokens,
    outputTokens,
  };
}

/** $3 per 1M tokens * 1,000 tokens = 3,000 micro-USD. */
export function usdPerMillionToMicros(tokens: number, usdPerMillion: number): number {
  return Math.round(tokens * usdPerMillion);
}

export { USD_MICROS };

export interface TrackedSpendCall {
  provider: ProviderId;
  model: string | null;
  usage: ProviderUsageUnits;
  estimatedCostUsdMicros: number | null;
  status: string;
}

export interface TrackedSpendRow {
  provider: ProviderId;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  /** Null when no call in the group had a price. Never coerced to zero. */
  usdMicros: number | null;
  unpricedCalls: number;
  basis: "stored" | "list_price" | "unpriced";
}

export interface TrackedSpendSummary {
  rows: TrackedSpendRow[];
  totalUsdMicros: number | null;
  unpricedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregate stored calls into a running dollar total from tokens + list prices. */
export function summarizeTrackedSpend(calls: TrackedSpendCall[]): TrackedSpendSummary {
  const map = new Map<string, TrackedSpendRow>();
  for (const call of calls) {
    if (call.status === "not_billable" || call.status === "blocked") continue;
    const key = `${call.provider}:${call.model ?? ""}`;
    const row =
      map.get(key) ??
      ({
        provider: call.provider,
        model: call.model,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        requests: 0,
        usdMicros: null,
        unpricedCalls: 0,
        basis: "unpriced",
      } satisfies TrackedSpendRow);
    row.calls += 1;
    row.inputTokens += call.usage.inputTokens ?? 0;
    row.outputTokens += call.usage.outputTokens ?? 0;
    row.requests += call.usage.requests ?? 0;

    if (call.estimatedCostUsdMicros !== null) {
      row.usdMicros = (row.usdMicros ?? 0) + call.estimatedCostUsdMicros;
      if (row.basis === "unpriced") row.basis = "stored";
    } else {
      const priced = priceTokenUsage(call.provider, call.model, call.usage);
      if (priced.usdMicros !== null) {
        row.usdMicros = (row.usdMicros ?? 0) + priced.usdMicros;
        if (row.basis === "unpriced") row.basis = "list_price";
      } else {
        row.unpricedCalls += 1;
      }
    }
    map.set(key, row);
  }

  const rows = [...map.values()].sort((a, b) => {
    const cost = (b.usdMicros ?? -1) - (a.usdMicros ?? -1);
    return cost !== 0 ? cost : b.calls - a.calls;
  });
  const priced = rows.filter((r) => r.usdMicros !== null);
  return {
    rows,
    totalUsdMicros: priced.length
      ? priced.reduce((sum, r) => sum + (r.usdMicros ?? 0), 0)
      : null,
    unpricedCalls: rows.reduce((sum, r) => sum + r.unpricedCalls, 0),
    inputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
  };
}
