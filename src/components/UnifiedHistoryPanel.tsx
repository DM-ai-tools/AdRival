"use client";

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
}: UnifiedHistoryPanelProps) {
  if (loading) {
    return <p className="empty-hint">Loading history…</p>;
  }

  const filtered =
    filterKind === "all" ? runs : runs.filter((r) => r.kind === filterKind);

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
                  "Delete ALL search and lookup history across every platform?",
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

      {filtered.length === 0 ? (
        <p className="empty-hint">No history yet for this filter.</p>
      ) : (
        <ul className="history-list">
          {filtered.map((run) => {
            const active =
              run.id === selectedId && run.kind === selectedKind;
            const deleting = deletingId === `${run.kind}:${run.id}`;
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
                    <span>{formatDate(run.createdAt)}</span>
                    <span>
                      {run.count} {run.countLabel}
                    </span>
                    {run.subtitle && <span>{run.subtitle}</span>}
                  </div>
                </button>
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
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
