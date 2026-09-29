"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { CREDIT_SCALE, formatCredits } from "@/lib/accounting/units";
import { formatDate, formatDateTime, providerLabel } from "@/lib/credits/display";
import { CreditAllotmentGuide } from "@/components/CreditAllotmentGuide";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { CreditSummary } from "@/lib/accounting/service";
import {
  PROVIDER_IDS,
  type AppUserPublic,
  type CreditLedgerEntry,
  type CreditPeriod,
  type ProviderCallRecord,
} from "@/lib/types";
import {
  cadenceLabel,
  callStatusLabel,
  ledgerTypeLabel,
  operationLabel,
  periodStatusLabel,
} from "@/lib/admin/labels";
import type { AdminUserRow } from "./AdminUsers";
import { CopyValue, Drawer, InlineNotice, adminFetch, type Notice } from "./adminUi";

interface UserDetail {
  user: AppUserPublic;
  limits: {
    maxConcurrentRuns: number | null;
    allowedProviders: string[] | null;
    blockedModels: string[] | null;
  };
  credits: CreditSummary;
  periods: CreditPeriod[];
  usageByProvider: Array<{ provider: string; calls: number; creditsCharged: number }>;
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
  projects: Array<{ kind: string; id: string; title: string; createdAt: string; archivedAt: string | null }>;
  sharedWithThisUser: Array<{ projectKind: string; projectId: string; role: string }>;
  lastLoginAt: string | null;
  loginLocked: boolean;
  spacesOwned: Array<{ id: string; clientName: string; archivedAt: string | null }>;
  spacesSharedWithThisUser: Array<{ spaceId: string; role: string; clientName: string }>;
  ledger: CreditLedgerEntry[];
}

type Tab = "credits" | "account" | "limits" | "activity";
const ADJUST_LIMIT = 200;

function runLink(kind: string | null, id: string | null): string | null {
  if (!kind || !id) return null;
  return kind === "lookup"
    ? `/?mode=lookup&lookup=${encodeURIComponent(id)}`
    : `/?mode=search&run=${encodeURIComponent(id)}&tab=preview`;
}

export default function AdminUserDrawer({
  userId,
  row,
  meId,
  onClose,
  onChanged,
  onDeleted,
}: {
  userId: string;
  row: AdminUserRow | null;
  meId: string | null;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: (text: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("credits");
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await adminFetch<UserDetail>(`/api/admin/users/${userId}`));
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    await load();
    onChanged();
  }, [load, onChanged]);

  const user = detail?.user ?? row;
  const deleted = user?.status === "deleted";

  return (
    <Drawer
      open
      onClose={onClose}
      title={user ? user.displayName : "User"}
      subtitle={
        user
          ? `@${user.username} · ${user.role === "admin" ? "Admin" : "User"} · ${
              detail?.lastLoginAt ? `last signed in ${formatDateTime(detail.lastLoginAt)}` : "never signed in"
            }`
          : null
      }
    >
      {loadError ? (
        <p className="error-text" role="alert">
          {loadError}
        </p>
      ) : null}
      {!detail ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="tab-bar admin-drawer-tabs" role="tablist">
            {(["credits", "account", "limits", "activity"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                className={`tab-btn ${tab === t ? "active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "credits" ? "Credits" : t === "account" ? "Account" : t === "limits" ? "Limits" : "Activity"}
              </button>
            ))}
          </div>
          {deleted && tab !== "activity" ? (
            <p className="empty-hint">This account is deleted. Its history is kept; it can’t be changed.</p>
          ) : tab === "credits" ? (
            <CreditsTab detail={detail} userId={userId} onSaved={refresh} />
          ) : tab === "account" ? (
            <AccountTab detail={detail} userId={userId} isMe={meId === userId} onSaved={refresh} onDeleted={onDeleted} />
          ) : tab === "limits" ? (
            <LimitsTab detail={detail} userId={userId} onSaved={refresh} />
          ) : (
            <ActivityTab detail={detail} />
          )}
        </>
      )}
    </Drawer>
  );
}

/* ───────────────────────────── Credits ───────────────────────────── */

function CreditsTab({ detail, userId, onSaved }: { detail: UserDetail; userId: string; onSaved: () => Promise<void> }) {
  const credits = detail.credits;
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [adjustment, setAdjustment] = useState(0);
  const [cadence, setCadence] = useState(credits.resetCadence);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function run(action: "set_allowance" | "add_credits" | "adjustment" | "set_reset_cadence") {
    if (!reason.trim()) {
      setNotice({ tone: "error", text: "Add a reason first. It is kept in the credit history and audit log." });
      return;
    }
    setBusy(true);
    setNotice(null);
    const before = credits.availableSubunits;
    try {
      const json = await adminFetch<{ credits: CreditSummary }>(`/api/admin/users/${userId}/credits`, {
        method: "POST",
        json: {
          action,
          reason: reason.trim(),
          credits: action === "adjustment" ? String(adjustment) : amount,
          cadence,
        },
      });
      const after = json.credits;
      const text =
        action === "set_reset_cadence"
          ? `Reset schedule saved: ${cadence === "monthly" ? "unused allowance expires monthly" : "manual allocation"}.`
          : action === "adjustment"
            ? `Usage adjusted. Remaining is now ${formatCredits(after.availableSubunits)} (was ${formatCredits(before)}).`
            : action === "add_credits"
              ? `Added ${amount} credits. Remaining is now ${formatCredits(after.availableSubunits)}.`
              : `Allowance set to ${formatCredits(after.allowanceSubunits)}. Remaining is ${formatCredits(after.availableSubunits)}.`;
      setNotice({ tone: "ok", text });
      setAmount("");
      setAdjustment(0);
      await onSaved();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const unlimited = detail.user.role === "admin";
  return (
    <div className="admin-drawer-section">
      <p className="credit-live">
        <strong>{unlimited ? "Unlimited" : `${formatCredits(credits.availableSubunits)} left`}</strong>
        <span className="muted">
          {formatCredits(credits.allowanceSubunits)} allowance · {formatCredits(Math.max(credits.consumedSubunits, 0))} used
          {credits.reservedSubunits ? ` · ${formatCredits(credits.reservedSubunits)} held for running work` : ""}
          {credits.nextResetAt ? ` · resets ${formatDate(credits.nextResetAt)}` : ""}
        </span>
      </p>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

      <label className="admin-field">
        <span className="search-label">Reason (required for every change)</span>
        <input className="search-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Monthly top-up" disabled={busy} />
      </label>

      <h3>Allowance</h3>
      <div className="admin-inline-form">
        <input className="search-input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Credits" aria-label="Credits" disabled={busy} />
        <button type="button" className="chip-btn" disabled={busy || !amount} onClick={() => void run("add_credits")}>
          Add credits
        </button>
        <button type="button" className="chip-btn" disabled={busy || !amount} onClick={() => void run("set_allowance")}>
          Set allowance to this
        </button>
      </div>

      <h3>Adjust usage</h3>
      <p className="form-hint">Changes what is left without changing the allowance. Left removes credits, right gives them back.</p>
      <div className="credit-adjust">
        <div className="credit-adjust-head">
          <span className="search-label">Adjustment</span>
          <strong className={adjustment < 0 ? "is-negative" : adjustment > 0 ? "is-positive" : undefined}>
            {adjustment > 0 ? `+${adjustment}` : adjustment} credits
          </strong>
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
        {adjustment !== 0 ? (
          <p className="form-hint">
            Remaining will go from {formatCredits(credits.availableSubunits)} to{" "}
            {formatCredits(credits.availableSubunits + adjustment * CREDIT_SCALE)}.
          </p>
        ) : null}
        <button type="button" className="chip-btn" disabled={busy || adjustment === 0} onClick={() => void run("adjustment")}>
          Apply adjustment
        </button>
      </div>

      <h3>Reset schedule</h3>
      <div className="admin-inline-form">
        <select className="search-input" value={cadence} onChange={(e) => setCadence(e.target.value as typeof cadence)} disabled={busy} aria-label="Reset schedule">
          <option value="none">Manual: credits last until used</option>
          <option value="monthly">Monthly: unused allowance expires</option>
        </select>
        <button type="button" className="chip-btn" disabled={busy || cadence === credits.resetCadence} onClick={() => void run("set_reset_cadence")}>
          Save schedule
        </button>
      </div>

      <details className="admin-details">
        <summary>How allowances work</summary>
        <CreditAllotmentGuide />
      </details>

      <h3>Credit history</h3>
      {detail.ledger.length === 0 ? (
        <p className="empty-hint">No credit changes yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Credits</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {detail.ledger
                .filter((e) => e.type !== "reservation_hold" && e.type !== "reservation_release")
                .slice(0, 50)
                .map((e) => (
                  <tr key={e.id}>
                    <td className="admin-nowrap">{formatDateTime(e.createdAt)}</td>
                    <td>{ledgerTypeLabel(e.type)}</td>
                    <td className={e.deltaSubunits < 0 ? "is-negative" : undefined}>
                      {e.deltaSubunits > 0 ? "+" : ""}
                      {formatCredits(e.deltaSubunits)}
                    </td>
                    <td className="muted">{e.reason || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Account ───────────────────────────── */

type Pending =
  | { kind: "status"; to: "active" | "suspended" }
  | { kind: "role"; to: "admin" | "user" }
  | { kind: "password" }
  | null;

function AccountTab({
  detail,
  userId,
  isMe,
  onSaved,
  onDeleted,
}: {
  detail: UserDetail;
  userId: string;
  isMe: boolean;
  onSaved: () => Promise<void>;
  onDeleted: (text: string) => void;
}) {
  const user = detail.user;
  const [name, setName] = useState(user.displayName);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Organisations are listed only for platform admins (the API refuses others).
  const [orgs, setOrgs] = useState<Array<{ id: string; name: string; archivedAt?: string | null }> | null>(null);
  const [orgChoice, setOrgChoice] = useState<string>(user.orgId ?? "");
  useEffect(() => {
    void adminFetch<{ organizations: Array<{ id: string; name: string; archivedAt?: string | null }> }>("/api/admin/orgs")
      .then((d) => setOrgs(d.organizations.filter((o) => !o.archivedAt)))
      .catch(() => setOrgs(null));
  }, []);

  async function patch(body: Record<string, unknown>, okText: string) {
    setBusy(true);
    setNotice(null);
    try {
      await adminFetch(`/api/admin/users/${userId}`, { method: "PATCH", json: body });
      setNotice({ tone: "ok", text: okText });
      await onSaved();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  async function resetPassword() {
    setBusy(true);
    setNotice(null);
    try {
      const json = await adminFetch<{ temporaryPassword: string }>(`/api/admin/users/${userId}/password`, {
        method: "POST",
        json: {},
      });
      setTempPassword(json.temporaryPassword);
      setNotice({ tone: "ok", text: "Password reset. They have been signed out everywhere." });
      await onSaved();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function saveName(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === user.displayName) return;
    void patch({ displayName: name.trim() }, "Name saved.");
  }

  const confirm =
    pending?.kind === "status"
      ? pending.to === "suspended"
        ? {
            title: `Suspend @${user.username}?`,
            description: "They are signed out at once and can’t sign in or run anything until reactivated. Their runs and credits are kept.",
            label: "Suspend",
            tone: "danger" as const,
            run: () => patch({ status: "suspended" }, "Account suspended."),
          }
        : {
            title: `Reactivate @${user.username}?`,
            description: "They can sign in and run work again.",
            label: "Reactivate",
            tone: "default" as const,
            run: () => patch({ status: "active" }, "Account reactivated."),
          }
      : pending?.kind === "role"
        ? pending.to === "admin"
          ? {
              title: `Make @${user.username} an admin?`,
              description: user.orgId
                ? "Admins have unlimited credits and can see and change every account and run in their organisation."
                : "Admins have unlimited credits and can see and change every account, run and setting.",
              label: "Make admin",
              tone: "danger" as const,
              run: () => patch({ role: "admin" }, "Now an admin."),
            }
          : {
              title: `Remove admin rights from @${user.username}?`,
              description: "They become a regular user with their normal credit allowance.",
              label: "Make regular user",
              tone: "default" as const,
              run: () => patch({ role: "user" }, "Now a regular user."),
            }
        : pending?.kind === "password"
          ? {
              title: `Reset the password for @${user.username}?`,
              description: "They are signed out everywhere and get a temporary password you pass on to them.",
              label: "Reset password",
              tone: "default" as const,
              run: () => resetPassword(),
            }
          : null;

  return (
    <div className="admin-drawer-section">
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      {tempPassword ? (
        <CopyValue
          label="Temporary password"
          value={tempPassword}
          hint="Shown only once. They must choose a new password when they sign in."
        />
      ) : null}

      <form className="admin-inline-form" onSubmit={saveName}>
        <label className="admin-field">
          <span className="search-label">Display name</span>
          <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={80} />
        </label>
        <button type="submit" className="chip-btn" disabled={busy || !name.trim() || name.trim() === user.displayName}>
          Save name
        </button>
      </form>

      <h3>Access</h3>
      <div className="admin-manage-actions">
        <button
          type="button"
          className="chip-btn"
          disabled={busy || isMe}
          title={isMe ? "You can’t suspend your own account" : undefined}
          onClick={() => setPending({ kind: "status", to: user.status === "active" ? "suspended" : "active" })}
        >
          {user.status === "active" ? "Suspend" : "Reactivate"}
        </button>
        <button
          type="button"
          className="chip-btn"
          disabled={busy || (isMe && user.role === "admin")}
          title={isMe ? "You can’t remove your own admin rights" : undefined}
          onClick={() => setPending({ kind: "role", to: user.role === "admin" ? "user" : "admin" })}
        >
          {user.role === "admin" ? "Make regular user" : "Make admin"}
        </button>
        <button type="button" className="chip-btn" disabled={busy} onClick={() => setPending({ kind: "password" })}>
          Reset password
        </button>
        {detail.loginLocked ? (
          <button type="button" className="chip-btn" disabled={busy} onClick={() => void patch({ unlockLogin: true }, "Sign-in unlocked.")}>
            Unlock sign-in
          </button>
        ) : null}
      </div>
      {detail.loginLocked ? (
        <p className="form-hint">Sign-in is locked for 15 minutes after repeated wrong passwords.</p>
      ) : null}

      {orgs ? (
        <>
          <h3>Organisation</h3>
          <form
            className="admin-inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void patch(
                { orgId: orgChoice || null },
                orgChoice ? `Moved to ${orgs.find((o) => o.id === orgChoice)?.name ?? "the organisation"}.` : "Moved to your organisation.",
              );
            }}
          >
            <label className="admin-field">
              <span className="search-label">Belongs to</span>
              <select className="search-input" value={orgChoice} onChange={(e) => setOrgChoice(e.target.value)} disabled={busy || isMe}>
                <option value="">Your organisation (platform)</option>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="chip-btn" disabled={busy || isMe || orgChoice === (user.orgId ?? "")}>
              Move
            </button>
          </form>
          <p className="form-hint">
            A client organisation&apos;s admins see only its own people and runs. Moving signs this person out.
          </p>
        </>
      ) : null}

      <h3>Delete account</h3>
      <p className="form-hint">Access ends at once. Billing and audit history are kept.</p>
      <button type="button" className="danger-btn" disabled={busy || isMe} onClick={() => setDeleteOpen(true)}>
        Delete account…
      </button>

      {confirm ? (
        <ConfirmDialog
          open
          title={confirm.title}
          description={confirm.description}
          confirmLabel={confirm.label}
          tone={confirm.tone}
          busy={busy}
          onConfirm={() => void confirm.run()}
          onCancel={() => setPending(null)}
        />
      ) : null}
      {deleteOpen ? (
        <DeleteUserDialog
          detail={detail}
          userId={userId}
          onClose={() => setDeleteOpen(false)}
          onDeleted={onDeleted}
        />
      ) : null}
    </div>
  );
}

function DeleteUserDialog({
  detail,
  userId,
  onClose,
  onDeleted,
}: {
  detail: UserDetail;
  userId: string;
  onClose: () => void;
  onDeleted: (text: string) => void;
}) {
  const user = detail.user;
  const [choice, setChoice] = useState<"archive" | "transfer" | "unassign">("archive");
  const [transferTo, setTransferTo] = useState("");
  const [users, setUsers] = useState<Array<{ id: string; username: string; displayName: string }>>([]);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void adminFetch<{ users: Array<{ id: string; username: string; displayName: string }> }>(
      "/api/admin/users?status=active",
    )
      .then((d) => setUsers((d.users ?? []).filter((u) => u.id !== userId)))
      .catch(() => undefined);
  }, [userId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ projects: choice });
      if (choice === "transfer") params.set("transferTo", transferTo);
      const json = await adminFetch<{ note?: string; projectsAffected?: number; spacesAffected?: number }>(
        `/api/admin/users/${userId}?${params}`,
        { method: "DELETE" },
      );
      onDeleted(
        `@${user.username} deleted. ${json.projectsAffected ?? 0} runs and ${json.spacesAffected ?? 0} client spaces handled.`,
      );
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const ready = typed.trim().toLowerCase() === user.username && (choice !== "transfer" || transferTo);
  const runCount = detail.projects.length;
  const spaceCount = detail.spacesOwned.filter((s) => !s.archivedAt).length;

  return (
    <div className="confirm-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="confirm-dialog confirm-dialog-danger admin-modal" role="alertdialog" aria-modal="true" aria-label={`Delete ${user.username}`}>
        <h3 className="confirm-title">Delete @{user.username}?</h3>
        <p className="confirm-desc">
          They own {runCount} run{runCount === 1 ? "" : "s"} and {spaceCount} client space{spaceCount === 1 ? "" : "s"}. What
          should happen to them?
        </p>
        <fieldset className="admin-radio-list">
          <label>
            <input type="radio" checked={choice === "archive"} onChange={() => setChoice("archive")} /> Archive them (hidden, kept on record)
          </label>
          <label>
            <input type="radio" checked={choice === "transfer"} onChange={() => setChoice("transfer")} /> Give them to another user
          </label>
          {choice === "transfer" ? (
            <select className="search-input" value={transferTo} onChange={(e) => setTransferTo(e.target.value)} aria-label="New owner">
              <option value="">Choose the new owner…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} (@{u.username})
                </option>
              ))}
            </select>
          ) : null}
          <label>
            <input type="radio" checked={choice === "unassign"} onChange={() => setChoice("unassign")} /> Leave them unassigned (only admins see them)
          </label>
        </fieldset>
        <label className="admin-field">
          <span className="search-label">Type {user.username} to confirm</span>
          <input className="search-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </label>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <div className="confirm-actions">
          <button type="button" className="chip-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="chip-btn confirm-primary confirm-danger" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────── Limits ───────────────────────────── */

function LimitsTab({ detail, userId, onSaved }: { detail: UserDetail; userId: string; onSaved: () => Promise<void> }) {
  const [concurrency, setConcurrency] = useState(detail.limits.maxConcurrentRuns?.toString() ?? "");
  const [providers, setProviders] = useState<Set<string>>(
    new Set(detail.limits.allowedProviders ?? PROVIDER_IDS),
  );
  const [models, setModels] = useState((detail.limits.blockedModels ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const all = PROVIDER_IDS.every((p) => providers.has(p));
      await adminFetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        json: {
          maxConcurrentRuns: concurrency.trim() ? Number(concurrency) : null,
          // Every provider ticked means "no restriction".
          allowedProviders: all ? null : [...providers],
          blockedModels: models
            .split("\n")
            .map((m) => m.trim())
            .filter(Boolean),
        },
      });
      setNotice({ tone: "ok", text: "Limits saved." });
      await onSaved();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="admin-drawer-section" onSubmit={(e) => void save(e)}>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <label className="admin-field">
        <span className="search-label">Runs at the same time</span>
        <input
          className="search-input"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder="Default from settings"
          inputMode="numeric"
          disabled={busy}
        />
      </label>
      <fieldset className="admin-radio-list">
        <legend className="search-label">Services this user may use</legend>
        {PROVIDER_IDS.map((p) => (
          <label key={p}>
            <input
              type="checkbox"
              checked={providers.has(p)}
              disabled={busy}
              onChange={() =>
                setProviders((prev) => {
                  const next = new Set(prev);
                  if (next.has(p)) next.delete(p);
                  else next.add(p);
                  return next;
                })
              }
            />{" "}
            {providerLabel(p, "admin")}
          </label>
        ))}
        <p className="form-hint">Services turned off here are refused for this user, on top of any turned off for everyone in Settings.</p>
      </fieldset>
      <label className="admin-field">
        <span className="search-label">Blocked models (one per line)</span>
        <textarea className="search-input" rows={3} value={models} onChange={(e) => setModels(e.target.value)} disabled={busy} />
      </label>
      <button type="submit" className="search-btn" disabled={busy}>
        {busy ? "Saving…" : "Save limits"}
      </button>
    </form>
  );
}

/* ───────────────────────────── Activity ───────────────────────────── */

function ActivityTab({ detail }: { detail: UserDetail }) {
  return (
    <div className="admin-drawer-section">
      <dl className="progress-stats">
        <div>
          <dt>Runs owned</dt>
          <dd>{detail.projects.length}</dd>
        </div>
        <div>
          <dt>Client spaces</dt>
          <dd>{detail.spacesOwned.filter((s) => !s.archivedAt).length}</dd>
        </div>
        <div>
          <dt>Credits used (all time)</dt>
          <dd>{formatCredits(detail.usageByProvider.reduce((s, r) => s + r.creditsCharged, 0))}</dd>
        </div>
      </dl>

      <h3>Recent runs</h3>
      {detail.recentRuns.length === 0 ? (
        <p className="empty-hint">No billed runs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>What</th>
                <th>Credits</th>
                <th>Finished</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.recentRuns.map((run) => {
                const title = detail.projects.find((p) => p.id === run.projectId)?.title;
                const href = runLink(run.projectKind, run.projectId);
                return (
                  <tr key={run.runId}>
                    <td>
                      {operationLabel(run.operation)}
                      {title ? <span className="muted"> · {title}</span> : null}
                    </td>
                    <td>{formatCredits(run.creditsCharged)}</td>
                    <td className="admin-nowrap">{formatDateTime(run.completedAt)}</td>
                    <td>{href ? <Link href={href}>Open</Link> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h3>Usage by service</h3>
      {detail.usageByProvider.length === 0 ? (
        <p className="empty-hint">No usage yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>Service</th>
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

      <h3>Latest calls</h3>
      {detail.recentCalls.length === 0 ? (
        <p className="empty-hint">No calls yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>When</th>
                <th>For</th>
                <th>Service</th>
                <th>Result</th>
                <th>Credits</th>
              </tr>
            </thead>
            <tbody>
              {detail.recentCalls.map((call) => (
                <tr key={call.id}>
                  <td className="admin-nowrap">{formatDateTime(call.startedAt)}</td>
                  <td>{operationLabel(call.operation)}</td>
                  <td>{providerLabel(call.provider, "admin")}</td>
                  <td>{callStatusLabel(call.status)}</td>
                  <td>{formatCredits(call.creditsCharged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>Client spaces</h3>
      {detail.spacesOwned.length + detail.spacesSharedWithThisUser.length === 0 ? (
        <p className="empty-hint">No client spaces.</p>
      ) : (
        <ul className="admin-plain-list">
          {detail.spacesOwned.map((s) => (
            <li key={s.id}>
              {s.clientName} <span className="muted">· owner{s.archivedAt ? " · archived" : ""}</span>
            </li>
          ))}
          {detail.spacesSharedWithThisUser.map((s) => (
            <li key={s.spaceId}>
              {s.clientName} <span className="muted">· shared as {s.role === "editor" ? "editor" : "viewer"}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>Allowance periods</h3>
      {detail.periods.length === 0 ? (
        <p className="empty-hint">No allowance periods yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Allowance</th>
                <th>Used</th>
                <th>Schedule</th>
              </tr>
            </thead>
            <tbody>
              {detail.periods.map((p) => (
                <tr key={p.id}>
                  <td className="admin-nowrap">{formatDate(p.startsAt)}</td>
                  <td>{periodStatusLabel(p.status)}</td>
                  <td>{formatCredits(p.allowanceSubunits)}</td>
                  <td>{formatCredits(p.consumedSubunits)}</td>
                  <td>{cadenceLabel(p.resetCadence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
