"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

export const SPACE_EVENT = "adrival-space-change";

export interface SpaceSelection {
  id: string;
  clientName: string;
  role: "owner" | "editor" | "viewer" | "";
}

export interface ClientSpaceOption {
  id: string;
  clientName: string;
  accessRole: "owner" | "editor" | "viewer";
  ownerDisplayName: string | null;
  runCount: number;
}

function publish(space: ClientSpaceOption | undefined) {
  const detail: SpaceSelection = space
    ? {
        id: space.id,
        clientName: space.clientName,
        role: space.accessRole,
      }
    : { id: "", clientName: "", role: "" };
  window.dispatchEvent(new CustomEvent(SPACE_EVENT, { detail }));
}

/** View-only spaces can be opened in history, but cannot start a paid run. */
export function runnableSpaceId(
  detail: string | SpaceSelection | null | undefined,
): string | null {
  if (!detail) return null;
  if (typeof detail === "string") return detail || null;
  if (!detail.id || detail.role === "viewer") return null;
  return detail.id;
}

function storageKey(userId: string) {
  return `adrival.space.${userId}`;
}

export function readSelectedSpaceId(userId: string | null): string | null {
  if (!userId || typeof window === "undefined") return null;
  return window.localStorage.getItem(storageKey(userId));
}

export function ClientSpaceBar() {
  const [userId, setUserId] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<ClientSpaceOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [clientName, setClientName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string | null) => {
    const res = await fetch("/api/projects/spaces", { cache: "no-store" });
    if (!res.ok) return;
    const json = await res.json();
    const next = (json.spaces ?? []) as ClientSpaceOption[];
    setSpaces(next);
    const saved = next.find((space) => space.id === readSelectedSpaceId(id));
    const fallback =
      next.find((space) => space.accessRole !== "viewer") ?? next[0];
    const chosen = saved ?? fallback;
    setSelectedId(chosen?.id ?? "");
    if (id && chosen) window.localStorage.setItem(storageKey(id), chosen.id);
    publish(chosen);
  }, []);

  useEffect(() => {
    void fetch("/api/auth/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { user?: { id?: string } | null }) => {
        const id = data.user?.id ?? null;
        setUserId(id);
        return load(id);
      })
      .catch(() => setSpaces([]));
  }, [load]);

  function choose(id: string) {
    setSelectedId(id);
    if (userId) window.localStorage.setItem(storageKey(userId), id);
    publish(spaces.find((space) => space.id === id));
  }

  async function createSpace(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not create the space");
      setClientName("");
      if (userId) window.localStorage.setItem(storageKey(userId), json.space.id);
      await load(userId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  const selected = spaces.find((space) => space.id === selectedId);

  return (
    <section className="panel glow-panel client-space-bar">
      <div className="client-space-row">
        <label className="admin-field">
          <span className="search-label">Client space</span>
          <select
            className="search-input"
            value={selectedId}
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Choose a client</option>
            {spaces.map((space) => (
              <option key={space.id} value={space.id}>
                {space.clientName}
                {space.accessRole === "owner"
                  ? ""
                  : space.accessRole === "editor"
                    ? " (shared, can run)"
                    : " (view only)"}
                {space.ownerDisplayName ? ` · ${space.ownerDisplayName}` : ""}
                {` · ${space.runCount} runs`}
              </option>
            ))}
          </select>
        </label>
        <form className="client-space-create" onSubmit={(e) => void createSpace(e)}>
          <label className="admin-field">
            <span className="search-label">New client</span>
            <input
              className="search-input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Client name"
            />
          </label>
          <button type="submit" className="chip-btn" disabled={creating || clientName.trim().length < 2}>
            {creating ? "Creating…" : "Create space"}
          </button>
        </form>
      </div>
      <p className="form-hint">
        {selected?.accessRole === "viewer"
          ? `${selected.clientName} is shared with you as view only. You can open its history, but new tasks need a space you own or can edit.`
          : selected
            ? `New searches and lookups are saved under ${selected.clientName}. History for this client stays together. An admin can share or delete the whole space.`
            : "Create a client space first. Each client keeps its own history."}
      </p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
