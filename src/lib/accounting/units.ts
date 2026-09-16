/**
 * Credit arithmetic. Every stored balance is an integer number of *subunits*
 * so no balance is ever produced by floating-point addition.
 */

/** Subunits per whole credit. 4 decimal places of precision. */
export const CREDIT_SCALE = 10_000;

/** Micro-USD per USD, used for estimated monetary cost. */
export const USD_MICROS = 1_000_000;

export function creditsToSubunits(credits: number): number {
  if (!Number.isFinite(credits)) return 0;
  return Math.round(credits * CREDIT_SCALE);
}

export function subunitsToCredits(subunits: number): number {
  return subunits / CREDIT_SCALE;
}

/** Display string for a credit amount, e.g. 1234 -> "0.1234". */
export function formatCredits(subunits: number, maxDecimals = 4): string {
  const credits = subunitsToCredits(subunits);
  const rounded = credits.toFixed(maxDecimals);
  if (!rounded.includes(".")) return rounded;
  // Trim only the fractional tail, never digits left of the point.
  return rounded.replace(/0+$/, "").replace(/\.$/, "");
}

export function formatUsdMicros(micros: number | null): string {
  if (micros === null || micros === undefined) return "Unavailable";
  return `$${(micros / USD_MICROS).toFixed(4)}`;
}

/**
 * Always round a charge *up* so rounding never leaks free provider usage,
 * but never round a non-zero usage down to zero.
 */
export function chargeCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.ceil(value));
}

export function parseCreditsInput(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return creditsToSubunits(raw);
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\s+/g, "");
  if (!trimmed || !/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  return creditsToSubunits(Number(trimmed));
}
