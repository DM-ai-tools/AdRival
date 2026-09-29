/**
 * Plain-language names for pipeline stages, run statuses and offers phases.
 * The raw values are internal codes (e.g. "filling_quota") and should never be
 * shown to users directly.
 */

const STAGE_LABELS: Record<string, string> = {
  queued: "Starting",
  expanding_queries: "Planning searches",
  searching_ads: "Reading ads",
  analyzing_ad: "Checking relevance",
  filling_quota: "Filling the list",
  finding_domains: "Finding advertisers",
  verifying_domains: "Checking advertisers",
  ranking_domains: "Ranking advertisers",
  fetching_ads: "Fetching ads",
  searching_pages: "Finding the brand",
  verifying_page: "Confirming the brand",
  brand_review: "Brand review",
  analyzing_offers: "Building offers report",
  done: "Finished",
  failed: "Failed",
};

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  completed: "Finished",
  partial: "Partly finished",
  failed: "Failed",
  brand_review: "Brand review",
  pending: "Waiting",
  skipped: "Skipped",
};

const OFFERS_PHASE_LABELS: Record<string, string> = {
  starting: "Starting",
  fetch_ads: "Collecting ads",
  analysis: "Analyzing ads and landing pages",
  done: "Finished",
  failed: "Failed",
};

function fallback(code: string): string {
  const text = code.replace(/_/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "";
  return STAGE_LABELS[stage] ?? fallback(stage);
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABELS[status] ?? fallback(status);
}

export function offersPhaseLabel(phase: string | null | undefined): string {
  if (!phase) return "";
  return OFFERS_PHASE_LABELS[phase] ?? fallback(phase);
}

/** "3m 05s", "1h 12m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** A run with no progress update for this long has probably stopped responding. */
export const STALLED_AFTER_MS = 3 * 60 * 1000;
