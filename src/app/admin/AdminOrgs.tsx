"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { formatDateTime } from "@/lib/credits/display";
import { CopyValue, InlineNotice, adminFetch, type Notice } from "./adminUi";

type OrgRow = {
  id: string;
  name: string;
  createdAt: string;
  userCount: number;
  adminCount: number;
  admins: Array<{ id: string; username: string; displayName: string; status: string }>;
  runCount: number;
  lastLoginAt: string | null;
};

/**
 * Client organisations sharing this deployment. Each one's admins manage only
 * their own people, runs and usage; platform admins see everything.
 */
export default function AdminOrgs({ onOpenUser }: { onOpenUser: (userId: string) => void }) {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [name, setName] = useState("");
  const [adminUsername, setAdminUsername] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ org: string; username: string; password: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<{ organizations: OrgRow[] }>("/api/admin/orgs");
      setOrgs(data.organizations);
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const data = await adminFetch<{
        organization: { name: string };
        admin: { username: string };
        temporaryPassword: string;
      }>("/api/admin/orgs", {
        method: "POST",
        json: { action: "create", name, adminUsername, adminDisplayName },
      });
      setCreated({ org: data.organization.name, username: data.admin.username, password: data.temporaryPassword });
      setName("");
      setAdminUsername("");
      setAdminDisplayName("");
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    setBusy(true);
    try {
      await adminFetch("/api/admin/orgs", { method: "POST", json: { action: "rename", orgId: renaming.id, name: renaming.name } });
      setRenaming(null);
      setNotice({ tone: "ok", text: "Organisation renamed." });
      await load();
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-org-tab">
      <p className="muted">
        A client organisation shares this app with you. Its administrators see and manage only their own users, runs,
        usage and audit log — never yours or another organisation&apos;s. Settings, credit rates, billing checks and
        vendor balances stay with platform administrators. You still see every organisation here and in the other tabs.
      </p>

      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />

      {created ? (
        <div className="panel glow-panel admin-panel">
          <h3>{created.org} is ready</h3>
          <p className="confirm-desc">
            Send @{created.username} this temporary password privately. They must choose a new one at first sign-in,
            then they can add their own team from Admin → Users.
          </p>
          <CopyValue label="Temporary password" value={created.password} hint="It is shown only once." />
          <button type="button" className="chip-btn" onClick={() => setCreated(null)}>
            Done
          </button>
        </div>
      ) : null}

      <form className="panel glow-panel admin-panel" onSubmit={(e) => void create(e)}>
        <h3>New client organisation</h3>
        <div className="admin-form-grid">
          <label className="admin-field">
            <span className="search-label">Organisation name</span>
            <input className="search-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Marketing" required disabled={busy} />
          </label>
          <label className="admin-field">
            <span className="search-label">Their admin&apos;s username</span>
            <input className="search-input" value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} placeholder="acme_admin" autoComplete="off" required disabled={busy} />
          </label>
          <label className="admin-field">
            <span className="search-label">Their admin&apos;s display name</span>
            <input className="search-input" value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)} placeholder="Jane Doe" required disabled={busy} />
          </label>
        </div>
        <p className="form-hint">
          The admin starts with an empty history and unlimited credits, like your admins. Runs use this deployment&apos;s
          API keys.
        </p>
        <button type="submit" className="search-btn" disabled={busy}>
          {busy ? "Creating…" : "Create organisation and admin"}
        </button>
      </form>

      <div className="panel glow-panel admin-panel">
        <h2>Client organisations</h2>
      <div className="table-wrap">
        <table className="comp-table">
          <thead>
            <tr>
              <th>Organisation</th>
              <th>Admins</th>
              <th>Users</th>
              <th>Runs</th>
              <th>Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orgs === null ? (
              <tr>
                <td colSpan={6} className="muted">Loading…</td>
              </tr>
            ) : orgs.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">No client organisations yet.</td>
              </tr>
            ) : (
              orgs.map((org) => (
                <tr key={org.id}>
                  <td>
                    {renaming?.id === org.id ? (
                      <form className="admin-inline-form" onSubmit={(e) => void rename(e)}>
                        <input
                          className="search-input"
                          value={renaming.name}
                          onChange={(e) => setRenaming({ id: org.id, name: e.target.value })}
                          aria-label="Organisation name"
                          autoFocus
                        />
                        <button type="submit" className="chip-btn" disabled={busy}>Save</button>
                        <button type="button" className="link-btn" onClick={() => setRenaming(null)}>Cancel</button>
                      </form>
                    ) : (
                      <strong>{org.name}</strong>
                    )}
                    <div className="muted">Since {formatDateTime(org.createdAt)}</div>
                  </td>
                  <td>
                    {org.admins.length
                      ? org.admins.map((a, i) => (
                          <span key={a.id}>
                            {i ? ", " : ""}
                            <button type="button" className="link-btn" onClick={() => onOpenUser(a.id)}>
                              @{a.username}
                            </button>
                            {a.status !== "active" ? <span className="muted"> ({a.status})</span> : null}
                          </span>
                        ))
                      : <span className="muted">None</span>}
                  </td>
                  <td>{org.userCount}</td>
                  <td>{org.runCount}</td>
                  <td className="admin-nowrap">{org.lastLoginAt ? formatDateTime(org.lastLoginAt) : <span className="muted">Never</span>}</td>
                  <td>
                    {renaming?.id === org.id ? null : (
                      <button type="button" className="link-btn" onClick={() => setRenaming({ id: org.id, name: org.name })}>
                        Rename
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      </div>
    </section>
  );
}
