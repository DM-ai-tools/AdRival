/**
 * Plain-language labels for codes shown on admin screens (call status, usage
 * confidence, billed operations, allowance periods). Unknown codes fall back
 * to readable text rather than the raw value.
 */

function readable(code: string): string {
  const text = code.replace(/[._]+/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : code;
}

const CALL_STATUS: Record<string, string> = {
  succeeded: "Succeeded",
  failed: "Failed",
  timeout: "Timed out",
  not_billable: "Not billed",
  blocked: "Blocked",
};

const CONFIDENCE: Record<string, string> = {
  confirmed: "Confirmed by provider",
  estimated: "Estimated",
  pending_reconciliation: "Waiting for billing check",
};

const OPERATION: Record<string, string> = {
  "search.competitor_discovery": "Competitor search",
  "search.offers_report": "Offers report",
  "search.brand_review_batch": "Brand review (all)",
  "search.location_refresh_batch": "Find addresses (all)",
  "competitor.brand_review": "Brand review",
  "competitor.analyze_landing_page": "Offer & page details",
  "competitor.location_refresh": "Find address",
  "business.analyze_url": "Analyze URL",
  "lookup.competitor_ads": "Brand lookup",
  "lookup.offers_report": "Lookup offers report",
  "lookup.analyze_landing_page": "Lookup page details",
  "lookup.resolve_brand": "Lookup brand details",
  "lookup.recreate_bridge.resolve_brand": "Recreate setup",
  "recreate.generate_page": "Recreate page",
};

const PERIOD_STATUS: Record<string, string> = {
  current: "Current",
  closed: "Closed",
};

const CADENCE: Record<string, string> = {
  none: "Manual",
  monthly: "Monthly",
};

const LEDGER_TYPE: Record<string, string> = {
  period_open: "Period started",
  period_close: "Period ended",
  allowance_set: "Allowance set",
  allowance_added: "Credits added",
  adjustment: "Adjustment",
  charge: "Charge",
  reservation_hold: "Credits held for a run",
  reservation_release: "Hold released",
};

export const callStatusLabel = (code: string | null | undefined) =>
  code ? CALL_STATUS[code] ?? readable(code) : "";
export const confidenceLabel = (code: string | null | undefined) =>
  code ? CONFIDENCE[code] ?? readable(code) : "";
export const operationLabel = (code: string | null | undefined) =>
  code ? OPERATION[code] ?? readable(code.split(".").slice(-1)[0] ?? code) : "";
export const periodStatusLabel = (code: string | null | undefined) =>
  code ? PERIOD_STATUS[code] ?? readable(code) : "";
export const cadenceLabel = (code: string | null | undefined) =>
  code ? CADENCE[code] ?? readable(code) : "";
export const ledgerTypeLabel = (code: string | null | undefined) =>
  code ? LEDGER_TYPE[code] ?? readable(code) : "";

/** "4f2a…c91b" — for ids that still need to be shown, with the full id as a title. */
export function shortId(id: string | null | undefined): string {
  if (!id) return "—";
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}
