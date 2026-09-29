"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "@/lib/credits/display";
import { InlineNotice, adminFetch, type Notice } from "./adminUi";

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
  acknowledgedAt: string | null;
}

export default function AdminAlerts({
  onOpenUser,
  onChanged,
}: {
  onOpenUser?: (userId: string) => void;
  onChanged?: () => void;
}) {
  const [lowCredit, setLowCredit] = useState<LowCreditAlert[]>([]);
  const [providerCredits, setProviderCredits] = useState<ProviderCreditAlert[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [amount, setAmount] = useState("25");
  const [reason, setReason] = useState("Low-credit top-up");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const json = await adminFetch<{ lowCredit: LowCreditAlert[]; providerCredits: ProviderCreditAlert[] }>(
        `/api/admin/alerts${showDismissed ? "?all=1" : ""}`,
      );
      setLowCredit(json.lowCredit ?? []);
      setProviderCredits(json.providerCredits ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [showDismissed]);

  useEffect(() => {
    void load();
  }, [load]);

  async function topUp(userIds: string[], key: string) {
    if (!reason.trim() || !amount.trim()) {
      setNotice({ tone: "error", text: "Enter an amount and a reason first." });
      return;
    }
    setBusy(key);
    setNotice(null);
    try {
      const json = await adminFetch<{ updated: unknown[] }>("/api/admin/credits/bulk", {
        method: "POST",
        json: { userIds, credits: amount, reason },
      });
      setNotice({
        tone: "ok",
        text: `Added ${amount} credits to ${json.updated.length} user${json.updated.length === 1 ? "" : "s"}.`,
      });
      await load();
      onChanged?.();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function dismiss(ids: string[], key: string) {
    setBusy(key);
    setNotice(null);
    try {
      await adminFetch("/api/admin/alerts", { method: "POST", json: { alertIds: ids } });
      await load();
      onChanged?.();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  // One group per provider: the fix (top up that account) is per provider.
  const byProvider = useMemo(() => {
    const map = new Map<string, ProviderCreditAlert[]>();
    for (const alert of providerCredits) {
      map.set(alert.provider, [...(map.get(alert.provider) ?? []), alert]);
    }
    return [...map.values()];
  }, [providerCredits]);

  return (
    <section className="panel glow-panel admin-panel">
      <div className="progress-head">
        <div>
          <h2>Alerts</h2>
          <p className="muted">
            Low user balances, and provider accounts that ran out of credits while someone was working. Users are not told
            which provider failed.
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
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {loading && !lowCredit.length && !providerCredits.length ? <p className="muted">Loading alerts…</p> : null}

      <h3>Low credits</h3>
      {!loading && lowCredit.length === 0 ? (
        <p className="empty-hint">No active users are under the low-credit warning.</p>
      ) : (
        <>
          <form
            className="admin-inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void topUp(lowCredit.map((r) => r.userId), "all");
            }}
          >
            <label className="admin-field">
              <span className="search-label">Credits to add</span>
              <input className="search-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            <label className="admin-field">
              <span className="search-label">Reason</span>
              <input className="search-input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            {lowCredit.length > 1 ? (
              <button type="submit" className="chip-btn" disabled={busy !== null}>
                {busy === "all" ? "Adding…" : `Top up all ${lowCredit.length}`}
              </button>
            ) : null}
          </form>
          <ul className="admin-alert-list">
            {lowCredit.map((row) => (
              <li key={row.userId} className="admin-alert-row">
                <span>
                  <strong>
                    {onOpenUser ? (
                      <button type="button" className="link-btn" onClick={() => onOpenUser(row.userId)}>
                        {row.displayName}
                      </button>
                    ) : (
                      row.displayName
                    )}{" "}
                    <span className="muted">@{row.username}</span>
                  </strong>
                  <span className="muted">
                    {" "}
                    {row.availableCredits} left of {row.allowanceCredits}. Warning at {row.warningCredits}.
                  </span>
                </span>
                <button type="button" className="chip-btn" disabled={busy !== null} onClick={() => void topUp([row.userId], row.userId)}>
                  {busy === row.userId ? "Adding…" : `Add ${amount || "…"} credits`}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="progress-head">
        <h3>Provider accounts out of credits</h3>
        <label className="admin-check-filter">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed
        </label>
      </div>
      <p className="form-hint">
        Top up the provider account, then dismiss the alert. A new alert appears if it runs out again.
      </p>
      {!loading && providerCredits.length === 0 ? (
        <p className="empty-hint">{showDismissed ? "No provider alerts." : "No open provider alerts."}</p>
      ) : (
        byProvider.map((alerts) => {
          const open = alerts.filter((a) => !a.acknowledgedAt);
          return (
            <div key={alerts[0].provider} className="admin-alert-group">
              <div className="progress-head">
                <h4>
                  {alerts[0].providerLabel}{" "}
                  <span className="muted">
                    · {alerts.length} time{alerts.length === 1 ? "" : "s"}, last {formatDateTime(alerts[0].createdAt)}
                  </span>
                </h4>
                {open.length ? (
                  <button
                    type="button"
                    className="chip-btn"
                    disabled={busy !== null}
                    onClick={() => void dismiss(open.map((a) => a.id), alerts[0].provider)}
                  >
                    {busy === alerts[0].provider ? "Dismissing…" : `Dismiss ${open.length === 1 ? "" : "all "}`}
                  </button>
                ) : null}
              </div>
              <ul className="admin-alert-list">
                {alerts.map((alert) => (
                  <li key={alert.id}>
                    <span>
                      While{" "}
                      {onOpenUser ? (
                        <button type="button" className="link-btn" onClick={() => onOpenUser(alert.userId)}>
                          @{alert.username}
                        </button>
                      ) : (
                        `@${alert.username}`
                      )}{" "}
                      was working · {formatDateTime(alert.createdAt)}
                      {alert.acknowledgedAt ? <span className="muted"> · dismissed</span> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
