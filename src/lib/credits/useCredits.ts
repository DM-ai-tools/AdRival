"use client";

import { useCallback, useEffect, useState } from "react";
import type { CreditSummary } from "@/lib/accounting/service";
import type { RunPrecheck } from "@/lib/accounting/run";

export interface ProviderBreakdownRow {
  provider: string;
  calls: number;
  creditsCharged: number;
  confirmedCalls: number;
  estimatedCalls: number;
  pendingCalls: number;
  failedCalls: number;
}

export interface RunUsageRow {
  runId: string;
  projectKind: string | null;
  projectId: string | null;
  projectTitle: string | null;
  operation: string;
  calls: number;
  creditsCharged: number;
  pendingCalls: number;
  failedCalls: number;
  startedAt: string;
  completedAt: string;
}

export interface CreditsPayload {
  credits: CreditSummary;
  usageByProvider: ProviderBreakdownRow[];
  recentRuns: RunUsageRow[];
  canStartRun: RunPrecheck;
}

export interface UseCreditsResult {
  data: CreditsPayload | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Reads the caller's own credit summary. Cleared and refetched whenever the
 * session changes so a switched account never sees the previous user's balance.
 */
export function useCredits(pollMs = 0): UseCreditsResult {
  const [data, setData] = useState<CreditsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/credits/summary", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setData(null);
        setError(null);
        return;
      }
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load credits");
      setData(json as CreditsPayload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (!pollMs) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [refresh, pollMs]);

  return { data, loading, error, refresh };
}
