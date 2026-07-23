"use client";

import type { HistoryRunSummary } from "@/lib/types";

interface HistoryPanelProps {
  runs: HistoryRunSummary[];
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

export function HistoryPanel({
  runs,
  selectedRunId,
  onSelect,
  onDelete,
  onClearAll,
  loading,
  deletingId,
}: HistoryPanelProps) {
  if (loading) {
    return <p className="empty-hint">Loading history…</p>;
  }

  if (runs.length === 0) {
    return (
      <p className="empty-hint">
        No past runs yet. Start a search and finished results will appear here.
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
                  "Delete ALL history runs and free every saved competitor for rediscovery?",
                )
              ) {
                onClearAll();
              }
            }}
          >
            Clear all history
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
                  <strong className="history-keyword">{run.keyword}</strong>
                  <span className={`status-pill status-${run.status}`}>
                    {run.status}
                  </span>
                </div>
                <div className="history-item-meta">
                  <span>{formatDate(run.createdAt)}</span>
                  <span>
                    {run.competitorCount} competitor
                    {run.competitorCount === 1 ? "" : "s"}
                  </span>
                  <span>
                    {run.progress.accepted}/{run.progress.target} accepted
                  </span>
                </div>
              </button>
              <button
                type="button"
                className="history-delete"
                disabled={deleting}
                title="Delete this run (allows rediscovering these competitors)"
                onClick={(e) => {
                  e.stopPropagation();
                  if (
                    window.confirm(
                      `Delete run "${run.keyword}" and free its competitors for rediscovery?`,
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
