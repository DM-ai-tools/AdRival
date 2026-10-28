"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecreateListItem } from "@/lib/recreateList";
import { RECREATE_CHANGED_EVENT } from "@/lib/recreateClient";

const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const DEFAULT_LIMIT = 3;

/**
 * The Recreate tab's list, kept live: polls every 3 s while a page is queued
 * or running (15 s otherwise), pauses while the tab is hidden, and refreshes
 * at once when a page is added anywhere in the app.
 */
export function useRecreateJobs(spaceId: string | null): {
  items: RecreateListItem[];
  limit: number;
  running: number;
  queued: number;
  loading: boolean;
  error: string | null;
  refresh(): Promise<void>;
  stop(jobId: string): Promise<void>;
} {
  const [items, setItems] = useState<RecreateListItem[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    const mine = ++requestId.current;
    try {
      const res = await fetch(`/api/recreate/jobs?spaceId=${encodeURIComponent(spaceId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { items?: RecreateListItem[]; limit?: number; error?: string };
      if (mine !== requestId.current) return; // a newer refresh (or a space change) took over
      if (!res.ok) throw new Error(data.error || "Could not load your recreated pages.");
      setItems(Array.isArray(data.items) ? data.items : []);
      if (typeof data.limit === "number" && data.limit > 0) setLimit(data.limit);
      setError(null);
    } catch (err) {
      if (mine !== requestId.current) return;
      setError(err instanceof Error ? err.message : "Could not load your recreated pages.");
    } finally {
      if (mine === requestId.current) setLoading(false);
    }
  }, [spaceId]);

  const running = items.filter((i) => i.state === "running").length;
  const queued = items.filter((i) => i.state === "queued").length;
  const busy = running + queued > 0;

  // A new space starts from an empty list.
  useEffect(() => {
    setItems([]);
    setError(null);
    setLoading(Boolean(spaceId));
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const schedule = () => {
      if (cancelled || document.hidden) return;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, busy ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    const clear = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const onVisibility = () => {
      clear();
      if (document.hidden) return;
      void refresh().then(schedule);
    };
    const onChanged = () => {
      clear();
      void refresh().then(schedule);
    };
    void refresh().then(schedule);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(RECREATE_CHANGED_EVENT, onChanged);
    return () => {
      cancelled = true;
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(RECREATE_CHANGED_EVENT, onChanged);
    };
  }, [spaceId, busy, refresh]);

  const stop = useCallback(
    async (jobId: string) => {
      const res = await fetch(`/api/recreate/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Could not stop this page.");
      }
      await refresh();
    },
    [refresh],
  );

  return { items, limit, running, queued, loading, error, refresh, stop };
}
