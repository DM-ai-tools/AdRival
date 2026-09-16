import type { ConversionRuleSet, ProviderRate } from "@/lib/types";
import { formatCredits, subunitsToCredits } from "./units";

export interface CallExample {
  label: string;
  credits: string;
  detail: string;
}

export interface AllowanceSuggestion {
  name: string;
  credits: string;
  fits: string;
}

export interface AllotmentGuide {
  version: number;
  calls: CallExample[];
  suggestions: AllowanceSuggestion[];
}

function tokenEstimate(rate: ProviderRate | undefined): number | null {
  if (
    !rate?.perThousandInputTokens ||
    !rate.perThousandOutputTokens ||
    !rate.estimatedInputTokens ||
    !rate.estimatedOutputTokens
  ) {
    return null;
  }
  return Math.round(
    (rate.perThousandInputTokens * rate.estimatedInputTokens) / 1000 +
      (rate.perThousandOutputTokens * rate.estimatedOutputTokens) / 1000,
  );
}

function credits(subunits: number | null | undefined): string {
  if (!subunits) return "—";
  return formatCredits(subunits);
}

/**
 * Planning examples from the active conversion rules. These are not a user's
 * history — they show what one billed call costs so an allowance can be sized.
 */
export function buildAllotmentGuide(
  ruleSet: ConversionRuleSet,
  hardCapSubunits: number,
): AllotmentGuide {
  const scrape = ruleSet.rates.sociavault?.default?.perRequest ?? null;
  const llm = tokenEstimate(ruleSet.rates.openrouter?.default);
  const claude = tokenEstimate(ruleSet.rates.anthropic?.default);
  const image =
    ruleSet.rates.runway?.default?.perImage ??
    ruleSet.rates.runway?.default?.perRequest ??
    null;
  const scrapeCredits = scrape ? subunitsToCredits(scrape) : 1;
  const llmCredits = llm ? Math.max(subunitsToCredits(llm), 0.1) : 3.5;
  const capCredits = Math.max(
    1,
    Math.round(subunitsToCredits(hardCapSubunits) || 500),
  );
  const bundle = scrapeCredits + llmCredits;

  const suggestions = [
    { name: "Light", credits: 25 },
    { name: "Regular", credits: 100 },
    { name: "Heavy", credits: Math.max(500, capCredits) },
  ].map((plan) => ({
    name: plan.name,
    credits: String(plan.credits),
    fits:
      plan.name === "Heavy"
        ? `At least the per-run cap (${capCredits} credits). Keep that cap at or below the allowance so one run cannot empty the account.`
        : `About ${Math.floor(plan.credits / scrapeCredits)} ad-library requests, or about ${Math.floor(plan.credits / bundle)} search-sized bundles (one scrape plus one model call).`,
  }));

  return {
    version: ruleSet.version,
    calls: [
      {
        label: "Ad library request",
        credits: credits(scrape),
        detail: "One SociaVault request at the current rate.",
      },
      {
        label: "Model call",
        credits: credits(llm),
        detail: "One OpenRouter call at the rule's estimated token size.",
      },
      {
        label: "Claude call",
        credits: credits(claude),
        detail: "One Anthropic call at the rule's estimated token size.",
      },
      {
        label: "Generated image",
        credits: credits(image),
        detail: "One Runway image at the current rate.",
      },
    ],
    suggestions,
  };
}
