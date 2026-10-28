"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RecreateListItem } from "@/lib/recreateList";
import { RECREATE_CHANGED_EVENT } from "@/lib/recreateClient";
import { createPollScheduler, stopFailureMessage } from "@/lib/recreateHubState";

const BUSY_POLL_MS = 3000;
const IDLE_POLL_MS = 15000;
const DEFAULT_LIMIT = 3;
const STOP_ERROR_MS = 6000;

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
  stopError: string | null;
  refresh(): Promise<void>;
  stop(jobId: string): Promise<void>;
} {
  const [items, setItems] = useState<RecreateListItem[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);
  const requestId = useRef(0);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!spaceId) return;
    const mine = ++requestId.current;
    try {
      const res = await fetch(`/api/recreate/jobs?spaceId=${encodeURIComponent(spaceId)}`, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { items?: RecreateListItem[]; limit?: number; error?: string };
      if (mine !== requestId.current) return; // a newer refresh (or a space change) took over
      if (!res.ok) throw new Error(data.error || "Could not load your recreated pages.");
      const next = Array.isArray(data.items) ? data.items : [];
      // Set here (not during render) so the next poll interval is right straight away.
      busyRef.current = next.some((i) => i.state === "queued" || i.state === "running");
      setItems(next);
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

  // A new space starts from an empty list; responses still in flight for the old one are dropped.
  useEffect(() => {
    requestId.current++;
    busyRef.current = false;
    setItems([]);
    setError(null);
    setStopError(null);
    setLoading(Boolean(spaceId));
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId) return;
    const scheduler = createPollScheduler({
      intervalFor: () => (busyRef.current ? BUSY_POLL_MS : IDLE_POLL_MS),
      run: refresh,
      paused: () => document.hidden,
    });
    const onVisibility = () => {
      if (!document.hidden) void scheduler.trigger();
    };
    const onChanged = () => void scheduler.trigger();
    void scheduler.trigger();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(RECREATE_CHANGED_EVENT, onChanged);
    return () => {
      scheduler.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(RECREATE_CHANGED_EVENT, onChanged);
    };
  }, [spaceId, refresh]);

  useEffect(() => {
    if (!stopError) return;
    const timer = setTimeout(() => setStopError(null), STOP_ERROR_MS);
    return () => clearTimeout(timer);
  }, [stopError]);

  const stop = useCallback(
    async (jobId: string) => {
      setStopError(null);
      try {
        const res = await fetch(`/api/recreate/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setStopError(stopFailureMessage(res.status, data.error));
        }
      } catch {
        setStopError(stopFailureMessage(null));
      }
      await refresh();
    },
    [refresh],
  );

  return { items, limit, running, queued, loading, error, stopError, refresh, stop };
}
