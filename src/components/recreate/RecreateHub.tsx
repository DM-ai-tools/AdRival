"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { STATE_PILL_CLASS, filterBySource, hubOpenHref, sourceFilterName, splitItems } from "@/lib/recreateHubState";
import type { RecreateListItem } from "@/lib/recreateList";
import { stageNameText } from "@/lib/export/levelLabels";
import { styleLabel } from "@/lib/recreateClient";
import { SlotCard } from "./SlotCard";
import type { useRecreateJobs } from "./useRecreateJobs";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

const STATE_LABEL: Record<RecreateListItem["state"], string> = {
  queued: "Queued",
  running: "Running",
  finished: "Finished",
  failed: "Failed",
  stopped: "Stopped",
};

/** A website as a short label: host and path, no scheme or trailing slash. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

type PreviewState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; html: string };

/**
 * The page's HTML, fetched when the row is expanded. Its scripts run (pages
 * built with JavaScript would show blank otherwise) in an opaque origin: no
 * allow-same-origin, so they cannot reach this app's cookies or storage, and
 * no popups, forms or top navigation.
 */
function Preview({ competitorId }: { competitorId: string }) {
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    const set = (next: PreviewState) => {
      if (!cancelled) setState(next);
    };
    void (async () => {
      try {
        const res = await fetch(`/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`, {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
          competitor?: { recreatedPage?: { html?: string | null } | null } | null;
        };
        if (res.status === 503 || data.code === "archive_unavailable") {
          set({ kind: "error", message: data.error || "This archived page could not be loaded, try again" });
          return;
        }
        if (!res.ok) {
          set({ kind: "error", message: data.error || "Could not load this page." });
          return;
        }
        const html = data.competitor?.recreatedPage?.html;
        set(html ? { kind: "ready", html } : { kind: "error", message: "This page has no preview yet." });
      } catch {
        set({ kind: "error", message: "Could not load this page." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [competitorId]);

  if (state.kind === "loading") return <p className="empty-hint">Loading preview…</p>;
  if (state.kind === "error") return <p className="error-text">{state.message}</p>;
  return (
    <iframe
      title="Recreated page preview"
      srcDoc={state.html}
      sandbox="allow-scripts"
      style={{ width: "100%", height: 480, border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}
    />
  );
}

function VersionRow({ item }: { item: RecreateListItem }) {
  const [open, setOpen] = useState(false);
  const stage = item.targetIcp ? stageNameText(item.targetIcp.stage) || item.targetIcp.stage : "";
  return (
    <li className="history-item">
      <div className="history-item-main">
        <div className="history-item-top">
          <strong className="history-keyword">{item.businessName || item.sourceName || "Recreated page"}</strong>
          <span className={`status-pill ${STATE_PILL_CLASS[item.state]}`}>
            {STATE_LABEL[item.state]}
          </span>
        </div>
        <div className="history-item-meta">
          {item.businessUrl ? <span title={item.businessUrl}>For {shortUrl(item.businessUrl)}</span> : null}
          {item.sourceUrl ? <span>{item.sourceUrl}</span> : null}
        </div>
        <div className="history-item-meta">
          <span>Keyword: {item.keyword || "—"}</span>
          <span>Look: {styleLabel(item.styleDirection) || "—"}</span>
          <span>Audience stage: {stage || "—"}</span>
          <span>{formatDate(item.createdAt)}</span>
        </div>
        {item.error && (item.state === "failed" || item.state === "stopped") ? (
          <p className="error-text">{item.error}</p>
        ) : null}
        {item.notice && item.state !== "failed" && item.state !== "stopped" ? (
          <p className="muted">{item.notice}</p>
        ) : null}
        {open ? <Preview competitorId={item.competitorId} /> : null}
      </div>
      <div className="history-actions">
        {item.hasPage ? (
          <button type="button" className="chip-btn" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide preview" : "Preview"}
          </button>
        ) : null}
        <Link href={hubOpenHref(item.openPath)} className="chip-btn">
          Open
        </Link>
      </div>
    </li>
  );
}

/**
 * The Recreate tab: slots for pages being built, the queue, and the versions
 * made. `sourceFilter` (?page=) narrows the versions to one source page's.
 */
export function RecreateHub({
  jobs,
  sourceFilter = null,
  onClearSourceFilter,
}: {
  jobs: ReturnType<typeof useRecreateJobs>;
  sourceFilter?: string | null;
  onClearSourceFilter?: () => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const { slots, queue, recent, archived } = useMemo(() => splitItems(jobs.items), [jobs.items]);

  if (jobs.loading && jobs.items.length === 0) {
    return <p className="empty-hint">Loading recreated pages…</p>;
  }

  // Extra running items (e.g. from the old route) stay visible, so slots can pass the limit.
  const emptySlots = Math.max(0, jobs.limit - slots.length);
  const versions = filterBySource(showArchived ? archived : recent, sourceFilter);

  return (
    <div className="history-list-wrap">
      {jobs.error ? <p className="error-text">{jobs.error}</p> : null}
      {jobs.stopError ? (
        <p className="error-text" role="alert">
          {jobs.stopError}
        </p>
      ) : null}

      <h3>Building now</h3>
      <ul className="history-list">
        {slots.map((item) => (
          <li key={item.id}>
            <SlotCard item={item} onStop={jobs.stop} />
          </li>
        ))}
        {Array.from({ length: emptySlots }, (_, n) => (
          <li key={`empty-${n}`}>
            <SlotCard item={null} />
          </li>
        ))}
      </ul>

      {queue.length > 0 ? (
        <>
          <h3>Queued</h3>
          <ul className="history-list">
            {queue.map((item, n) => {
              const jobId = item.jobId;
              return (
                <li key={item.id} className="history-item">
                  <div className="history-item-main">
                    <div className="history-item-top">
                      <strong className="history-keyword">
                        {n + 1}. {item.businessName || item.sourceName || item.sourceUrl || "Queued page"}
                      </strong>
                      <span className={`status-pill ${STATE_PILL_CLASS.queued}`}>Queued</span>
                    </div>
                    {item.sourceUrl ? (
                      <div className="history-item-meta">
                        <span>{item.sourceUrl}</span>
                      </div>
                    ) : null}
                  </div>
                  {jobId ? (
                    <button
                      type="button"
                      className="history-delete"
                      disabled={removing === jobId}
                      onClick={async () => {
                        setRemoving(jobId);
                        try {
                          await jobs.stop(jobId);
                        } finally {
                          setRemoving(null);
                        }
                      }}
                    >
                      {removing === jobId ? "…" : "Remove"}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <div className="history-actions history-actions-bar">
        <h3>Versions</h3>
        <div className="kind-filters">
          <button type="button" className={`chip-btn ${!showArchived ? "active" : ""}`} onClick={() => setShowArchived(false)}>
            Recent
          </button>
          <button type="button" className={`chip-btn ${showArchived ? "active" : ""}`} onClick={() => setShowArchived(true)}>
            Archived
          </button>
        </div>
      </div>
      {sourceFilter ? (
        <p className="history-item-meta" role="status">
          <span>Showing versions of {sourceFilterName(jobs.items, sourceFilter)}</span>
          {onClearSourceFilter ? (
            <button type="button" className="chip-btn" onClick={onClearSourceFilter}>
              Show all
            </button>
          ) : null}
        </p>
      ) : null}
      {versions.length === 0 ? (
        <p className="empty-hint">
          {sourceFilter
            ? showArchived
              ? "No archived versions of this page."
              : "No versions of this page here yet. Pages still building or queued are shown above."
            : showArchived
              ? "No archived pages."
              : "No recreated pages yet."}
        </p>
      ) : (
        <ul className="history-list">
          {versions.map((item) => (
            <VersionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
