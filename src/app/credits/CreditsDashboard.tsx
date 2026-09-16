"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditSummaryPanel } from "@/components/CreditSummaryPanel";
import { formatCredits } from "@/lib/accounting/units";
import {
  confidenceLabel,
  formatDateTime,
  providerLabel,
  usageSummary,
} from "@/lib/credits/display";
import { useCredits } from "@/lib/credits/useCredits";
import { PROVIDER_IDS } from "@/lib/types";

interface UsageRow {
  id: string;
  startedAt: string;
  completedAt: string;
  provider: string;
  model: string | null;
  endpoint: string | null;
  operation: string;
  projectKind: string | null;
  projectId: string | null;
  projectTitle: string | null;
  runId: string | null;
  usage: {
    requests?: number;
    inputTokens?: number;
    outputTokens?: number;
    images?: number;
  };
  usageConfidence: string;
  creditsCharged: number;
  status: string;
  errorMessage: string | null;
}

interface ProjectOption {
  kind: string;
  id: string;
  title: string;
  accessRole: string;
}

const STATUS_OPTIONS = [
  "succeeded",
  "failed",
  "timeout",
  "not_billable",
  "blocked",
];

const PAGE_SIZE = 50;

export default function CreditsDashboard() {
  const credits = useCredits(20_000);

  const [rows, setRows] = useState<UsageRow[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState<string | null>(null);

  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (provider) params.set("provider", provider);
    if (status) params.set("status", status);
    if (projectId) params.set("projectId", projectId);
    if (from) params.set("from", new Date(from).toISOString());
    if (to) {
      // Inclusive end-of-day so a single-day filter returns that day's calls.
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      params.set("to", end.toISOString());
    }
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", String(offset));
    return params.toString();
  }, [provider, status, projectId, from, to, offset]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      const res = await fetch(`/api/credits/usage?${query}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load usage");
      setRows(json.rows ?? []);
      setProjects(json.projects ?? []);
      setTotal(json.total ?? 0);
      setUsageError(null);
    } catch (err) {
      setUsageError((err as Error).message);
    } finally {
      setUsageLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  function resetFilters() {
    setProvider("");
    setStatus("");
    setProjectId("");
    setFrom("");
    setTo("");
    setOffset(0);
  }

  const hasFilters = Boolean(provider || status || projectId || from || to);

  return (
    <main className="page product-shell credits-page">
      <div className="atmosphere" aria-hidden />

      <header className="product-header account-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Credits &amp; usage</h1>
          <p className="lede">
            Your allowance, active reservations, and every task that consumed
            credits.
          </p>
        </div>
        <div className="header-link-row">
          <Link href="/account" className="ghost-btn">
            Account
          </Link>
          <Link href="/" className="ghost-btn">
            Back to app
          </Link>
        </div>
      </header>

      <CreditSummaryPanel
        data={credits.data}
        loading={credits.loading}
        error={credits.error}
      />

      <section className="panel glow-panel credits-panel">
        <h2>Recent runs</h2>
        {credits.data && credits.data.recentRuns.length === 0 ? (
          <p className="empty-hint">
            No runs have used credits yet. Start a search or lookup to see usage
            here.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Task</th>
                  <th>Calls</th>
                  <th>Credits used</th>
                  <th>Status</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {(credits.data?.recentRuns ?? []).map((run) => (
                  <tr key={run.runId}>
                    <td>{run.projectTitle || run.projectId || "—"}</td>
                    <td>{run.operation}</td>
                    <td>{run.calls}</td>
                    <td>{formatCredits(run.creditsCharged)}</td>
                    <td>
                      {run.pendingCalls > 0 ? (
                        <span className="status-pill status-partial">
                          {run.pendingCalls} pending
                        </span>
                      ) : run.failedCalls > 0 ? (
                        <span className="status-pill status-failed">
                          {run.failedCalls} failed
                        </span>
                      ) : (
                        <span className="status-pill status-completed">
                          Settled
                        </span>
                      )}
                    </td>
                    <td>{formatDateTime(run.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel glow-panel credits-panel">
        <div className="progress-head">
          <h2>Usage history</h2>
          {hasFilters ? (
            <button type="button" className="chip-btn" onClick={resetFilters}>
              Clear filters
            </button>
          ) : null}
        </div>

        <div className="credits-filter-row">
          <label className="credits-filter">
            <span className="search-label">Service</span>
            <select
              className="search-input"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All services</option>
              {PROVIDER_IDS.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id)}
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
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>

          <label className="credits-filter">
            <span className="search-label">Project</span>
            <select
              className="search-input"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={`${p.kind}:${p.id}`} value={p.id}>
                  {p.title}
                  {p.accessRole !== "owner" ? ` (${p.accessRole})` : ""}
                </option>
              ))}
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

        {usageError ? (
          <p className="error-text" role="alert">
            {usageError}
          </p>
        ) : null}

        {usageLoading ? (
          <p className="muted">Loading usage…</p>
        ) : rows.length === 0 ? (
          <p className="empty-hint">
            {hasFilters
              ? "No usage matches these filters."
              : "No usage recorded yet."}
          </p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Service</th>
                    <th>Task</th>
                    <th>Project</th>
                    <th>Usage</th>
                    <th>Credits</th>
                    <th>Confidence</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatDateTime(row.startedAt)}</td>
                      <td>{providerLabel(row.provider)}</td>
                      <td>{row.operation}</td>
                      <td>{row.projectTitle || row.projectId || "—"}</td>
                      <td>{usageSummary(row.usage)}</td>
                      <td>{formatCredits(row.creditsCharged)}</td>
                      <td>
                        <span
                          className={
                            row.usageConfidence === "pending_reconciliation"
                              ? "status-pill status-partial"
                              : "status-pill"
                          }
                        >
                          {confidenceLabel(row.usageConfidence)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            row.status === "succeeded"
                              ? "status-pill status-completed"
                              : row.status === "not_billable"
                                ? "status-pill"
                                : "status-pill status-failed"
                          }
                          title={row.errorMessage || undefined}
                        >
                          {row.status.replace(/_/g, " ")}
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
              <div className="header-link-row">
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
    </main>
  );
}
