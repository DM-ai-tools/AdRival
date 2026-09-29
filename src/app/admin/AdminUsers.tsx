"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatCredits } from "@/lib/accounting/units";
import { formatDateTime } from "@/lib/credits/display";
import type { CreditSummary } from "@/lib/accounting/service";
import type { AppUserPublic } from "@/lib/types";
import AdminUserDrawer from "./AdminUserDrawer";
import {
  CopyValue,
  InlineNotice,
  Pager,
  SortHeader,
  adminFetch,
  useDebouncedValue,
  type Notice,
} from "./adminUi";

export interface AdminUserRow extends AppUserPublic {
  maxConcurrentRuns: number | null;
  suspendedAt: string | null;
  deletedAt: string | null;
  credits: CreditSummary;
  projectCount: number;
  spaceCount: number;
  lastLoginAt: string | null;
  loginLocked: boolean;
}

type SortKey = "name" | "credits" | "lastLogin" | "created" | "runs";
const PAGE_SIZE = 25;

function statusClass(status: string): string {
  if (status === "active") return "status-pill status-completed";
  if (status === "suspended") return "status-pill status-partial";
  return "status-pill status-failed";
}

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  suspended: "Suspended",
  deleted: "Deleted",
};

export default function AdminUsers({ initialUserId }: { initialUserId?: string | null }) {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 300);
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [drawerId, setDrawerId] = useState<string | null>(initialUserId ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    void adminFetch<{ user?: { id: string } }>("/api/auth/me")
      .then((d) => setMeId(d.user?.id ?? null))
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    // Only the newest request may update the list (typing fast sends several).
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (roleFilter) params.set("role", roleFilter);
      if (statusFilter) params.set("status", statusFilter);
      const json = await adminFetch<{ users: AdminUserRow[] }>(`/api/admin/users?${params}`);
      if (seq !== requestSeq.current) return;
      setRows(json.users ?? []);
      setError(null);
    } catch (err) {
      if (seq === requestSeq.current) setError((err as Error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [debouncedSearch, roleFilter, statusFilter]);

  useEffect(() => {
    void load();
    setPage(0);
  }, [load]);

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const value = (u: AdminUserRow): string | number => {
      switch (sort.key) {
        case "credits":
          return u.role === "admin" ? Number.MAX_SAFE_INTEGER : u.credits.availableSubunits;
        case "lastLogin":
          return u.lastLoginAt ?? "";
        case "created":
          return u.createdAt;
        case "runs":
          return u.projectCount;
        default:
          return u.displayName.toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [rows, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const selectable = pageRows.filter((u) => u.status !== "deleted");
  const allOnPage = selectable.length > 0 && selectable.every((u) => selected.has(u.id));

  function onSort(key: SortKey) {
    setSort((prev) => ({ key, dir: prev.key === key && prev.dir === "asc" ? "desc" : "asc" }));
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const drawerRow = rows.find((r) => r.id === drawerId) ?? null;

  return (
    <>
      <section className="panel glow-panel admin-panel">
        <div className="progress-head">
          <h2>Users</h2>
          <div className="admin-manage-actions">
            {selected.size ? (
              <button type="button" className="chip-btn" onClick={() => setBulkOpen(true)}>
                Add credits to {selected.size} selected
              </button>
            ) : null}
            <button type="button" className="chip-btn" onClick={() => void load()}>
              Refresh
            </button>
            <button type="button" className="search-btn" onClick={() => setCreateOpen(true)}>
              New user
            </button>
          </div>
        </div>

        <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

        <div className="credits-filter-row">
          <label className="credits-filter">
            <span className="search-label">Search</span>
            <input
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Username or name"
            />
          </label>
          <label className="credits-filter">
            <span className="search-label">Role</span>
            <select className="search-input" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
              <option value="">All roles</option>
              <option value="admin">Admin</option>
              <option value="user">User</option>
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">Status</span>
            <select className="search-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
        </div>

        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}

        {loading && !rows.length ? (
          <p className="muted">Loading users…</p>
        ) : rows.length === 0 ? (
          <p className="empty-hint">No accounts match these filters.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="comp-table admin-users-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="Select everyone on this page"
                        checked={allOnPage}
                        onChange={() =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            for (const u of selectable) {
                              if (allOnPage) next.delete(u.id);
                              else next.add(u.id);
                            }
                            return next;
                          })
                        }
                      />
                    </th>
                    <SortHeader label="User" column="name" sort={sort} onSort={onSort} />
                    <th>Role</th>
                    <th>Status</th>
                    <SortHeader label="Credits left" column="credits" sort={sort} onSort={onSort} />
                    <SortHeader label="Last sign-in" column="lastLogin" sort={sort} onSort={onSort} />
                    <SortHeader label="Runs" column="runs" sort={sort} onSort={onSort} />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((user) => (
                    <tr key={user.id} className={drawerId === user.id ? "is-selected" : undefined}>
                      <td>
                        {user.status !== "deleted" ? (
                          <input
                            type="checkbox"
                            aria-label={`Select ${user.username}`}
                            checked={selected.has(user.id)}
                            onChange={() => toggle(user.id)}
                          />
                        ) : null}
                      </td>
                      <td>
                        <strong>{user.displayName}</strong>
                        <br />
                        <span className="muted">@{user.username}</span>
                        {user.loginLocked ? <span className="admin-flag"> Locked out</span> : null}
                        {user.mustChangePassword ? <span className="admin-flag is-quiet"> Must change password</span> : null}
                      </td>
                      <td>
                        <span className={user.role === "admin" ? "admin-role-pill is-admin" : "admin-role-pill"}>
                          {user.role === "admin" ? "Admin" : "User"}
                        </span>
                      </td>
                      <td>
                        <span className={statusClass(user.status)}>{STATUS_TEXT[user.status] ?? user.status}</span>
                      </td>
                      <td>
                        {user.role === "admin" ? (
                          <span className="admin-credit-summary">
                            <strong>Unlimited</strong>
                            <span className="muted">{formatCredits(user.credits.consumedSubunits)} used</span>
                          </span>
                        ) : (
                          <span className="admin-credit-summary">
                            <strong className={user.credits.lowCredit ? "credits-low" : undefined}>
                              {formatCredits(user.credits.availableSubunits)}
                            </strong>
                            <span className="muted">of {formatCredits(user.credits.allowanceSubunits)}</span>
                          </span>
                        )}
                      </td>
                      <td className="admin-nowrap">{user.lastLoginAt ? formatDateTime(user.lastLoginAt) : <span className="muted">Never</span>}</td>
                      <td>
                        {user.projectCount}
                        {user.spaceCount ? <span className="muted"> · {user.spaceCount} spaces</span> : null}
                      </td>
                      <td>
                        <button type="button" className="chip-btn" onClick={() => setDrawerId(user.id)}>
                          Open
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageCount={pageCount} total={sorted.length} onPage={setPage} />
          </>
        )}
      </section>

      {drawerId ? (
        <AdminUserDrawer
          key={drawerId}
          userId={drawerId}
          row={drawerRow}
          meId={meId}
          onClose={() => setDrawerId(null)}
          onChanged={() => void load()}
          onDeleted={(text) => {
            setDrawerId(null);
            setNotice({ tone: "ok", text });
            void load();
          }}
        />
      ) : null}

      {createOpen ? (
        <CreateUserDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => void load()}
        />
      ) : null}

      {bulkOpen ? (
        <BulkCreditsDialog
          users={rows.filter((u) => selected.has(u.id))}
          onClose={() => setBulkOpen(false)}
          onDone={(text) => {
            setBulkOpen(false);
            setSelected(new Set());
            setNotice({ tone: "ok", text });
            void load();
          }}
        />
      ) : null}
    </>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="confirm-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="confirm-dialog admin-modal" role="dialog" aria-modal="true" aria-label={title}>
        <h3 className="confirm-title">{title}</h3>
        {children}
      </div>
    </div>
  );
}

function CreateUserDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("user");
  const [allowance, setAllowance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string; notice?: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const json = await adminFetch<{ user: { username: string }; temporaryPassword: string; notice?: string }>(
        "/api/admin/users",
        { method: "POST", json: { username, displayName, role, allowanceCredits: allowance } },
      );
      setCreated({ username: json.user.username, password: json.temporaryPassword, notice: json.notice });
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={created ? "User created" : "New user"} onClose={onClose}>
      {created ? (
        <>
          <p className="confirm-desc">
            @{created.username} can sign in with this temporary password and must choose a new one straight away.
          </p>
          <CopyValue
            label="Temporary password"
            value={created.password}
            hint="It is shown only once. Send it to the user through a private channel."
          />
          {created.notice ? <p className="form-hint">{created.notice}</p> : null}
          <div className="confirm-actions">
            <button type="button" className="chip-btn confirm-primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <div className="admin-form-grid">
            <label className="admin-field">
              <span className="search-label">Username</span>
              <input className="search-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="jane_doe" autoComplete="off" required disabled={busy} autoFocus />
            </label>
            <label className="admin-field">
              <span className="search-label">Display name</span>
              <input className="search-input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Doe" required disabled={busy} />
            </label>
            <label className="admin-field">
              <span className="search-label">Role</span>
              <select className="search-input" value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
                <option value="user">User</option>
                <option value="admin">Admin (unlimited credits, full access)</option>
              </select>
            </label>
            <label className="admin-field">
              <span className="search-label">Starting credits</span>
              <input className="search-input" value={allowance} onChange={(e) => setAllowance(e.target.value)} placeholder="Default from settings" inputMode="decimal" disabled={busy} />
            </label>
          </div>
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <div className="confirm-actions">
            <button type="button" className="chip-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="chip-btn confirm-primary" disabled={busy}>
              {busy ? "Creating…" : "Create user"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function BulkCreditsDialog({
  users,
  onClose,
  onDone,
}: {
  users: AdminUserRow[];
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const [credits, setCredits] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const json = await adminFetch<{ updated: unknown[]; skipped: unknown[] }>("/api/admin/credits/bulk", {
        method: "POST",
        json: { userIds: users.map((u) => u.id), credits, reason },
      });
      onDone(
        `Added ${credits} credits to ${json.updated.length} user${json.updated.length === 1 ? "" : "s"}` +
          (json.skipped.length ? ` (${json.skipped.length} skipped)` : "") +
          ".",
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Add credits to ${users.length} user${users.length === 1 ? "" : "s"}`} onClose={onClose}>
      <p className="confirm-desc">
        {users.slice(0, 6).map((u) => `@${u.username}`).join(", ")}
        {users.length > 6 ? ` and ${users.length - 6} more` : ""}. Each gets the same amount added to their current allowance.
      </p>
      <form onSubmit={(e) => void submit(e)}>
        <div className="admin-form-grid">
          <label className="admin-field">
            <span className="search-label">Credits to add</span>
            <input className="search-input" value={credits} onChange={(e) => setCredits(e.target.value)} inputMode="decimal" placeholder="25" required disabled={busy} autoFocus />
          </label>
          <label className="admin-field">
            <span className="search-label">Reason</span>
            <input className="search-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Monthly top-up" required disabled={busy} />
          </label>
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="chip-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="chip-btn confirm-primary" disabled={busy}>
            {busy ? "Adding…" : "Add credits"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
