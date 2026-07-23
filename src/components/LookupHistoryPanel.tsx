"use client";

import type { LookupHistorySummary } from "@/lib/types";

interface LookupHistoryPanelProps {
  runs: LookupHistorySummary[];
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onDelete: (runId: string) => void;
  onClearAll?: () => void;
  loading?: boolean;
  deletingId?: string | null;
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

export function LookupHistoryPanel({
  runs,
  selectedRunId,
  onSelect,
  onDelete,
  onClearAll,
  loading,
  deletingId,
}: LookupHistoryPanelProps) {
  if (loading) {
    return <p className="empty-hint">Loading lookup history…</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="empty-hint">
        No competitor lookups yet. Use the Lookup tab to fetch a competitor&apos;s
        ads.
      </p>
    );
  }

  return (
    <div className="history-list-wrap">
      {onClearAll && (
        <div className="history-actions">
          <button
            type="button"
            className="danger-btn"
            onClick={() => {
              if (
                window.confirm(
                  "Delete ALL competitor lookup history and stored ads?",
                )
              ) {
                onClearAll();
              }
            }}
          >
            Clear all lookups
          </button>
        </div>
      )}
      <ul className="history-list">
        {runs.map((run) => {
          const active = run.id === selectedRunId;
          const deleting = deletingId === run.id;
          return (
            <li
              key={run.id}
              className={`history-item ${active ? "active" : ""}`}
            >
              <button
                type="button"
                className="history-item-main"
                onClick={() => onSelect(run.id)}
              >
                <div className="history-item-top">
                  <strong className="history-keyword">{run.queryName}</strong>
                  <span className={`status-pill status-${run.status}`}>
                    {run.status}
                  </span>
                </div>
                <div className="history-item-meta">
                  <span>{formatDate(run.createdAt)}</span>
                  <span>
                    {run.adCount} ad{run.adCount === 1 ? "" : "s"}
                  </span>
                  {run.selectedPage?.name && (
                    <span>Matched: {run.selectedPage.name}</span>
                  )}
                </div>
              </button>
              <button
                type="button"
                className="history-delete"
                disabled={deleting}
                title="Delete this lookup"
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      `Delete lookup for "${run.queryName}" and its ads?`,
                    )
                  ) {
                    onDelete(run.id);
                  }
                }}
              >
                {deleting ? "…" : "Delete"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
