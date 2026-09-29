"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/lib/credits/display";
import { adminFetch } from "./adminUi";

interface Entry {
  id: string;
  createdAt: string;
  action: string;
  actionLabel: string;
  actor: string;
  actorUserId: string | null;
  target: string | null;
  targetUserId: string | null;
  project: string | null;
  projectKind: string | null;
  projectId: string | null;
  space: string | null;
  details: string;
}

const AREAS: Array<{ value: string; label: string }> = [
  { value: "", label: "Everything" },
  { value: "admin.credits", label: "Credits" },
  { value: "admin.user", label: "Accounts" },
  { value: "admin.space", label: "Client spaces" },
  { value: "admin.settings", label: "Settings" },
  { value: "admin.conversion_rules", label: "Conversion rules" },
  { value: "admin.usage", label: "Billing checks" },
  { value: "auth", label: "Sign-ins and passwords" },
];

function runHref(kind: string | null, id: string | null): string | null {
  if (!kind || !id) return null;
  return kind === "lookup"
    ? `/?mode=lookup&lookup=${encodeURIComponent(id)}`
    : `/?mode=search&run=${encodeURIComponent(id)}&tab=preview`;
}

/** Who did what, when: filterable, newest first, exportable as CSV. */
export default function AdminAudit({ onOpenUser }: { onOpenUser?: (userId: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; username: string }>>([]);
  const [actor, setActor] = useState("");
  const [target, setTarget] = useState("");
  const [area, setArea] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [routine, setRoutine] = useState(false);
  const [limit, setLimit] = useState(200);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    void adminFetch<{ users: Array<{ id: string; username: string }> }>("/api/admin/users")
      .then((d) => setUsers((d.users ?? []).map((u) => ({ id: u.id, username: u.username }))))
      .catch(() => undefined);
  }, []);

  const params = useCallback(() => {
    const p = new URLSearchParams();
    if (actor) p.set("actor", actor);
    if (target) p.set("target", target);
    if (area) p.set("area", area);
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (routine) p.set("routine", "1");
    p.set("limit", String(limit));
    return p;
  }, [actor, target, area, from, to, routine, limit]);

  useEffect(() => {
    const mine = ++seq.current;
    setLoading(true);
    void adminFetch<{ entries: Entry[] }>(`/api/admin/audit?${params()}`)
      .then((d) => {
        if (mine !== seq.current) return;
        setEntries(d.entries ?? []);
        setError(null);
      })
      .catch((err) => mine === seq.current && setError((err as Error).message))
      .finally(() => mine === seq.current && setLoading(false));
  }, [params]);

  return (
    <section className="panel glow-panel admin-panel">
      <div className="progress-head">
        <h2>Audit log</h2>
        <a className="chip-btn" href={`/api/admin/audit?${(() => { const p = params(); p.set("format", "csv"); p.set("limit", "2000"); return p; })()}`}>
          Export CSV
        </a>
      </div>
      <p className="muted">Every change made by admins and every sign-in, newest first.</p>

      <div className="credits-filter-row">
        <label className="credits-filter">
          <span className="search-label">Area</span>
          <select className="search-input" value={area} onChange={(e) => setArea(e.target.value)}>
            {AREAS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="credits-filter">
          <span className="search-label">Done by</span>
          <select className="search-input" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        </label>
        <label className="credits-filter">
          <span className="search-label">User affected</span>
          <select className="search-input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Anyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                @{u.username}
              </option>
            ))}
          </select>
        </label>
        <label className="credits-filter">
          <span className="search-label">From</span>
          <input className="search-input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="credits-filter">
          <span className="search-label">To</span>
          <input className="search-input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="credits-filter admin-check-filter">
          <input type="checkbox" checked={routine} onChange={(e) => setRoutine(e.target.checked)} /> Include sign-ins and run views
        </label>
      </div>

      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {loading && !entries.length ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty-hint">Nothing matches these filters.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>User affected</th>
                  <th>Run or space</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => {
                  const href = runHref(e.projectKind, e.projectId);
                  return (
                    <tr key={e.id}>
                      <td className="admin-nowrap">{formatDateTime(e.createdAt)}</td>
                      <td>@{e.actor}</td>
                      <td>{e.actionLabel}</td>
                      <td>
                        {e.target && e.targetUserId && onOpenUser ? (
                          <button type="button" className="link-btn" onClick={() => onOpenUser(e.targetUserId!)}>
                            @{e.target}
                          </button>
                        ) : e.target ? (
                          `@${e.target}`
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {e.project && href ? <Link href={href}>{e.project}</Link> : e.space || e.project || "—"}
                      </td>
                      <td className="muted">{e.details || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {entries.length >= limit ? (
            <button type="button" className="chip-btn" onClick={() => setLimit((n) => Math.min(n + 400, 2000))}>
              Show more
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
