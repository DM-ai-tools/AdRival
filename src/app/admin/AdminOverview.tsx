"use client";

import { useCallback, useEffect, useState } from "react";
import { formatCredits, formatUsdMicros } from "@/lib/accounting/units";
import {
  confidenceLabel,
  formatDateTime,
  providerLabel,
} from "@/lib/credits/display";
import type {
  AuditLogEntry,
  CreditReservation,
  ProviderCallRecord,
} from "@/lib/types";

interface ProviderBalance {
  provider: string;
  status: "available" | "unavailable" | "error";
  balance: number | null;
  currency: string | null;
  totalPurchased: number | null;
  totalUsed: number | null;
  note: string;
}

interface TrackedSpendRow {
  provider: string;
  model: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  usdMicros: number | null;
  unpricedCalls: number;
  basis: "stored" | "list_price" | "unpriced";
}

interface OverviewPayload {
  users: {
    total: number;
    active: number;
    suspended: number;
    deleted: number;
    admins: number;
  };
  credits: {
    allocatedSubunits: number;
    consumedSubunits: number;
    reservedSubunits: number;
    remainingSubunits: number;
  };
  trackedSpend: {
    rows: TrackedSpendRow[];
    totalUsdMicros: number | null;
    unpricedCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
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
  pendingReconciliation: CreditReservation[];
  recentAudit: AuditLogEntry[];
  providerBalances: ProviderBalance[];
}

export default function AdminOverview() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/overview", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load overview");
      setData(json as OverviewPayload);
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

  async function resolveReconciliation(
    reservationId: string,
    outcome: "billed" | "not_billed",
  ) {
    const reason = window.prompt(
      outcome === "billed"
        ? "Reason / evidence that the provider did bill this call:"
        : "Reason / evidence that the provider did NOT bill this call:",
    );
    if (reason === null) return;
    setBusyId(reservationId);
    try {
      const res = await fetch("/api/admin/usage/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId, outcome, reason }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to resolve");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  if (loading && !data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="muted">Loading overview…</p>
      </section>
    );
  }

  if (error && !data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="error-text" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (!data) return null;

  return (
    <>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel glow-panel admin-panel">
        <h2>Accounts</h2>
        <dl className="progress-stats">
          <div>
            <dt>Total</dt>
            <dd>{data.users.total}</dd>
          </div>
          <div>
            <dt>Active</dt>
            <dd>{data.users.active}</dd>
          </div>
          <div>
            <dt>Suspended</dt>
            <dd>{data.users.suspended}</dd>
          </div>
          <div>
            <dt>Deleted</dt>
            <dd>{data.users.deleted}</dd>
          </div>
          <div>
            <dt>Admins</dt>
            <dd>{data.users.admins}</dd>
          </div>
        </dl>

        <h3>Credits across current periods</h3>
        <dl className="progress-stats">
          <div>
            <dt>Allocated</dt>
            <dd>{formatCredits(data.credits.allocatedSubunits)}</dd>
          </div>
          <div>
            <dt>Consumed</dt>
            <dd>{formatCredits(data.credits.consumedSubunits)}</dd>
          </div>
          <div>
            <dt>Reserved</dt>
            <dd>{formatCredits(data.credits.reservedSubunits)}</dd>
          </div>
          <div>
            <dt>Remaining</dt>
            <dd>{formatCredits(data.credits.remainingSubunits)}</dd>
          </div>
        </dl>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Provider spend</h2>
        <p className="muted">
          Each call stores its input and output tokens. The dollar figure is
          tokens times the documented price per million for that model, kept as
          a running total in this app. It is not a live vendor balance, and an
          unknown price is shown as unavailable — never $0.
        </p>
        <dl className="progress-stats">
          <div>
            <dt>Running total</dt>
            <dd>{formatUsdMicros(data.trackedSpend?.totalUsdMicros ?? null)}</dd>
          </div>
          <div>
            <dt>Input tokens</dt>
            <dd>{(data.trackedSpend?.inputTokens ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{(data.trackedSpend?.outputTokens ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Unpriced calls</dt>
            <dd>{data.trackedSpend?.unpricedCalls ?? 0}</dd>
          </div>
        </dl>
        {!data.trackedSpend?.rows?.length ? (
          <p className="empty-hint">No provider calls recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Calculated cost</th>
                  <th>Basis</th>
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
                    <td>
                      {row.usdMicros === null
                        ? "Unavailable"
                        : formatUsdMicros(row.usdMicros)}
                    </td>
                    <td className="muted">
                      {row.basis === "stored"
                        ? "Stored on the call"
                        : row.basis === "list_price"
                          ? "List price × tokens"
                          : "No token price"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>Live account balance</h3>
        <p className="muted">
          Shown only when the provider publishes a balance API. Missing balances
          stay unavailable — the tracked total above is separate.
        </p>
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Balance</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.providerBalances.map((row) => (
                <tr key={row.provider}>
                  <td>{providerLabel(row.provider, "admin")}</td>
                  <td>
                    {row.status === "available" && row.balance !== null
                      ? `${Number.isInteger(row.balance) ? row.balance : row.balance.toFixed(4)} ${row.currency ?? ""}`.trim()
                      : row.status === "error"
                        ? "Error"
                        : "Unavailable"}
                  </td>
                  <td className="muted">{row.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Usage by provider</h2>
        {data.usageByProvider.length === 0 ? (
          <p className="empty-hint">No provider usage recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Calls</th>
                  <th>Credits</th>
                  <th>Est. cost</th>
                  <th>Confirmed</th>
                  <th>Estimated</th>
                  <th>Pending</th>
                  <th>Failed</th>
                </tr>
              </thead>
              <tbody>
                {data.usageByProvider.map((row) => (
                  <tr key={row.provider}>
                    <td>{providerLabel(row.provider, "admin")}</td>
                    <td>{row.calls}</td>
                    <td>{formatCredits(row.creditsCharged)}</td>
                    <td>
                      {row.estimatedCostUsdMicros === null
                        ? "No price configured"
                        : `$${(row.estimatedCostUsdMicros / 1_000_000).toFixed(4)}`}
                    </td>
                    <td>{row.confirmedCalls}</td>
                    <td>{row.estimatedCalls}</td>
                    <td>{row.pendingCalls}</td>
                    <td>{row.failedCalls}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3>Usage by date</h3>
        {data.usageByDate.length === 0 ? (
          <p className="empty-hint">No usage recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Calls</th>
                  <th>Credits</th>
                </tr>
              </thead>
              <tbody>
                {data.usageByDate.map((row) => (
                  <tr key={row.date}>
                    <td>{row.date}</td>
                    <td>{row.calls}</td>
                    <td>{formatCredits(row.creditsCharged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Pending reconciliation</h2>
        <p className="muted">
          Calls whose billing outcome is unknown (timeouts, aborted requests).
          Credits stay held until you record the outcome.
        </p>
        {data.pendingReconciliation.length === 0 ? (
          <p className="empty-hint">Nothing awaiting reconciliation.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Opened</th>
                  <th>Operation</th>
                  <th>Run</th>
                  <th>Held</th>
                  <th>Note</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.pendingReconciliation.map((res) => (
                  <tr key={res.id}>
                    <td className="admin-nowrap">
                      {formatDateTime(res.createdAt)}
                    </td>
                    <td>{res.operation}</td>
                    <td>{res.runId ?? "—"}</td>
                    <td>{formatCredits(res.amountSubunits)}</td>
                    <td className="muted">{res.note ?? "—"}</td>
                    <td>
                      <div className="admin-table-actions">
                        <button
                          type="button"
                          className="chip-btn"
                          disabled={busyId === res.id}
                          onClick={() =>
                            void resolveReconciliation(res.id, "billed")
                          }
                        >
                          Was billed
                        </button>
                        <button
                          type="button"
                          className="chip-btn"
                          disabled={busyId === res.id}
                          onClick={() =>
                            void resolveReconciliation(res.id, "not_billed")
                          }
                        >
                          Not billed
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
          <p className="empty-hint">No recent provider failures.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Provider</th>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Confidence</th>
                  <th>Credits</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {data.recentFailures.map((call) => (
                  <tr key={call.id}>
                    <td className="admin-nowrap">
                      {formatDateTime(call.startedAt)}
                    </td>
                    <td>{providerLabel(call.provider, "admin")}</td>
                    <td>{call.operation}</td>
                    <td>
                      <span className="status-pill status-failed">
                        {call.status}
                      </span>
                    </td>
                    <td>{confidenceLabel(call.usageConfidence)}</td>
                    <td>{formatCredits(call.creditsCharged)}</td>
                    <td className="muted">{call.errorMessage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Recent admin activity</h2>
        {data.recentAudit.length === 0 ? (
          <p className="empty-hint">No audit entries yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {data.recentAudit.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.seq}</td>
                    <td className="admin-nowrap">
                      {formatDateTime(entry.createdAt)}
                    </td>
                    <td>{entry.actorUsername ?? "system"}</td>
                    <td>{entry.action}</td>
                    <td>
                      {entry.projectId
                        ? `${entry.projectKind}:${entry.projectId}`
                        : (entry.targetUserId ?? "—")}
                    </td>
                    <td className="muted">
                      {entry.details
                        ? Object.entries(entry.details)
                            .map(([k, v]) => `${k}=${v}`)
                            .join(", ")
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
