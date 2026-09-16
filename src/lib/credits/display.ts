import type { ProviderId, UsageConfidence } from "@/lib/types";

/**
 * Client-facing provider labels. Vendor names stay out of user screens so the
 * app can be demoed to clients; admins see the real ids in the admin area.
 */
const USER_FACING_PROVIDER_LABELS: Record<ProviderId, string> = {
  sociavault: "Ad library",
  openrouter: "Analysis service",
  openai: "Content engine",
  anthropic: "Content engine",
  firecrawl: "Site scrape",
  brandfetch: "Brand lookup",
  runway: "Image generation",
};

const ADMIN_PROVIDER_LABELS: Record<ProviderId, string> = {
  sociavault: "SociaVault",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  firecrawl: "Firecrawl",
  brandfetch: "Brandfetch",
  runway: "Runway",
};

export function providerLabel(
  provider: string,
  audience: "user" | "admin" = "user",
): string {
  const table =
    audience === "admin"
      ? ADMIN_PROVIDER_LABELS
      : USER_FACING_PROVIDER_LABELS;
  return table[provider as ProviderId] ?? provider;
}

/**
 * User views must never see raw model slugs, which name the vendor. Admins do,
 * because they configure conversion rates per model.
 */
export function modelLabel(
  model: string | null | undefined,
  audience: "user" | "admin" = "user",
): string {
  if (!model) return "—";
  return audience === "admin" ? model : "—";
}

export const CONFIDENCE_LABELS: Record<UsageConfidence, string> = {
  confirmed: "Confirmed",
  estimated: "Estimated",
  pending_reconciliation: "Pending reconciliation",
};

export function confidenceLabel(value: string): string {
  return CONFIDENCE_LABELS[value as UsageConfidence] ?? value;
}

/** Compact usage summary, e.g. "1.2k in / 340 out" or "3 requests". */
export function usageSummary(usage: {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
}): string {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`${usage.inputTokens.toLocaleString()} in`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`${usage.outputTokens.toLocaleString()} out`);
  }
  if (usage.images !== undefined) parts.push(`${usage.images} image(s)`);
  if (!parts.length && usage.requests !== undefined) {
    parts.push(`${usage.requests} request(s)`);
  }
  return parts.length ? parts.join(" / ") : "Not reported";
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
