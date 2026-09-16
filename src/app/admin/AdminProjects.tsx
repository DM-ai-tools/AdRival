"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatDate, formatDateTime } from "@/lib/credits/display";

interface Share {
  userId: string;
  username: string | null;
  displayName: string | null;
  role: string;
}

interface SpaceRun {
  kind: "search" | "lookup";
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface SpaceRow {
  id: string;
  clientName: string;
  ownerUserId: string;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
  runCount: number;
  updatedAt: string;
  shares: Share[];
  runs: SpaceRun[];
}

interface UnassignedRun {
  kind: "search" | "lookup";
  id: string;
  title: string;
  updatedAt: string;
  ownerDisplayName: string | null;
  ownerUsername: string | null;
}

interface UserOption {
  id: string;
  username: string;
  displayName: string;
}

function userLabel(user: UserOption): string {
  return `${user.displayName} (@${user.username})`;
}

export default function AdminProjects() {
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [unassigned, setUnassigned] = useState<UnassignedRun[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [clientName, setClientName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [shareUserId, setShareUserId] = useState<Record<string, string>>({});
  const [shareRole, setShareRole] = useState<Record<string, string>>({});
  const [moveTarget, setMoveTarget] = useState("");
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [runQuery, setRunQuery] = useState("");
  const [browseOwnerId, setBrowseOwnerId] = useState("");
  const [openSpaceId, setOpenSpaceId] = useState<string | null>(null);
  const [spaceQuery, setSpaceQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/spaces", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load client spaces");
      setSpaces(
        ((json.spaces ?? []) as SpaceRow[]).map((space) => ({
          ...space,
          runs: space.runs ?? [],
          shares: space.shares ?? [],
        })),
      );
      setUnassigned(json.unassigned ?? []);
      setUsers(json.users ?? []);
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

  async function act(body: Record<string, unknown>, key: string): Promise<boolean> {
    setBusyId(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Request failed");
      if (body.action === "delete") {
        setNotice(
          `Deleted the client space and archived ${json.runsArchived ?? 0} run(s).`,
        );
      }
      if (body.action === "move-runs") {
        setNotice(`Moved ${json.moved ?? 0} run(s) into the client space.`);
        setSelectedRuns([]);
      }
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function createSpace(e: FormEvent) {
    e.preventDefault();
    const ok = await act(
      { action: "create", clientName, ownerUserId },
      "create",
    );
    if (!ok) return;
    setBrowseOwnerId(ownerUserId);
    setClientName("");
  }

  const ownedSpaces = spaces.filter((space) => space.ownerUserId === browseOwnerId);
  const openSpace = spaces.find((space) => space.id === openSpaceId) ?? null;
  const spaceNeedle = spaceQuery.trim().toLowerCase();
  const matchingSpaces = spaces
    .filter((space) => {
      if (!spaceNeedle) return true;
      return `${space.clientName} ${space.ownerDisplayName ?? ""} ${space.ownerUsername ?? ""}`
        .toLowerCase()
        .includes(spaceNeedle);
    })
    .slice()
    .sort((a, b) => a.clientName.localeCompare(b.clientName));

  function openClientSpace(spaceId: string) {
    setOpenSpaceId(spaceId || null);
    const space = spaces.find((item) => item.id === spaceId);
    if (space) setBrowseOwnerId(space.ownerUserId);
  }

  return (
    <>
      <section className="panel glow-panel admin-panel">
        <h2>Client spaces</h2>
        <p className="muted">
          A client space holds that client’s search and lookup history. Sharing
          or deleting the space covers the whole history, not one run at a time.
        </p>
        <form className="admin-form-grid" onSubmit={(e) => void createSpace(e)}>
          <label className="admin-field">
            <span className="search-label">Client name</span>
            <input
              className="search-input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="e.g. Northside Dental"
              required
            />
          </label>
          <label className="admin-field">
            <span className="search-label">Owner</span>
            <select
              className="search-input"
              value={ownerUserId}
              onChange={(e) => setOwnerUserId(e.target.value)}
              required
            >
              <option value="">Choose an owner</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {userLabel(user)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="search-btn" disabled={busyId === "create"}>
            Create space
          </button>
        </form>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? <p className="credits-pending">{notice}</p> : null}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Client spaces</h2>
        <p className="muted">
          Open a client space directly, or choose an owner first. Either way
          shows every run in that space. Sharing and deleting still cover the
          whole space.
        </p>
        <label className="admin-field">
          <span className="search-label">Find a client space</span>
          <input
            className="search-input"
            value={spaceQuery}
            onChange={(e) => setSpaceQuery(e.target.value)}
            placeholder="Client name or owner"
          />
        </label>
        <label className="admin-field">
          <span className="search-label">Client space</span>
          <select
            className="search-input"
            value={openSpaceId ?? ""}
            onChange={(e) => openClientSpace(e.target.value)}
          >
            <option value="">Choose a client space</option>
            {matchingSpaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.clientName} — {space.ownerDisplayName ?? "Unknown owner"}
                {space.ownerUsername ? ` (@${space.ownerUsername})` : ""} ·{" "}
                {space.runCount} run{space.runCount === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        {spaceNeedle && matchingSpaces.length === 0 ? (
          <p className="empty-hint">No client space matches that search.</p>
        ) : null}
        <label className="admin-field">
          <span className="search-label">Or choose an owner</span>
          <select
            className="search-input"
            value={browseOwnerId}
            onChange={(e) => {
              setBrowseOwnerId(e.target.value);
              setOpenSpaceId(null);
            }}
          >
            <option value="">Choose an owner</option>
            {users.map((user) => {
              const count = spaces.filter((space) => space.ownerUserId === user.id).length;
              return (
                <option key={user.id} value={user.id}>
                  {userLabel(user)} · {count} space{count === 1 ? "" : "s"}
                </option>
              );
            })}
          </select>
        </label>
        {!browseOwnerId ? (
          <p className="empty-hint">Choose an owner to list their client spaces.</p>
        ) : ownedSpaces.length === 0 ? (
          <p className="empty-hint">This owner has no client spaces yet.</p>
        ) : (
          <ul className="space-browser">
            {ownedSpaces.map((space) => (
              <li key={space.id}>
                <button
                  type="button"
                  className={openSpaceId === space.id ? "active" : ""}
                  onClick={() =>
                    setOpenSpaceId((current) =>
                      current === space.id ? null : space.id,
                    )
                  }
                >
                  <strong>{space.clientName}</strong>
                  <span className="muted">
                    {space.runCount} run{space.runCount === 1 ? "" : "s"} · updated{" "}
                    {formatDate(space.updatedAt)}
                    {space.shares.length
                      ? ` · shared with ${space.shares.length}`
                      : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {openSpace ? (
        <section className="panel glow-panel admin-panel">
          <div className="progress-head">
            <div>
              <h2>{openSpace.clientName}</h2>
              <p className="muted">
                Owned by {openSpace.ownerDisplayName} (@{openSpace.ownerUsername}) ·{" "}
                {openSpace.runCount} run{openSpace.runCount === 1 ? "" : "s"}
              </p>
            </div>
            <button
              type="button"
              className="danger-btn"
              disabled={busyId === openSpace.id}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete “${openSpace.clientName}” and archive all ${openSpace.runCount} runs inside it? Shared users lose access immediately.`,
                  )
                ) {
                  void act({ action: "delete", spaceId: openSpace.id }, openSpace.id);
                  setOpenSpaceId(null);
                }
              }}
            >
              Delete space
            </button>
          </div>

          <h3>Runs in this space</h3>
          {openSpace.runs.length === 0 ? (
            <p className="empty-hint">No runs in this client space yet.</p>
          ) : (
            <ul className="space-run-list">
              {openSpace.runs.map((run) => (
                <li key={`${run.kind}:${run.id}`}>
                  <strong>{run.title}</strong>
                  <span className="muted">
                    {run.kind === "search" ? "Search" : "Lookup"} · {run.status}
                    {" · "}
                    Created {formatDateTime(run.createdAt)}
                    {run.updatedAt && run.updatedAt !== run.createdAt
                      ? ` · Updated ${formatDateTime(run.updatedAt)}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="admin-manage-grid">
            <div>
              <h3>Share the whole space</h3>
              <p className="form-hint">
                The recipient sees this client and every run in it. Viewers
                cannot start tasks. Editors can, and are charged on their own
                allowance.
              </p>
              <label className="admin-field">
                <span className="search-label">Share with</span>
                <select
                  className="search-input"
                  value={shareUserId[openSpace.id] ?? ""}
                  onChange={(e) =>
                    setShareUserId((prev) => ({
                      ...prev,
                      [openSpace.id]: e.target.value,
                    }))
                  }
                >
                  <option value="">Choose a user</option>
                  {users
                    .filter((user) => user.id !== openSpace.ownerUserId)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {userLabel(user)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="admin-field">
                <span className="search-label">Permission</span>
                <select
                  className="search-input"
                  value={shareRole[openSpace.id] ?? "viewer"}
                  onChange={(e) =>
                    setShareRole((prev) => ({
                      ...prev,
                      [openSpace.id]: e.target.value,
                    }))
                  }
                >
                  <option value="viewer">Viewer — can open history, cannot run</option>
                  <option value="editor">Editor — can run tasks, charged to them</option>
                </select>
              </label>
              <button
                type="button"
                className="chip-btn"
                disabled={!shareUserId[openSpace.id] || busyId === openSpace.id}
                onClick={() =>
                  void act(
                    {
                      action: "share",
                      spaceId: openSpace.id,
                      userId: shareUserId[openSpace.id],
                      role: shareRole[openSpace.id] ?? "viewer",
                    },
                    openSpace.id,
                  )
                }
              >
                Share space
              </button>
              {openSpace.shares.length === 0 ? (
                <p className="empty-hint">Not shared with anyone.</p>
              ) : (
                <ul className="admin-share-list">
                  {openSpace.shares.map((share) => (
                    <li key={share.userId}>
                      {share.displayName} (@{share.username}) ·{" "}
                      {share.role === "viewer" ? "Viewer" : "Editor"}
                      <button
                        type="button"
                        className="chip-btn"
                        onClick={() =>
                          void act(
                            {
                              action: "revoke",
                              spaceId: openSpace.id,
                              userId: share.userId,
                            },
                            openSpace.id,
                          )
                        }
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3>Transfer ownership</h3>
              <p className="form-hint">
                Moves the space to another user. Past charges stay with whoever
                ran them.
              </p>
              <label className="admin-field">
                <span className="search-label">New owner</span>
                <select
                  className="search-input"
                  defaultValue=""
                  onChange={(e) => {
                    const value = e.target.value;
                    e.currentTarget.value = "";
                    if (!value) return;
                    const next = users.find((user) => user.id === value);
                    if (
                      next &&
                      window.confirm(
                        `Transfer “${openSpace.clientName}” to ${userLabel(next)}?`,
                      )
                    ) {
                      setBrowseOwnerId(value);
                      void act(
                        {
                          action: "transfer",
                          spaceId: openSpace.id,
                          ownerUserId: value,
                        },
                        openSpace.id,
                      );
                    }
                  }}
                >
                  <option value="">Choose a new owner</option>
                  {users
                    .filter((user) => user.id !== openSpace.ownerUserId)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {userLabel(user)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </div>
        </section>
      ) : null}

      <section className="panel glow-panel admin-panel">
        <h2>Runs not in a client space</h2>
        <p className="muted">
          Older searches and lookups were stored one run at a time. Move them
          into a named client space so they can be shared or deleted together.
        </p>
        {unassigned.length === 0 ? (
          <p className="empty-hint">Every run is already in a client space.</p>
        ) : (
          <>
            <div className="admin-move-toolbar">
              <label className="admin-field">
                <span className="search-label">Find a run</span>
                <input
                  className="search-input"
                  value={runQuery}
                  onChange={(e) => setRunQuery(e.target.value)}
                  placeholder="Client, keyword, or owner"
                />
              </label>
              <label className="admin-field">
                <span className="search-label">Move selected into</span>
                <select
                  className="search-input"
                  value={moveTarget}
                  onChange={(e) => setMoveTarget(e.target.value)}
                >
                  <option value="">Choose a client space</option>
                  {spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.clientName}
                      {space.ownerDisplayName
                        ? ` — owned by ${space.ownerDisplayName}`
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="search-btn"
                disabled={!moveTarget || selectedRuns.length === 0 || busyId === "move"}
                onClick={() =>
                  void act(
                    {
                      action: "move-runs",
                      spaceId: moveTarget,
                      runs: selectedRuns.map((key) => {
                        const [kind, id] = key.split(":");
                        return { kind, id };
                      }),
                    },
                    "move",
                  )
                }
              >
                Move {selectedRuns.length || 0} run
                {selectedRuns.length === 1 ? "" : "s"}
              </button>
            </div>
            <UnassignedRuns
              runs={unassigned}
              query={runQuery}
              selected={selectedRuns}
              onSelected={setSelectedRuns}
            />
          </>
        )}
      </section>
    </>
  );
}

function UnassignedRuns({
  runs,
  query,
  selected,
  onSelected,
}: {
  runs: UnassignedRun[];
  query: string;
  selected: string[];
  onSelected: (next: string[]) => void;
}) {
  const needle = query.trim().toLowerCase();
  const visible = runs.filter((run) => {
    if (!needle) return true;
    const owner = `${run.ownerDisplayName ?? ""} ${run.ownerUsername ?? ""}`;
    return `${run.title} ${run.kind} ${owner}`.toLowerCase().includes(needle);
  });
  const visibleKeys = visible.map((run) => `${run.kind}:${run.id}`);
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selected.includes(key));

  return (
    <>
      <div className="admin-run-tools">
        <label className="admin-checkbox">
          <input
            type="checkbox"
            checked={allVisibleSelected}
            onChange={(e) =>
              onSelected(
                e.target.checked
                  ? [...new Set([...selected, ...visibleKeys])]
                  : selected.filter((key) => !visibleKeys.includes(key)),
              )
            }
          />
          <span>
            Select shown ({visible.length} of {runs.length})
          </span>
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="empty-hint">No runs match that search.</p>
      ) : (
        <ul className="admin-run-list">
          {visible.map((run) => {
            const key = `${run.kind}:${run.id}`;
            const owner = run.ownerDisplayName
              ? `${run.ownerDisplayName}${run.ownerUsername ? ` (@${run.ownerUsername})` : ""}`
              : "No owner";
            return (
              <li key={key}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(key)}
                    onChange={(e) =>
                      onSelected(
                        e.target.checked
                          ? [...selected, key]
                          : selected.filter((item) => item !== key),
                      )
                    }
                  />
                  <span>
                    <strong>{run.title}</strong>
                    <span className="muted">
                      {run.kind === "search" ? "Search" : "Lookup"} · {owner} ·{" "}
                      {formatDate(run.updatedAt)}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
