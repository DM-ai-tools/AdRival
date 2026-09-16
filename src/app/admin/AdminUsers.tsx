"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CREDIT_SCALE, formatCredits } from "@/lib/accounting/units";
import { formatDate, formatDateTime, providerLabel } from "@/lib/credits/display";
import { CreditAllotmentGuide } from "@/components/CreditAllotmentGuide";
import type { CreditSummary } from "@/lib/accounting/service";
import type { AppUserPublic, CreditPeriod, ProviderCallRecord } from "@/lib/types";

interface AdminUserRow extends AppUserPublic {
  maxConcurrentRuns: number | null;
  suspendedAt: string | null;
  deletedAt: string | null;
  credits: CreditSummary;
  projectCount: number;
}

interface UserDetail {
  user: AppUserPublic;
  limits: {
    maxConcurrentRuns: number | null;
    allowedProviders: string[] | null;
    blockedModels: string[] | null;
  };
  credits: CreditSummary;
  periods: CreditPeriod[];
  usageByProvider: Array<{
    provider: string;
    calls: number;
    creditsCharged: number;
  }>;
  recentRuns: Array<{
    runId: string;
    projectKind: string | null;
    projectId: string | null;
    operation: string;
    calls: number;
    creditsCharged: number;
    completedAt: string;
  }>;
  recentCalls: ProviderCallRecord[];
  projects: Array<{
    kind: string;
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
  }>;
  sharedWithThisUser: Array<{
    projectKind: string;
    projectId: string;
    role: string;
  }>;
}

const ADJUST_LIMIT = 200;

interface CreditChangeNotice {
  userId: string;
  tone: "ok" | "error";
  message: string;
  stamp: number;
  credits?: CreditSummary;
}

function signedCredits(subunits: number): string {
  const text = formatCredits(Math.abs(subunits));
  if (subunits > 0) return `+${text}`;
  if (subunits < 0) return `−${text}`;
  return "0";
}

function describeCreditChange(
  action: "set_allowance" | "add_credits" | "adjustment" | "set_reset_cadence",
  before: CreditSummary | undefined,
  after: CreditSummary | undefined,
): string {
  if (action === "set_reset_cadence") {
    return after?.resetCadence === "monthly"
      ? "Reset schedule saved: unused allowance expires monthly."
      : "Reset schedule saved: manual allocation, no automatic reset.";
  }
  if (!after) return "Credit change saved.";
  const left = `${formatCredits(before?.availableSubunits ?? 0)} → ${formatCredits(after.availableSubunits)}`;
  const cap = formatCredits(after.allowanceSubunits);
  if (action === "adjustment") {
    const delta =
      after.availableSubunits - (before?.availableSubunits ?? after.availableSubunits);
    return `Usage adjusted by ${signedCredits(delta)}. Remaining is now ${formatCredits(after.availableSubunits)} (was ${formatCredits(before?.availableSubunits ?? 0)}). Allowance stays ${cap}.`;
  }
  if (action === "add_credits") {
    return `Added credits. Remaining ${left}. Allowance is now ${cap}.`;
  }
  return `Allowance set to ${cap}. Remaining ${left}.`;
}

function UserManagePanel({
  user,
  busy,
  amount,
  reason,
  cadence,
  notice,
  onAmount,
  onReason,
  onCadence,
  onCredit,
  onPatch,
  onResetPassword,
  onDelete,
  onDetails,
}: {
  user: AdminUserRow | null;
  busy: boolean;
  amount: string;
  reason: string;
  cadence: string;
  notice: CreditChangeNotice | null;
  onAmount: (value: string) => void;
  onReason: (value: string) => void;
  onCadence: (value: string) => void;
  onCredit: (
    action: "set_allowance" | "add_credits" | "adjustment" | "set_reset_cadence",
    override?: { credits?: string },
  ) => void;
  onPatch: (body: Record<string, unknown>) => void;
  onResetPassword: () => void;
  onDelete: () => void;
  onDetails: () => void;
}) {
  const [adjustment, setAdjustment] = useState(0);

  useEffect(() => {
    if (notice?.tone === "ok" && notice.message.startsWith("Usage adjusted")) {
      setAdjustment(0);
    }
  }, [notice]);

  if (!user) return null;
  const deleted = user.status === "deleted";
  const panelNotice = notice?.userId === user.id ? notice : null;
  const shown =
    panelNotice?.tone === "ok" && panelNotice.credits
      ? panelNotice.credits
      : user.credits;
  const remaining = shown.availableSubunits;
  const previewRemaining = remaining + adjustment * CREDIT_SCALE;

  return (
    <section className="panel glow-panel admin-panel admin-manage">
      <div className="progress-head">
        <h2>
          {user.displayName} <span className="muted">@{user.username}</span>
        </h2>
        <button type="button" className="chip-btn" onClick={onDetails}>
          Activity
        </button>
      </div>

      {deleted ? (
        <p className="empty-hint">This account is deleted. Access is already revoked.</p>
      ) : (
        <div className="admin-manage-grid">
          <div>
            <h3>Credits</h3>
            <CreditAllotmentGuide />
            <p
              className={`credit-live ${panelNotice?.tone === "ok" ? "credit-flash" : ""}`}
              key={panelNotice?.stamp ?? "balance"}
            >
              <strong>{formatCredits(remaining)} left</strong>
              <span className="muted">
                {formatCredits(shown.allowanceSubunits)} allowance
                {" · "}
                {shown.consumedSubunits < 0
                  ? `${formatCredits(Math.abs(shown.consumedSubunits))} refunded`
                  : `${formatCredits(shown.consumedSubunits)} used`}
                {user.role === "admin" ? " · not limited" : ""}
              </span>
            </p>
            {panelNotice ? (
              <p
                className={
                  panelNotice.tone === "ok"
                    ? "credit-change-banner"
                    : "credit-change-banner is-error"
                }
                role={panelNotice.tone === "ok" ? "status" : "alert"}
              >
                {panelNotice.message}
              </p>
            ) : null}
            <p className="form-hint">
              Set allowance and Add credits use the amount box. Adjust usage uses
              the slider only — it changes remaining credits, not the allowance.
            </p>
            <label className="admin-field">
              <span className="search-label">Amount for set or add</span>
              <input
                className="search-input"
                value={amount}
                onChange={(e) => onAmount(e.target.value)}
                inputMode="decimal"
                placeholder="25"
                disabled={busy}
              />
            </label>
            <label className="admin-field">
              <span className="search-label">Reason</span>
              <input
                className="search-input"
                value={reason}
                onChange={(e) => onReason(e.target.value)}
                placeholder="Recorded in the ledger"
                disabled={busy}
              />
            </label>
            <div className="admin-manage-actions">
              <button
                type="button"
                className="chip-btn"
                disabled={busy}
                onClick={() => onCredit("set_allowance")}
              >
                Set allowance
              </button>
              <button
                type="button"
                className="chip-btn"
                disabled={busy}
                onClick={() => onCredit("add_credits")}
              >
                Add credits
              </button>
            </div>

            <div className="credit-adjust">
              <div className="credit-adjust-head">
                <span className="search-label">Adjust usage</span>
                <strong
                  className={
                    adjustment < 0
                      ? "is-negative"
                      : adjustment > 0
                        ? "is-positive"
                        : undefined
                  }
                >
                  {adjustment > 0 ? `+${adjustment}` : adjustment} credits
                </strong>
              </div>
              <div className="credit-slider-scale">
                <span>Remove</span>
                <span>Refund</span>
              </div>
              <input
                className="credit-slider"
                type="range"
                min={-ADJUST_LIMIT}
                max={ADJUST_LIMIT}
                step={1}
                value={adjustment}
                disabled={busy}
                aria-label="Adjust usage by credits"
                onChange={(e) => setAdjustment(Number(e.target.value))}
              />
              <p className="form-hint">
                {adjustment === 0
                  ? "Slide left to remove credits, right to give them back."
                  : adjustment < 0
                    ? `Remaining will go from ${formatCredits(remaining)} to ${formatCredits(previewRemaining)}. Allowance stays ${formatCredits(shown.allowanceSubunits)}.`
                    : `Remaining will go from ${formatCredits(remaining)} to ${formatCredits(previewRemaining)}. Allowance stays ${formatCredits(shown.allowanceSubunits)}.`}
              </p>
              <button
                type="button"
                className="search-btn"
                disabled={busy || adjustment === 0}
                onClick={() =>
                  onCredit("adjustment", { credits: String(adjustment) })
                }
              >
                {busy ? "Saving…" : "Apply adjustment"}
              </button>
            </div>
            <label className="admin-field">
              <span className="search-label">Reset schedule</span>
              <select
                className="search-input"
                value={cadence}
                onChange={(e) => onCadence(e.target.value)}
                disabled={busy}
              >
                <option value="none">Manual allocation</option>
                <option value="monthly">Monthly reset</option>
              </select>
            </label>
            <button
              type="button"
              className="chip-btn"
              disabled={busy}
              onClick={() => onCredit("set_reset_cadence")}
            >
              Save schedule
            </button>
          </div>

          <div>
            <h3>Account</h3>
            <div className="admin-manage-actions">
              <button
                type="button"
                className="chip-btn"
                disabled={busy}
                onClick={() =>
                  onPatch({
                    status: user.status === "active" ? "suspended" : "active",
                  })
                }
              >
                {user.status === "active" ? "Suspend" : "Reactivate"}
              </button>
              <button
                type="button"
                className="chip-btn"
                disabled={busy}
                onClick={() =>
                  onPatch({ role: user.role === "admin" ? "user" : "admin" })
                }
              >
                {user.role === "admin" ? "Demote to user" : "Promote to admin"}
              </button>
              <button
                type="button"
                className="chip-btn"
                disabled={busy}
                onClick={onResetPassword}
              >
                Reset password
              </button>
              <button
                type="button"
                className="danger-btn"
                disabled={busy}
                onClick={onDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default function AdminUsers() {
  const [rows, setRows] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("user");
  const [newAllowance, setNewAllowance] = useState("");
  const [creating, setCreating] = useState(false);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [manageId, setManageId] = useState<string | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [resetCadence, setResetCadence] = useState("none");
  const [creditNotice, setCreditNotice] = useState<CreditChangeNotice | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (roleFilter) params.set("role", roleFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/admin/users?${params}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load users");
      setRows(json.users ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, roleFilter, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDetail = useCallback(async (userId: string) => {
    setDetailId(userId);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load user");
      setDetail(json as UserDetail);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSecret(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: newUsername,
          displayName: newDisplayName,
          role: newRole,
          allowanceCredits: newAllowance,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to create user");
      setSecret(
        `Temporary password for @${json.user.username}: ${json.temporaryPassword}`,
      );
      setNotice(json.notice ?? null);
      setNewUsername("");
      setNewDisplayName("");
      setNewAllowance("");
      setNewRole("user");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function patchUser(userId: string, body: Record<string, unknown>) {
    setBusyId(userId);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Update failed");
      await load();
      if (detailId === userId) await loadDetail(userId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(user: AdminUserRow) {
    if (
      !window.confirm(
        `Reset the password for @${user.username}? Their current sessions will be signed out immediately.`,
      )
    ) {
      return;
    }
    setBusyId(user.id);
    setError(null);
    setSecret(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Password reset failed");
      setSecret(
        `Temporary password for @${user.username}: ${json.temporaryPassword}`,
      );
      setNotice(json.notice ?? null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  async function creditAction(
    userId: string,
    action: "set_allowance" | "add_credits" | "adjustment" | "set_reset_cadence",
    preset?: { credits?: string; reason: string; cadence?: string },
  ) {
    let payload: Record<string, unknown> = { action };

    if (action === "set_reset_cadence") {
      const cadence =
        preset?.cadence ??
        window.prompt(
          "Reset cadence — type 'monthly' for monthly resets or 'none' for manual allocation:",
          "none",
        );
      if (cadence === null) return;
      payload.cadence = String(cadence).trim() === "monthly" ? "monthly" : "none";
    } else {
      const credits =
        preset?.credits ??
        window.prompt(
          action === "set_allowance"
            ? "New allowance for the current period (credits):"
            : action === "add_credits"
              ? "Credits to add to the current allowance:"
              : "Adjustment in credits (positive refunds the user, negative bills them):",
        );
      if (credits === null) return;
      payload.credits = String(credits).trim();
    }

    const reason =
      preset?.reason ??
      window.prompt("Reason (recorded in the ledger and audit log):");
    if (reason === null || !String(reason).trim()) {
      setCreditNotice({
        userId,
        tone: "error",
        message: "A reason is required for every credit change.",
        stamp: Date.now(),
      });
      return;
    }
    payload = { ...payload, reason: String(reason).trim() };

    const before = rows.find((row) => row.id === userId)?.credits;
    setBusyId(userId);
    setError(null);
    setCreditNotice(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/credits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Credit update failed");
      const after = json.credits as CreditSummary | undefined;
      if (after) {
        setRows((prev) =>
          prev.map((row) =>
            row.id === userId ? { ...row, credits: after } : row,
          ),
        );
      }
      setCreditNotice({
        userId,
        tone: "ok",
        stamp: Date.now(),
        message: describeCreditChange(action, before, after),
        credits: after,
      });
      await load();
      if (detailId === userId) await loadDetail(userId);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      setCreditNotice({
        userId,
        tone: "error",
        message,
        stamp: Date.now(),
      });
    } finally {
      setBusyId(null);
    }
  }

  async function deleteUser(user: AdminUserRow) {
    const action = window.prompt(
      `Delete @${user.username}?\n\nThis is a soft delete: billing and audit history are kept, but access is revoked immediately.\n\nWhat should happen to their ${user.projectCount} project(s)?\nType "archive", "transfer" or "unassign".`,
      "archive",
    );
    if (action === null) return;
    const projects = action.trim().toLowerCase();
    if (!["archive", "transfer", "unassign"].includes(projects)) {
      setError('Project action must be "archive", "transfer" or "unassign".');
      return;
    }

    let transferTo = "";
    if (projects === "transfer") {
      const target = window.prompt(
        "Transfer projects to which username? (must be an active account)",
      );
      if (target === null) return;
      const match = rows.find(
        (r) => r.username === target.trim().toLowerCase() && r.status === "active",
      );
      if (!match) {
        setError("No active account with that username.");
        return;
      }
      transferTo = match.id;
    }

    if (
      !window.confirm(
        `Confirm: soft-delete @${user.username} and ${projects} their projects.`,
      )
    ) {
      return;
    }

    setBusyId(user.id);
    setError(null);
    try {
      const params = new URLSearchParams({ projects });
      if (transferTo) params.set("transferTo", transferTo);
      const res = await fetch(`/api/admin/users/${user.id}?${params}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Delete failed");
      setNotice(json.note ?? "Account deleted.");
      if (detailId === user.id) {
        setDetailId(null);
        setDetail(null);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="panel glow-panel admin-panel">
        <h2>Create user</h2>
        <p className="muted">
          New accounts get a one-time temporary password and must change it at
          next sign-in.
        </p>
        <form onSubmit={(e) => void createUser(e)}>
          <div className="admin-form-grid">
            <label className="admin-field">
              <span className="search-label">Username</span>
              <input
                className="search-input"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="jane_doe"
                autoComplete="off"
                required
                disabled={creating}
              />
            </label>
            <label className="admin-field">
              <span className="search-label">Display name</span>
              <input
                className="search-input"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="Jane Doe"
                required
                disabled={creating}
              />
            </label>
            <label className="admin-field">
              <span className="search-label">Role</span>
              <select
                className="search-input"
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                disabled={creating}
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <label className="admin-field">
              <span className="search-label">Initial allowance (credits)</span>
              <input
                className="search-input"
                value={newAllowance}
                onChange={(e) => setNewAllowance(e.target.value)}
                placeholder="Default from settings"
                inputMode="decimal"
                disabled={creating}
              />
            </label>
          </div>
          <button type="submit" className="search-btn" disabled={creating}>
            {creating ? "Creating…" : "Create user"}
          </button>
        </form>

        {secret ? <p className="admin-secret-note">{secret}</p> : null}
        {notice ? <p className="credits-pending">{notice}</p> : null}
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      <section className="panel glow-panel admin-panel">
        <div className="progress-head">
          <h2>Users</h2>
          <button type="button" className="chip-btn" onClick={() => void load()}>
            Refresh
          </button>
        </div>

        <div className="credits-filter-row">
          <label className="credits-filter">
            <span className="search-label">Search</span>
            <input
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="username or name"
            />
          </label>
          <label className="credits-filter">
            <span className="search-label">Role</span>
            <select
              className="search-input"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="">All roles</option>
              <option value="admin">Admin</option>
              <option value="user">User</option>
            </select>
          </label>
          <label className="credits-filter">
            <span className="search-label">Status</span>
            <select
              className="search-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deleted">Deleted</option>
            </select>
          </label>
        </div>

        {loading ? (
          <p className="muted">Loading users…</p>
        ) : rows.length === 0 ? (
          <p className="empty-hint">No accounts match these filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Credits</th>
                  <th>Projects</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((user) => {
                  return (
                    <tr key={user.id}>
                      <td>
                        <strong>{user.displayName}</strong>
                        <br />
                        <span className="muted">@{user.username}</span>
                      </td>
                      <td>
                        <span
                          className={
                            user.role === "admin"
                              ? "admin-role-pill is-admin"
                              : "admin-role-pill"
                          }
                        >
                          {user.role}
                        </span>
                      </td>
                      <td>
                        <span
                          className={
                            user.status === "active"
                              ? "status-pill status-completed"
                              : user.status === "suspended"
                                ? "status-pill status-partial"
                                : "status-pill status-failed"
                          }
                        >
                          {user.status}
                        </span>
                      </td>
                      <td>
                        {user.role === "admin" ? (
                          <span className="admin-credit-summary">
                            <strong>Unlimited</strong>
                            <span className="muted">
                              {formatCredits(user.credits.consumedSubunits)} used
                            </span>
                          </span>
                        ) : (
                          <span
                            className={`admin-credit-summary ${
                              creditNotice?.userId === user.id &&
                              creditNotice.tone === "ok"
                                ? "credit-flash"
                                : ""
                            }`}
                            key={
                              creditNotice?.userId === user.id
                                ? creditNotice.stamp
                                : user.id
                            }
                          >
                            <strong
                              className={
                                user.credits.lowCredit ? "credits-low" : undefined
                              }
                            >
                              {formatCredits(user.credits.availableSubunits)} left
                            </strong>
                            <span className="muted">
                              {formatCredits(user.credits.allowanceSubunits)} allowance
                            </span>
                          </span>
                        )}
                      </td>
                      <td>{user.projectCount}</td>
                      <td>
                        <button
                          type="button"
                          className={
                            manageId === user.id ? "chip-btn active" : "chip-btn"
                          }
                          onClick={() =>
                            setManageId((current) =>
                              current === user.id ? null : user.id,
                            )
                          }
                        >
                          {manageId === user.id ? "Close" : "Manage"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {manageId ? (
        <UserManagePanel
          user={rows.find((row) => row.id === manageId) ?? null}
          busy={busyId === manageId}
          amount={creditAmount}
          reason={creditReason}
          cadence={resetCadence}
          notice={creditNotice}
          onAmount={setCreditAmount}
          onReason={setCreditReason}
          onCadence={setResetCadence}
          onCredit={(action, override) => {
            const userId = manageId;
            if (!creditReason.trim()) {
              setCreditNotice({
                userId,
                tone: "error",
                message: "A reason is required for every credit change.",
                stamp: Date.now(),
              });
              return;
            }
            void creditAction(userId, action, {
              credits: override?.credits ?? creditAmount,
              reason: creditReason,
              cadence: resetCadence,
            });
          }}
          onPatch={(body) => void patchUser(manageId, body)}
          onResetPassword={() => {
            const user = rows.find((row) => row.id === manageId);
            if (user) void resetPassword(user);
          }}
          onDelete={() => {
            const user = rows.find((row) => row.id === manageId);
            if (user) void deleteUser(user);
          }}
          onDetails={() => void loadDetail(manageId)}
        />
      ) : null}

      {detailId ? (
        <section className="panel glow-panel admin-panel">
          <div className="progress-head">
            <h2>
              {detail ? `${detail.user.displayName} — usage & activity` : "User detail"}
            </h2>
            <button
              type="button"
              className="chip-btn"
              onClick={() => {
                setDetailId(null);
                setDetail(null);
              }}
            >
              Close
            </button>
          </div>

          {detailLoading ? (
            <p className="muted">Loading user detail…</p>
          ) : !detail ? (
            <p className="empty-hint">Could not load this user.</p>
          ) : (
            <>
              <dl className="progress-stats">
                <div>
                  <dt>Allowance</dt>
                  <dd>{formatCredits(detail.credits.allowanceSubunits)}</dd>
                </div>
                <div>
                  <dt>Consumed</dt>
                  <dd>{formatCredits(detail.credits.consumedSubunits)}</dd>
                </div>
                <div>
                  <dt>Reserved</dt>
                  <dd>{formatCredits(detail.credits.reservedSubunits)}</dd>
                </div>
                <div>
                  <dt>Available</dt>
                  <dd>{formatCredits(detail.credits.availableSubunits)}</dd>
                </div>
                <div>
                  <dt>Concurrency limit</dt>
                  <dd>{detail.limits.maxConcurrentRuns ?? "Default"}</dd>
                </div>
              </dl>

              <h3>Allocation periods</h3>
              {detail.periods.length === 0 ? (
                <p className="empty-hint">No allocation periods yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th>Started</th>
                        <th>Status</th>
                        <th>Allowance</th>
                        <th>Consumed</th>
                        <th>Reserved</th>
                        <th>Cadence</th>
                        <th>Next reset</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.periods.map((p) => (
                        <tr key={p.id}>
                          <td className="admin-nowrap">
                            {formatDate(p.startsAt)}
                          </td>
                          <td>{p.status}</td>
                          <td>{formatCredits(p.allowanceSubunits)}</td>
                          <td>{formatCredits(p.consumedSubunits)}</td>
                          <td>{formatCredits(p.reservedSubunits)}</td>
                          <td>{p.resetCadence}</td>
                          <td className="admin-nowrap">
                            {p.nextResetAt ? formatDate(p.nextResetAt) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3>Usage by provider</h3>
              {detail.usageByProvider.length === 0 ? (
                <p className="empty-hint">No provider usage for this user.</p>
              ) : (
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
                      {detail.usageByProvider.map((row) => (
                        <tr key={row.provider}>
                          <td>{providerLabel(row.provider, "admin")}</td>
                          <td>{row.calls}</td>
                          <td>{formatCredits(row.creditsCharged)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3>Projects owned</h3>
              {detail.projects.length === 0 ? (
                <p className="empty-hint">This user owns no projects.</p>
              ) : (
                <div className="table-wrap">
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th>Project</th>
                        <th>Kind</th>
                        <th>Created</th>
                        <th>Archived</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.projects.map((p) => (
                        <tr key={`${p.kind}:${p.id}`}>
                          <td>{p.title}</td>
                          <td>{p.kind}</td>
                          <td className="admin-nowrap">{formatDateTime(p.createdAt)}</td>
                          <td>{p.archivedAt ? formatDateTime(p.archivedAt) : "No"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <h3>Recent runs</h3>
              {detail.recentRuns.length === 0 ? (
                <p className="empty-hint">No runs recorded.</p>
              ) : (
                <div className="table-wrap">
                  <table className="comp-table">
                    <thead>
                      <tr>
                        <th>Run</th>
                        <th>Operation</th>
                        <th>Calls</th>
                        <th>Credits</th>
                        <th>Finished</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.recentRuns.map((run) => (
                        <tr key={run.runId}>
                          <td>{run.runId}</td>
                          <td>{run.operation}</td>
                          <td>{run.calls}</td>
                          <td>{formatCredits(run.creditsCharged)}</td>
                          <td className="admin-nowrap">
                            {formatDateTime(run.completedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
    </>
  );
}
