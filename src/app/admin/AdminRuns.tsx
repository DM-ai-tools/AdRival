"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCredits } from "@/lib/accounting/units";
import { formatDateTime } from "@/lib/credits/display";
import { stageLabel, statusLabel } from "@/lib/progressLabels";
import { Pager, adminFetch, useDebouncedValue } from "./adminUi";

interface RunRow {
  kind: "search" | "lookup";
  id: string;
  title: string;
  platform: string | null;
  status: string;
  stage: string | null;
  ownerUserId: string | null;
  ownerUsername: string | null;
  ownerDisplayName: string | null;
  clientName: string | null;
  archivedAt: string | null;
  results: number;
  creditsCharged: number;
  createdAt: string;
}

interface RecreationRow {
  ownerUserId: string;
  username: string | null;
  displayName: string | null;
  total: number;
  finished: number;
  failed: number;
  stopped: number;
  inProgress: number;
  lastAt: string;
}

const PAGE_SIZE = 50;

/** Landing-page recreations per user, most active first. */
function RecreationCounts({
  q,
  owner,
  onOpenUser,
}: {
  q: string;
  owner: string;
  onOpenUser?: (userId: string) => void;
}) {
  const [rows, setRows] = useState<RecreationRow[]>([]);
  const [days, setDays] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void adminFetch<{ rows: RecreationRow[] }>(`/api/admin/recreations${days ? `?days=${days}` : ""}`)
      .then((d) => live && (setRows(d.rows ?? []), setError(null)))
      .catch((err) => live && setError((err as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [days]);

  const needle = q.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (!owner || r.ownerUserId === owner) &&
      (!needle || `${r.username ?? ""} ${r.displayName ?? ""}`.toLowerCase().includes(needle)),
  );
  const total = shown.reduce((n, r) => n + r.total, 0);

  return (
    <>
      <div className="credits-filter-row">
        <label className="credits-filter">
          <span className="search-label">Period</span>
          <select className="search-input" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="">All time</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </label>
        <span className="muted">
          {total} recreation{total === 1 ? "" : "s"} by {shown.length} user{shown.length === 1 ? "" : "s"}
        </span>
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !rows.length ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="empty-hint">No landing page recreations match.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>User</th>
                <th>Recreations</th>
                <th>Finished</th>
                <th>Failed</th>
                <th>Stopped</th>
                <th>In progress</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.ownerUserId}>
                  <td>
                    {r.username && onOpenUser ? (
                      <button type="button" className="link-btn" onClick={() => onOpenUser(r.ownerUserId)}>
                        @{r.username}
                      </button>
                    ) : r.username ? (
                      `@${r.username}`
                    ) : (
                      <span className="muted">Unknown user</span>
                    )}
                  </td>
                  <td>
                    <strong>{r.total}</strong>
                  </td>
                  <td>{r.finished}</td>
                  <td>{r.failed}</td>
                  <td>{r.stopped}</td>
                  <td>{r.inProgress}</td>
                  <td className="admin-nowrap">{formatDateTime(r.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Every search and lookup across all users, with a link to open each one. */
export default function AdminRuns({ onOpenUser }: { onOpenUser?: (userId: string) => void }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [q, setQ] = useState("");
  const query = useDebouncedValue(q, 300);
  const [owner, setOwner] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void adminFetch<{ users: Array<{ id: string; username: string }> }>("/api/admin/users")
      .then((d) => setUsers((d.users ?? []).map((u) => ({ id: u.id, username: u.username }))))
      .catch(() => undefined);
  }, []);

  const recreations = kind === "recreation";

  useEffect(() => {
    if (recreations) return;
    const mine = ++seq.current;
    const p = new URLSearchParams({ limit: "2000" });
    if (query.trim()) p.set("q", query.trim());
    if (owner) p.set("owner", owner);
    if (kind && !recreations) p.set("kind", kind);
    if (status) p.set("status", status);
    setLoading(true);
    void adminFetch<{ runs: RunRow[]; total: number }>(`/api/admin/runs?${p}`)
      .then((d) => {
        if (mine !== seq.current) return;
        setRuns(d.runs ?? []);
        setTotal(d.total ?? 0);
        setPage(0);
        setError(null);
      })
      .catch((err) => mine === seq.current && setError((err as Error).message))
      .finally(() => mine === seq.current && setLoading(false));
  }, [query, owner, kind, status, recreations]);

  const pageCount = Math.max(1, Math.ceil(runs.length / PAGE_SIZE));
  const pageRows = useMemo(() => runs.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE), [runs, page]);

  return (
    <section className="panel glow-panel admin-panel">
      <div className="progress-head">
        <h2>Runs</h2>
        <span className="muted">{recreations ? "Landing page recreations by user" : `${total} searches and lookups`}</span>
      </div>
      <div className="credits-filter-row">
        <label className="credits-filter">
          <span className="search-label">Search</span>
          <input
            className="search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={recreations ? "Username" : "Keyword or brand"}
          />
        </label>
        <label className="credits-filter">
          <span className="search-label">Owner</span>
          <select className="search-input" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        </label>
        <label className="credits-filter">
          <span className="search-label">Type</span>
          <select className="search-input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Searches and lookups</option>
            <option value="search">Searches</option>
            <option value="lookup">Lookups</option>
            <option value="recreation">Landing page recreations</option>
          </select>
        </label>
        <label className="credits-filter" hidden={recreations}>
          <span className="search-label">Status</span>
          <select className="search-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option>
            <option value="running">Running</option>
            <option value="completed">Finished</option>
            <option value="partial">Partly finished</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      {recreations ? (
        <RecreationCounts q={q} owner={owner} onOpenUser={onOpenUser} />
      ) : null}
      {recreations ? null : error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {recreations ? null : loading && !runs.length ? (
        <p className="muted">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="empty-hint">No runs match these filters.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Results</th>
                  <th>Credits</th>
                  <th>Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pageRows.map((run) => (
                  <tr key={`${run.kind}:${run.id}`}>
                    <td>
                      <strong>{run.title}</strong>
                      <br />
                      <span className="muted">
                        {run.kind === "search" ? "Search" : "Lookup"}
                        {run.platform ? ` · ${run.platform}` : ""}
                        {run.clientName ? ` · ${run.clientName}` : ""}
                        {run.archivedAt ? " · archived" : ""}
                      </span>
                    </td>
                    <td>
                      {run.ownerUserId && run.ownerUsername && onOpenUser ? (
                        <button type="button" className="link-btn" onClick={() => onOpenUser(run.ownerUserId!)}>
                          @{run.ownerUsername}
                        </button>
                      ) : run.ownerUsername ? (
                        `@${run.ownerUsername}`
                      ) : (
                        <span className="muted">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <span className={`status-pill status-${run.status}`}>{statusLabel(run.status)}</span>
                      {run.status === "running" && run.stage ? <span className="muted"> {stageLabel(run.stage)}</span> : null}
                    </td>
                    <td>
                      {run.results} {run.kind === "search" ? "competitors" : "ads"}
                    </td>
                    <td>{formatCredits(run.creditsCharged)}</td>
                    <td className="admin-nowrap">{formatDateTime(run.createdAt)}</td>
                    <td>
                      <Link
                        className="chip-btn"
                        href={
                          run.kind === "lookup"
                            ? `/?mode=lookup&lookup=${encodeURIComponent(run.id)}`
                            : `/?mode=search&run=${encodeURIComponent(run.id)}&tab=preview`
                        }
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={page} pageCount={pageCount} total={runs.length} onPage={setPage} />
        </>
      )}
    </section>
  );
}
