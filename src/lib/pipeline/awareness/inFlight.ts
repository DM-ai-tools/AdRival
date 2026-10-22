/**
 * In-flight guards for paid A/B actions. The Set lives at module scope in the
 * panel so it survives source switches and tab unmounts; only the request that
 * added a key removes it.
 */
export type InFlightSource = { kind: string; id: string };

export function inFlightKey(source: InFlightSource, stage: string): string {
  return `${source.kind}:${source.id}:${stage}`;
}

/** Adds the key. Returns false (and changes nothing) when it is already running. */
export function tryAddInFlight(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  return true;
}

/** The stage running for this source, or null. */
export function stageInFlight(set: Set<string>, source: InFlightSource): string | null {
  const prefix = `${source.kind}:${source.id}:`;
  for (const k of set) {
    if (k.startsWith(prefix)) {
      const rest = k.slice(prefix.length);
      if (rest && !rest.includes(":")) return rest;
    }
  }
  return null;
}
