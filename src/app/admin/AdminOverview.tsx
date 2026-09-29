"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCredits, formatUsdMicros } from "@/lib/accounting/units";
import { formatDateTime, providerLabel } from "@/lib/credits/display";
import type { AuditLogEntry, CreditReservation, ProviderCallRecord } from "@/lib/types";
import { callStatusLabel, confidenceLabel, operationLabel } from "@/lib/admin/labels";
import { InlineNotice, adminFetch, type Notice } from "./adminUi";

interface ProviderBalance {
  provider: string;
  status: "available" | "unavailable" | "error";
  balance: number | null;
  currency: string | null;
  note: string;
}

interface TrackedSpendRow {
  provider: string;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usdMicros: number | null;
  basis: "stored" | "list_price" | "unpriced";
}

interface OverviewPayload {
  range: { days: number | null };
  users: { total: number; active: number; suspended: number; deleted: number; admins: number };
  credits: { allocatedSubunits: number; consumedSubunits: number; reservedSubunits: number; remainingSubunits: number };
  trackedSpend: { rows: TrackedSpendRow[]; totalUsdMicros: number | null; unpricedCalls: number; inputTokens: number; outputTokens: number };
  usageByProvider: Array<{
    provider: string;
    calls: number;
    creditsCharged: number;
    confirmedCalls: number;
    estimatedCalls: number;
    pendingCalls: number;
    failedCalls: number;
    estimatedCostUsdMicros: number | null;
  }>;
  usageByDate: Array<{ date: string; calls: number; creditsCharged: number }>;
  recentFailures: ProviderCallRecord[];
  pendingReconciliation: Array<CreditReservation & { username: string | null }>;
  recentAudit: Array<AuditLogEntry & { actionLabel: string; targetUsername: string | null; detailsText: string }>;
}

const RANGES = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

export default function AdminOverview({ onOpenUser }: { onOpenUser?: (userId: string) => void }) {
  const [range, setRange] = useState("30");
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ rows: ProviderBalance[]; checkedAt: string } | null>(null);
  const [balancesBusy, setBalancesBusy] = useState(false);
  const [reconcile, setReconcile] = useState<{ row: OverviewPayload["pendingReconciliation"][number]; outcome: "billed" | "not_billed" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await adminFetch<OverviewPayload>(`/api/admin/overview?days=${range}`));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  const loadBalances = useCallback(async (refresh = false) => {
    setBalancesBusy(true);
    try {
      const json = await adminFetch<{ providerBalances: ProviderBalance[]; checkedAt: string }>(
        `/api/admin/overview?part=balances${refresh ? "&refresh=1" : ""}`,
      );
      setBalances({ rows: json.providerBalances, checkedAt: json.checkedAt });
    } catch {
      setBalances(null);
    } finally {
      setBalancesBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  // Credits charged next to what the calls cost, per service.
  const costRows = useMemo(() => {
    if (!data) return [];
    const spend = new Map<string, number | null>();
    for (const row of data.trackedSpend.rows) {
      const prev = spend.get(row.provider);
      spend.set(row.provider, row.usdMicros === null ? prev ?? null : (prev ?? 0) + row.usdMicros);
    }
    return data.usageByProvider.map((row) => ({
      ...row,
      costUsdMicros: spend.has(row.provider) ? spend.get(row.provider)! : row.estimatedCostUsdMicros,
    }));
  }, [data]);

  const maxDay = Math.max(1, ...(data?.usageByDate ?? []).map((d) => d.creditsCharged));

  if (loading && !data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="muted">Loading overview…</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="error-text" role="alert">
          {error ?? "Could not load the overview."}
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="panel glow-panel admin-panel">
        <div className="progress-head">
          <h2>Accounts and credits</h2>
          <label className="admin-check-filter">
            <span className="search-label">Period</span>{" "}
            <select className="search-input" value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <dl className="progress-stats">
          <div>
            <dt>Active users</dt>
            <dd>{data.users.active}</dd>
          </div>
          <div>
            <dt>Suspended</dt>
            <dd>{data.users.suspended}</dd>
          </div>
          <div>
            <dt>Admins</dt>
            <dd>{data.users.admins}</dd>
          </div>
          <div>
            <dt>Credits allocated now</dt>
            <dd>{formatCredits(data.credits.allocatedSubunits)}</dd>
          </div>
          <div>
            <dt>Used this period</dt>
            <dd>{formatCredits(data.credits.consumedSubunits)}</dd>
          </div>
          <div>
            <dt>Held for running work</dt>
            <dd>{formatCredits(data.credits.reservedSubunits)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{formatCredits(data.credits.remainingSubunits)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Credits charged against cost</h2>
        <p className="muted">
          Credits users were charged, next to what the calls cost at list price in the selected period. The cost is worked
          out in this app from stored token counts; an unknown price shows as unavailable, never $0.
        </p>
        <dl className="progress-stats">
          <div>
            <dt>Total cost</dt>
            <dd>{formatUsdMicros(data.trackedSpend.totalUsdMicros ?? null)}</dd>
          </div>
          <div>
            <dt>Credits charged</dt>
            <dd>{formatCredits(costRows.reduce((s, r) => s + r.creditsCharged, 0))}</dd>
          </div>
          <div>
            <dt>Calls without a price</dt>
            <dd>{data.trackedSpend.unpricedCalls}</dd>
          </div>
        </dl>
        {costRows.length === 0 ? (
          <p className="empty-hint">No usage in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Calls</th>
                  <th>Credits charged</th>
                  <th>Cost</th>
                  <th>Failed</th>
                  <th>Awaiting billing check</th>
                </tr>
              </thead>
              <tbody>
                {costRows.map((row) => (
                  <tr key={row.provider}>
                    <td>{providerLabel(row.provider, "admin")}</td>
                    <td>{row.calls}</td>
                    <td>{formatCredits(row.creditsCharged)}</td>
                    <td>{row.costUsdMicros === null ? "Unavailable" : formatUsdMicros(row.costUsdMicros)}</td>
                    <td>{row.failedCalls || "—"}</td>
                    <td>{row.pendingCalls || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.trackedSpend.rows.length ? (
          <details className="admin-details">
            <summary>Cost by model</summary>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Model</th>
                    <th>Calls</th>
                    <th>Input tokens</th>
                    <th>Output tokens</th>
                    <th>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.trackedSpend.rows.map((row) => (
                    <tr key={`${row.provider}:${row.model ?? "none"}`}>
                      <td>{providerLabel(row.provider, "admin")}</td>
                      <td>{row.model ?? "—"}</td>
                      <td>{row.calls}</td>
                      <td>{row.inputTokens.toLocaleString()}</td>
                      <td>{row.outputTokens.toLocaleString()}</td>
                      <td>{row.usdMicros === null ? "Unavailable" : formatUsdMicros(row.usdMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        ) : null}

        <div className="progress-head">
          <h3>Provider account balances</h3>
          <button type="button" className="chip-btn" disabled={balancesBusy} onClick={() => void loadBalances(true)}>
            {balancesBusy ? "Checking…" : "Check again"}
          </button>
        </div>
        {!balances ? (
          <p className="muted">{balancesBusy ? "Checking balances…" : "Balances could not be loaded."}</p>
        ) : (
          <>
            <p className="form-hint">Only providers with a balance API are shown with a figure. Checked {formatDateTime(balances.checkedAt)}.</p>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Balance</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {balances.rows.map((row) => (
                    <tr key={row.provider}>
                      <td>{providerLabel(row.provider, "admin")}</td>
                      <td>
                        {row.status === "available" && row.balance !== null
                          ? `${Number.isInteger(row.balance) ? row.balance : row.balance.toFixed(4)} ${row.currency ?? ""}`.trim()
                          : row.status === "error"
                            ? "Could not check"
                            : "Not available"}
                      </td>
                      <td className="muted">{row.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Credits used per day</h2>
        {data.usageByDate.length === 0 ? (
          <p className="empty-hint">No usage in this period.</p>
        ) : (
          <ol className="admin-day-bars">
            {data.usageByDate.map((row) => (
              <li key={row.date}>
                <span className="admin-day-label">{row.date}</span>
                <span className="admin-day-bar" aria-hidden="true">
                  <i style={{ width: `${Math.max(2, (row.creditsCharged / maxDay) * 100)}%` }} />
                </span>
                <span className="admin-day-value">
                  {formatCredits(row.creditsCharged)} <span className="muted">· {row.calls} calls</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Billing checks</h2>
        <p className="muted">
          Calls where we don’t know if the provider billed (a timeout or an aborted request). The credits stay held until you
          record what happened.
        </p>
        {data.pendingReconciliation.length === 0 ? (
          <p className="empty-hint">Nothing waiting.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>User</th>
                  <th>For</th>
                  <th>Held</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.pendingReconciliation.map((res) => (
                  <tr key={res.id}>
                    <td className="admin-nowrap">{formatDateTime(res.createdAt)}</td>
                    <td>
                      {res.username && onOpenUser ? (
                        <button type="button" className="link-btn" onClick={() => onOpenUser(res.userId)}>
                          @{res.username}
                        </button>
                      ) : (
                        res.username ?? "—"
                      )}
                    </td>
                    <td>{operationLabel(res.operation)}</td>
                    <td>{formatCredits(res.amountSubunits)}</td>
                    <td>
                      <div className="admin-table-actions">
                        <button type="button" className="chip-btn" onClick={() => setReconcile({ row: res, outcome: "billed" })}>
                          It was billed
                        </button>
                        <button type="button" className="chip-btn" onClick={() => setReconcile({ row: res, outcome: "not_billed" })}>
                          It wasn’t billed
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Recent failures</h2>
        {data.recentFailures.length === 0 ? (
          <p className="empty-hint">No failed calls in this period.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Service</th>
                  <th>For</th>
                  <th>Result</th>
                  <th>Billing</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.recentFailures.map((call) => (
                  <tr key={call.id}>
                    <td className="admin-nowrap">{formatDateTime(call.startedAt)}</td>
                    <td>{providerLabel(call.provider, "admin")}</td>
                    <td>{operationLabel(call.operation)}</td>
                    <td>
                      <span className="status-pill status-failed">{callStatusLabel(call.status)}</span>
                    </td>
                    <td>{confidenceLabel(call.usageConfidence)}</td>
                    <td className="muted">{call.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <div className="progress-head">
          <h2>Recent admin activity</h2>
          <a className="chip-btn" href="/admin?tab=audit">
            Full audit log
          </a>
        </div>
        {data.recentAudit.length === 0 ? (
          <p className="empty-hint">No admin activity yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>User affected</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAudit.map((entry) => (
                  <tr key={entry.id}>
                    <td className="admin-nowrap">{formatDateTime(entry.createdAt)}</td>
                    <td>@{entry.actorUsername ?? "system"}</td>
                    <td>{entry.actionLabel}</td>
                    <td>{entry.targetUsername ? `@${entry.targetUsername}` : "—"}</td>
                    <td className="muted">{entry.detailsText || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {reconcile ? (
        <ReconcileDialog
          row={reconcile.row}
          outcome={reconcile.outcome}
          onClose={() => setReconcile(null)}
          onDone={() => {
            setReconcile(null);
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function ReconcileDialog({
  row,
  outcome,
  onClose,
  onDone,
}: {
  row: OverviewPayload["pendingReconciliation"][number];
  outcome: "billed" | "not_billed";
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const billed = outcome === "billed";
  async function submit() {
    setBusy(true);
    try {
      await adminFetch("/api/admin/usage/reconcile", {
        method: "POST",
        json: { reservationId: row.id, outcome, reason },
      });
      onDone();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
      setBusy(false);
    }
  }
  return (
    <div className="confirm-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="confirm-dialog admin-modal" role="dialog" aria-modal="true" aria-label="Record billing outcome">
        <h3 className="confirm-title">{billed ? "The provider billed this call" : "The provider did not bill this call"}</h3>
        <p className="confirm-desc">
          {billed
            ? `@${row.username ?? "the user"} is charged the ${formatCredits(row.amountSubunits)} credits being held.`
            : `The ${formatCredits(row.amountSubunits)} credits being held go back to @${row.username ?? "the user"}.`}
        </p>
        <label className="admin-field">
          <span className="search-label">How you know (kept in the audit log)</span>
          <textarea className="search-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Checked the provider dashboard" />
        </label>
        <InlineNotice notice={notice} />
        <div className="confirm-actions">
          <button type="button" className="chip-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="chip-btn confirm-primary" disabled={busy || !reason.trim()} onClick={() => void submit()}>
            {busy ? "Saving…" : billed ? "Charge the credits" : "Release the credits"}
          </button>
        </div>
      </div>
    </div>
  );
}
