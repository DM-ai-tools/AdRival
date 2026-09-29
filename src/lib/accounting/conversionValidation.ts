import { PROVIDER_IDS, type ProviderRate } from "@/lib/types";

const RATE_FIELDS: ReadonlyArray<keyof ProviderRate> = [
  "perRequest",
  "perThousandInputTokens",
  "perThousandOutputTokens",
  "perImage",
  "usdMicrosPerRequest",
  "usdMicrosPerThousandInputTokens",
  "usdMicrosPerThousandOutputTokens",
  "usdMicrosPerImage",
  "estimatedInputTokens",
  "estimatedOutputTokens",
];

const PROVIDERS = new Set<string>(PROVIDER_IDS);
const FIELDS = new Set<string>(RATE_FIELDS);

function isAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Check a conversion rule set before it becomes the active billing rules.
 * Returns the problems found (empty when valid), written for the admin.
 */
export function validateConversionRules(input: {
  rates: unknown;
  perCallReservationCeiling: unknown;
}): string[] {
  const problems: string[] = [];
  const { rates, perCallReservationCeiling } = input;

  if (!rates || typeof rates !== "object" || Array.isArray(rates)) {
    problems.push("Rates must be an object of providers.");
  } else {
    for (const [provider, models] of Object.entries(rates as Record<string, unknown>)) {
      if (!PROVIDERS.has(provider)) {
        problems.push(`"${provider}" is not a known provider.`);
        continue;
      }
      if (!models || typeof models !== "object" || Array.isArray(models)) {
        problems.push(`${provider}: rates must be an object of models.`);
        continue;
      }
      if (!("default" in (models as object))) {
        problems.push(`${provider}: add a "default" rate for models without their own rate.`);
      }
      for (const [model, rate] of Object.entries(models as Record<string, unknown>)) {
        if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
          problems.push(`${provider} / ${model}: the rate must be an object.`);
          continue;
        }
        for (const [field, value] of Object.entries(rate as Record<string, unknown>)) {
          if (!FIELDS.has(field)) {
            problems.push(`${provider} / ${model}: "${field}" is not a rate field.`);
          } else if (!isAmount(value)) {
            problems.push(`${provider} / ${model}: ${field} must be a number of 0 or more.`);
          }
        }
      }
    }
  }

  if (
    !perCallReservationCeiling ||
    typeof perCallReservationCeiling !== "object" ||
    Array.isArray(perCallReservationCeiling)
  ) {
    problems.push("Per-call reservation ceilings must be an object of providers.");
  } else {
    for (const [provider, value] of Object.entries(perCallReservationCeiling as Record<string, unknown>)) {
      if (!PROVIDERS.has(provider)) problems.push(`Ceiling: "${provider}" is not a known provider.`);
      else if (!isAmount(value)) problems.push(`Ceiling for ${provider} must be a number of 0 or more.`);
    }
  }
  return problems;
}
