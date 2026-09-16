"use client";

import { useState } from "react";
import type { UnifiedHistoryItem } from "@/lib/historyUnified";

interface UnifiedHistoryPanelProps {
  runs: UnifiedHistoryItem[];
  selectedId: string | null;
  selectedKind: "search" | "lookup" | null;
  onSelect: (run: UnifiedHistoryItem) => void;
  onDelete: (run: UnifiedHistoryItem) => void;
  onClearAll?: () => void;
  loading?: boolean;
  deletingId?: string | null;
  filterKind?: "all" | "search" | "lookup";
  onFilterKind?: (k: "all" | "search" | "lookup") => void;
  spaceId?: string | null;
  spaceName?: string | null;
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function UnifiedHistoryPanel({
  runs,
  selectedId,
  selectedKind,
  onSelect,
  onDelete,
  onClearAll,
  loading,
  deletingId,
  filterKind = "all",
  onFilterKind,
  spaceId = null,
  spaceName = null,
}: UnifiedHistoryPanelProps) {
  const [showEverySpace, setShowEverySpace] = useState(false);

  if (loading) {
    return <p className="empty-hint">Loading history…</p>;
  }

  const kindFiltered =
    filterKind === "all" ? runs : runs.filter((r) => r.kind === filterKind);
  const filtered =
    spaceId && !showEverySpace
      ? kindFiltered.filter((r) => r.spaceId === spaceId)
      : kindFiltered;

  // "Shared With Me" is kept visually separate from the user's own projects.
  const mine = filtered.filter((r) => r.accessRole !== "editor" && r.accessRole !== "viewer");
  const shared = filtered.filter(
    (r) => r.accessRole === "editor" || r.accessRole === "viewer",
  );

  const groups = (items: UnifiedHistoryItem[]) => {
    const map = new Map<string, UnifiedHistoryItem[]>();
    for (const item of items) {
      const key = item.clientName || "No client space";
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  };

  const renderList = (items: UnifiedHistoryItem[]) => (
    <ul className="history-list">
      {items.map((run) => {
        const active = run.id === selectedId && run.kind === selectedKind;
        const deleting = deletingId === `${run.kind}:${run.id}`;
        const isShared =
          run.accessRole === "editor" || run.accessRole === "viewer";
        return (
          <li
            key={`${run.kind}-${run.id}`}
            className={`history-item ${active ? "active" : ""}`}
          >
            <button
              type="button"
              className="history-item-main"
              onClick={() => onSelect(run)}
            >
              <div className="history-item-top">
                <strong className="history-keyword">{run.title}</strong>
                <span className={`status-pill status-${run.status}`}>
                  {run.status}
                </span>
              </div>
              <div className="history-item-meta">
                <span className="platform-pill">{run.platformLabel}</span>
                <span className="kind-pill">
                  {run.kind === "search" ? "Search" : "Lookup"}
                </span>
                {isShared ? (
                  <span className="kind-pill share-pill">
                    {run.accessRole === "viewer" ? "View only" : "Can edit"}
                    {run.ownerDisplayName ? ` · ${run.ownerDisplayName}` : ""}
                  </span>
                ) : null}
                <span>{formatDate(run.createdAt)}</span>
                <span>
                  {run.count} {run.countLabel}
                </span>
                {run.subtitle && <span>{run.subtitle}</span>}
              </div>
            </button>
            {isShared ? null : (
              <button
                type="button"
                className="history-delete"
                disabled={deleting}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete this ${run.kind} run?`)) {
                    onDelete(run);
                  }
                }}
              >
                {deleting ? "…" : "Delete"}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="history-list-wrap">
      <div className="history-actions history-actions-bar">
        {onFilterKind && (
          <div className="kind-filters">
            {(["all", "search", "lookup"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={`chip-btn ${filterKind === k ? "active" : ""}`}
                onClick={() => onFilterKind(k)}
              >
                {k === "all" ? "All" : k === "search" ? "Searches" : "Lookups"}
              </button>
            ))}
          </div>
        )}
        {onClearAll && (
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (
                window.confirm(
                  "Delete ALL of your own search and lookup history? Projects shared with you are not affected.",
                )
              ) {
                onClearAll();
              }
            }}
          >
            Clear all
          </button>
        )}
      </div>

      {spaceId ? (
        <div className="history-space-scope">
          <p className="form-hint">
            {showEverySpace
              ? "Showing history from every client space."
              : `Showing history in ${spaceName || "this client space"}.`}
          </p>
          <button
            type="button"
            className="chip-btn"
            onClick={() => setShowEverySpace((on) => !on)}
          >
            {showEverySpace ? "This client only" : "Every client"}
          </button>
        </div>
      ) : null}

      {filtered.length === 0 ? (
        <p className="empty-hint">
          {spaceId && !showEverySpace
            ? "No history in this client space yet. New searches and lookups will appear here."
            : "No history yet for this filter."}
        </p>
      ) : (
        <>
          <h3 className="history-group-head">My client spaces</h3>
          {mine.length === 0 ? (
            <p className="empty-hint">
              You have not run any projects yet for this filter.
            </p>
          ) : (
            groups(mine).map(([name, items]) => (
              <div key={name}>
                <h4 className="history-space-head">{name}</h4>
                {renderList(items)}
              </div>
            ))
          )}

          {shared.length > 0 ? (
            <>
              <h3 className="history-group-head">Shared with me</h3>
              {groups(shared).map(([name, items]) => (
                <div key={`shared-${name}`}>
                  <h4 className="history-space-head">{name}</h4>
                  {renderList(items)}
                </div>
              ))}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
