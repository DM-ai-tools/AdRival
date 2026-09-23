/** In-flight unified recreate aborts (one AbortController per competitor). */
const aborts = new Map<string, AbortController>();

export function beginUnifiedAbort(competitorId: string): AbortSignal {
  abortUnifiedRun(competitorId);
  const controller = new AbortController();
  aborts.set(competitorId, controller);
  return controller.signal;
}

export function endUnifiedAbort(competitorId: string, signal?: AbortSignal): void {
  const current = aborts.get(competitorId);
  if (!current) return;
  if (signal && current.signal !== signal) return;
  aborts.delete(competitorId);
}

export function abortUnifiedRun(competitorId: string): boolean {
  const controller = aborts.get(competitorId);
  if (!controller) return false;
  controller.abort();
  aborts.delete(competitorId);
  return true;
}

export function isUnifiedAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  return name === "AbortError" || name === "APIUserAbortError";
}
