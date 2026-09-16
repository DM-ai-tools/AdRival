"use client";

import { useCallback, useEffect, useState } from "react";
import { formatDateTime } from "@/lib/credits/display";

interface LowCreditAlert {
  userId: string;
  username: string;
  displayName: string;
  availableCredits: string;
  allowanceCredits: string;
  warningCredits: string;
}

interface ProviderCreditAlert {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  provider: string;
  providerLabel: string;
  runId: string | null;
  createdAt: string;
}

export default function AdminAlerts() {
  const [lowCredit, setLowCredit] = useState<LowCreditAlert[]>([]);
  const [providerCredits, setProviderCredits] = useState<ProviderCreditAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/alerts", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load alerts");
      setLowCredit(json.lowCredit ?? []);
      setProviderCredits(json.providerCredits ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byUser = new Map<string, ProviderCreditAlert[]>();
  for (const alert of providerCredits) {
    const key = alert.userId;
    byUser.set(key, [...(byUser.get(key) ?? []), alert]);
  }

  return (
    <section className="panel glow-panel admin-panel">
      <div className="progress-head">
        <div>
          <h2>Alerts</h2>
          <p className="muted">
            Low user balances, and provider accounts that ran out of credits
            while someone was working. Users are not told which provider failed.
          </p>
        </div>
        <button type="button" className="chip-btn" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? <p className="muted">Loading alerts…</p> : null}

      <h3>Low credits by user</h3>
      {!loading && lowCredit.length === 0 ? (
        <p className="empty-hint">No active users are under the low-credit warning.</p>
      ) : (
        <ul className="admin-alert-list">
          {lowCredit.map((row) => (
            <li key={row.userId}>
              <strong>
                {row.displayName} <span className="muted">@{row.username}</span>
              </strong>
              <span>
                {row.availableCredits} left of {row.allowanceCredits} allowance.
                Warning threshold is {row.warningCredits}.
              </span>
            </li>
          ))}
        </ul>
      )}

      <h3>Provider credits exhausted</h3>
      {!loading && providerCredits.length === 0 ? (
        <p className="empty-hint">No provider has reported insufficient credits yet.</p>
      ) : (
        [...byUser.entries()].map(([userId, alerts]) => (
          <div key={userId} className="admin-alert-group">
            <h4>
              {alerts[0].displayName}{" "}
              <span className="muted">@{alerts[0].username}</span>
            </h4>
            <ul className="admin-alert-list">
              {alerts.map((alert) => (
                <li key={alert.id}>
                  <strong>{alert.providerLabel}</strong>
                  <span className="muted">
                    ran out of credits · {formatDateTime(alert.createdAt)}
                    {alert.runId ? ` · run ${alert.runId.slice(0, 8)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
