"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCredits, formatUsdMicros } from "@/lib/accounting/units";
import {
  confidenceLabel,
  formatDateTime,
  providerLabel,
  usageSummary,
} from "@/lib/credits/display";
import { PROVIDER_IDS } from "@/lib/types";
import type { CreditReservation, ProviderCallRecord } from "@/lib/types";

interface UsageRow extends ProviderCallRecord {
  chargedUsername: string | null;
  initiatedByUsername: string | null;
}

const PAGE_SIZE = 100;

export default function AdminUsage() {
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [byProvider, setByProvider] = useState<
    Array<{ provider: string; calls: number; creditsCharged: number }>
  >([]);
  const [reservations, setReservations] = useState<CreditReservation[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [runId, setRunId] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [confidence, setConfidence] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [users, setUsers] = useState<
    Array<{ id: string; username: string; displayName: string }>
  >([]);

  useEffect(() => {
    void fetch("/api/admin/users", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => setUsers(json.users ?? []))
      .catch(() => setUsers([]));
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (userId) params.set("userId", userId);
    if (projectId.trim()) params.set("projectId", projectId.trim());
    if (runId.trim()) params.set("runId", runId.trim());
    if (provider) params.set("provider", provider);
    if (status) params.set("status", status);
    if (confidence) params.set("confidence", confidence);
    if (from) params.set("from", new Date(from).toISOString());
    if (to) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      params.set("to", end.toISOString());
    }
    return params;
  }, [userId, projectId, runId, provider, status, confidence, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams(query);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));
      const res = await fetch(`/api/admin/usage?${params}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load usage");
      setRows(json.rows ?? []);
      setByProvider(json.byProvider ?? []);
      setReservations(json.reservations ?? []);
      setTotal(json.total ?? 0);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [query, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep username text and the selected id in sync without an extra request.
  useEffect(() => {
    if (!username.trim()) {
      setUserId("");
      return;
    }
    const match = users.find(
      (u) => u.username === username.trim().toLowerCase(),
    );
    setUserId(match?.id ?? "__none__");
  }, [username, users]);

  function exportCsv() {
    const params = new URLSearchParams(query);
    params.set("format", "csv");
    window.location.href = `/api/admin/usage?${params}`;
  }

  return (
    <>
      <section className="panel glow-panel admin-panel">
        <div className="progress-head">
          <h2>Usage &amp; charges</h2>
          <div className="admin-actions-row">
            <button type="button" className="chip-btn" onClick={() => void load()}>
              Refresh
            </button>
            <button type="button" className="ghost-btn" onClick={exportCsv}>
              Export CSV
            </button>
          </div>
        </div>

        <div className="credits-filter-row">
          <label className="credits-filter">
            <span className="search-label">User</span>
            <select
              className="search-input"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.username}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">Project id</span>
            <input
              className="search-input"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setOffset(0);
              }}
              placeholder="exact project id"
            />
          </label>
          <label className="credits-filter">
            <span className="search-label">Run id</span>
            <input
              className="search-input"
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value);
                setOffset(0);
              }}
              placeholder="exact run id"
            />
          </label>
          <label className="credits-filter">
            <span className="search-label">Provider</span>
            <select
              className="search-input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All providers</option>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id, "admin")}
                </option>
              ))}
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">Status</span>
            <select
              className="search-input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All statuses</option>
              <option value="succeeded">succeeded</option>
              <option value="failed">failed</option>
              <option value="timeout">timeout</option>
              <option value="not_billable">not_billable</option>
              <option value="blocked">blocked</option>
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">Confidence</span>
            <select
              className="search-input"
              value={confidence}
              onChange={(e) => {
                setConfidence(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Any confidence</option>
              <option value="confirmed">confirmed</option>
              <option value="estimated">estimated</option>
              <option value="pending_reconciliation">
                pending_reconciliation
              </option>
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">From</span>
            <input
              type="date"
              className="search-input"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setOffset(0);
              }}
            />
          </label>
          <label className="credits-filter">
            <span className="search-label">To</span>
            <input
              type="date"
              className="search-input"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setOffset(0);
              }}
            />
          </label>
        </div>

        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}

        {byProvider.length > 0 ? (
          <>
            <h3>Filtered totals by provider</h3>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Calls</th>
                    <th>Credits</th>
                  </tr>
                </thead>
                <tbody>
                  {byProvider.map((row) => (
                    <tr key={row.provider}>
                      <td>{providerLabel(row.provider, "admin")}</td>
                      <td>{row.calls}</td>
                      <td>{formatCredits(row.creditsCharged)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {runId.trim() && reservations.length > 0 ? (
          <>
            <h3>Reservations for this run</h3>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Opened</th>
                    <th>Status</th>
                    <th>Still held</th>
                    <th>Settled</th>
                    <th>Expires</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {reservations.map((res) => (
                    <tr key={res.id}>
                      <td className="admin-nowrap">
                        {formatDateTime(res.createdAt)}
                      </td>
                      <td>{res.status}</td>
                      <td>{formatCredits(res.amountSubunits)}</td>
                      <td>{formatCredits(res.settledSubunits)}</td>
                      <td className="admin-nowrap">
                        {formatDateTime(res.expiresAt)}
                      </td>
                      <td className="muted">{res.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        <h3>Provider calls</h3>
        {loading ? (
          <p className="muted">Loading usage…</p>
        ) : rows.length === 0 ? (
          <p className="empty-hint">No provider calls match these filters.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Charged</th>
                    <th>Initiated by</th>
                    <th>Provider</th>
                    <th>Model / endpoint</th>
                    <th>Operation</th>
                    <th>Project</th>
                    <th>Run</th>
                    <th>Request id</th>
                    <th>Usage</th>
                    <th>Credits</th>
                    <th>Est. cost</th>
                    <th>Rules v</th>
                    <th>Confidence</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((call) => (
                    <tr key={call.id}>
                      <td className="admin-nowrap">
                        {formatDateTime(call.startedAt)}
                      </td>
                      <td>{call.chargedUsername ?? call.chargedUserId}</td>
                      <td>
                        {call.initiatedByUsername ?? call.initiatedByUserId}
                      </td>
                      <td>{providerLabel(call.provider, "admin")}</td>
                      <td>{call.model ?? call.endpoint ?? "—"}</td>
                      <td>{call.operation}</td>
                      <td>
                        {call.projectId
                          ? `${call.projectKind}:${call.projectId}`
                          : "—"}
                      </td>
                      <td>{call.runId ?? "—"}</td>
                      <td>{call.providerRequestId ?? "—"}</td>
                      <td>{usageSummary(call.usage)}</td>
                      <td>{formatCredits(call.creditsCharged)}</td>
                      <td>
                        {call.estimatedCostUsdMicros === null
                          ? "No price configured"
                          : formatUsdMicros(call.estimatedCostUsdMicros)}
                      </td>
                      <td>{call.conversionRuleVersion}</td>
                      <td>
                        <span
                          className={
                            call.usageConfidence === "pending_reconciliation"
                              ? "status-pill status-partial"
                              : "status-pill"
                          }
                        >
                          {confidenceLabel(call.usageConfidence)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            call.status === "succeeded"
                              ? "status-pill status-completed"
                              : call.status === "not_billable"
                                ? "status-pill"
                                : "status-pill status-failed"
                          }
                          title={call.errorMessage ?? undefined}
                        >
                          {call.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="credits-pager">
              <span className="muted">
                Showing {offset + 1}–{Math.min(offset + rows.length, total)} of{" "}
                {total}
              </span>
              <div className="admin-actions-row">
                <button
                  type="button"
                  className="chip-btn"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="chip-btn"
                  disabled={offset + rows.length >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
