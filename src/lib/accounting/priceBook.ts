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
 * SociaVault, Firecrawl, Brandfetch, Runway and Manus are priced per credit
 * or request instead (UNIT_LIST_PRICES below).
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
    modelPrefix: "claude-opus-5",
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 25,
    source: "Anthropic pricing — Claude Opus 5",
  },
  {
    provider: "anthropic",
    modelPrefix: "claude-sonnet-5",
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    source: "Anthropic pricing — Claude Sonnet 5",
  },
  {
    provider: "anthropic",
    modelPrefix: "claude-haiku-4-5",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    source: "Anthropic pricing — Claude Haiku 4.5",
  },
  {
    provider: "anthropic",
    modelPrefix: "claude-haiku",
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 5,
    source: "Anthropic pricing — Claude Haiku",
  },
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

/**
 * Providers billed per credit or per request: what one request-unit costs.
 * SociaVault, Firecrawl and Manus store their own credits as request-units
 * (see extractSociavaultUsage, extractFirecrawlUsage, recordIncurredUsage).
 * Plan prices differ, so each figure can be set with its env var to match the
 * account's plan; the defaults are the published entry-plan rates.
 */
export interface UnitListPrice {
  provider: ProviderId;
  /** What one request-unit is, for the admin screens. */
  unit: "credit" | "request";
  usdPerUnit: number;
  env: string;
  source: string;
}

export const UNIT_LIST_PRICES: UnitListPrice[] = [
  // https://sociavault.com/pricing — Starter $29 / 6,000 credits (larger packs are cheaper per credit).
  { provider: "sociavault", unit: "credit", usdPerUnit: 0.00483, env: "SOCIAVAULT_USD_PER_CREDIT", source: "SociaVault Starter pack ($29 / 6,000 credits)" },
  // https://www.firecrawl.dev/pricing — Hobby $19 / 5,000 credits a month.
  { provider: "firecrawl", unit: "credit", usdPerUnit: 0.0038, env: "FIRECRAWL_USD_PER_CREDIT", source: "Firecrawl Hobby plan ($19 / 5,000 credits)" },
  // https://brandfetch.com/developers/pricing — Growth $99 / 2,500 brand fetches a month.
  { provider: "brandfetch", unit: "request", usdPerUnit: 0.04, env: "BRANDFETCH_USD_PER_REQUEST", source: "Brandfetch Growth plan (~$0.04 per fetch)" },
  // https://docs.dev.runwayml.com/guides/pricing — $0.01 per credit.
  { provider: "runway", unit: "credit", usdPerUnit: 0.01, env: "RUNWAY_USD_PER_CREDIT", source: "Runway API ($0.01 per credit)" },
  // https://manus.im/pricing — $20 / 4,000 credits a month.
  { provider: "manus", unit: "credit", usdPerUnit: 0.005, env: "MANUS_USD_PER_CREDIT", source: "Manus plan ($20 / 4,000 credits)" },
];

export function unitListPrice(provider: ProviderId): (UnitListPrice & { overridden: boolean }) | null {
  const price = UNIT_LIST_PRICES.find((p) => p.provider === provider);
  if (!price) return null;
  const override = Number(process.env[price.env]);
  return Number.isFinite(override) && override >= 0 && process.env[price.env]?.trim()
    ? { ...price, usdPerUnit: override, overridden: true, source: `${price.env} (set for this account)` }
    : { ...price, overridden: false };
}

/** Cost of request-units for a per-credit / per-request provider; null for token-priced ones. */
export function priceUnitUsage(provider: ProviderId, usage: ProviderUsageUnits): { usdMicros: number | null; source: string | null } {
  const price = unitListPrice(provider);
  const units = usage.requests ?? 0;
  if (!price || units <= 0) return { usdMicros: null, source: null };
  return { usdMicros: Math.round(units * price.usdPerUnit * USD_MICROS), source: price.source };
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
      // Older calls stored no cost: token list price, else the per-credit price.
      const tokens = priceTokenUsage(call.provider, call.model, call.usage);
      const priced = tokens.usdMicros !== null ? tokens : priceUnitUsage(call.provider, call.usage);
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
