/**
 * Concurrency scopes. A landing-page build is long and runs several at once, so
 * it is counted against its own limit and never blocks (or is blocked by) the
 * user's other paid tasks.
 */
export const RECREATE_BUILD_OPERATION = "recreate.generate_page";

export type ConcurrencyScope = "recreate" | "other";

export function scopeOf(operation: string): ConcurrencyScope {
  return operation === RECREATE_BUILD_OPERATION ? "recreate" : "other";
}
