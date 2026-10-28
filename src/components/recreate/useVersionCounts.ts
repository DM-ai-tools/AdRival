"use client";

import { useEffect, useState } from "react";
import { fetchVersionCounts } from "@/lib/recreateClient";

const NONE: Record<string, number> = {};

/**
 * How many recreations each source page of a search (or a lookup) has, read
 * once per list (not per row) when the list opens. Pages added afterwards are
 * counted by their own "Add to Recreate" button.
 */
export function useVersionCounts(of: { runId: string } | { lookupId: string } | null): Record<string, number> {
  const key = !of ? "" : "runId" in of ? `run:${of.runId}` : `lookup:${of.lookupId}`;
  const [state, setState] = useState<{ key: string; counts: Record<string, number> }>({ key: "", counts: NONE });

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const sep = key.indexOf(":");
    const id = key.slice(sep + 1);
    const query = key.slice(0, sep) === "run" ? { runId: id } : { lookupId: id };
    void fetchVersionCounts(query).then((counts) => {
      if (!cancelled) setState({ key, counts });
    });
    return () => {
      cancelled = true;
    };
  }, [key]);

  // Counts of another list are never shown while this one's load.
  return state.key === key ? state.counts : NONE;
}
