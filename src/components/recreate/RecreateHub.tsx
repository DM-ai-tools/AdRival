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

  if (state.kind === "loading") return <p className="recreate-preview-state">Loading preview…</p>;
  if (state.kind === "error") return <p className="recreate-preview-state is-error">{state.message}</p>;
  return (
    <iframe
      title="Recreated page preview"
      srcDoc={state.html}
      sandbox="allow-scripts"
    />
  );
}

function VersionRow({ item }: { item: RecreateListItem }) {
  const [open, setOpen] = useState(false);
  const metaLine = [item.businessUrl ? `For ${shortUrl(item.businessUrl)}` : "", item.sourceUrl || ""].filter(Boolean).join(" · ");
  const stage = item.targetIcp ? stageNameText(item.targetIcp.stage) || item.targetIcp.stage : "";
  return (
    <li className="recreate-card recreate-version">
      <div className="recreate-card-top">
        <strong className="recreate-name">{item.businessName || item.sourceName || "Recreated page"}</strong>
        <span className={`status-pill ${STATE_PILL_CLASS[item.state]}`}>{STATE_LABEL[item.state]}</span>
      </div>
      {item.businessUrl || item.sourceUrl ? (
        <span className="recreate-url" title={metaLine}>
          {metaLine}
        </span>
      ) : null}
      <dl className="recreate-meta-grid">
        <div>
          <dt className="recreate-label">Keyword</dt>
          <dd>{item.keyword || "—"}</dd>
        </div>
        <div>
          <dt className="recreate-label">Look</dt>
          <dd>{styleLabel(item.styleDirection) || "—"}</dd>
        </div>
        <div>
          <dt className="recreate-label">Audience stage</dt>
          <dd>{stage || "—"}</dd>
        </div>
        <div>
          <dt className="recreate-label">Created</dt>
          <dd>{formatDate(item.createdAt)}</dd>
        </div>
      </dl>
      {item.error && (item.state === "failed" || item.state === "stopped") ? (
        <p className="recreate-error">{item.error}</p>
      ) : null}
      {item.notice && item.state !== "failed" && item.state !== "stopped" ? (
        <p className="recreate-note">{item.notice}</p>
      ) : null}
      {open ? (
        <div className="recreate-preview">
          <Preview competitorId={item.competitorId} />
        </div>
      ) : null}
      <div className="recreate-actions">
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
    return <p className="recreate-state">Loading recreated pages…</p>;
  }

  // Extra running items (e.g. from the old route) stay visible, so slots can pass the limit.
  const emptySlots = Math.max(0, jobs.limit - slots.length);
  const versions = filterBySource(showArchived ? archived : recent, sourceFilter);

  return (
    <div className="recreate-hub">
      {jobs.error ? <p className="recreate-alert">{jobs.error}</p> : null}
      {jobs.stopError ? (
        <p className="recreate-alert" role="alert">
          {jobs.stopError}
        </p>
      ) : null}

      <section className="recreate-section">
      <h3 className="recreate-heading">Building now</h3>
      <ul className="recreate-slots">
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
      </section>

      {queue.length > 0 ? (
        <section className="recreate-section">
          <h3 className="recreate-heading">Queued</h3>
          <ul className="recreate-queue">
            {queue.map((item, n) => {
              const jobId = item.jobId;
              return (
                <li key={item.id} className="recreate-card recreate-queue-row">
                  <span className="recreate-queue-pos">{n + 1}</span>
                  <div className="recreate-queue-text">
                    <strong className="recreate-name">
                      {item.businessName || item.sourceName || item.sourceUrl || "Queued page"}
                    </strong>
                    {item.sourceUrl ? (
                      <span className="recreate-url" title={item.sourceUrl}>
                        {item.sourceUrl}
                      </span>
                    ) : null}
                  </div>
                  <span className={`status-pill ${STATE_PILL_CLASS.queued}`}>Queued</span>
                  {jobId ? (
                    <div className="recreate-actions">
                    <button
                      type="button"
                      className="recreate-danger"
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
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <div className="recreate-bar">
        <h3 className="recreate-heading">Versions</h3>
        <div className="recreate-seg">
          <button type="button" className={`chip-btn ${!showArchived ? "active" : ""}`} onClick={() => setShowArchived(false)}>
            Recent
          </button>
          <button type="button" className={`chip-btn ${showArchived ? "active" : ""}`} onClick={() => setShowArchived(true)}>
            Archived
          </button>
        </div>
      </div>
      {sourceFilter ? (
        <p className="recreate-notice" role="status">
          <span>Showing versions of {sourceFilterName(jobs.items, sourceFilter)}</span>
          {onClearSourceFilter ? (
            <button type="button" className="chip-btn" onClick={onClearSourceFilter}>
              Show all
            </button>
          ) : null}
        </p>
      ) : null}
      {versions.length === 0 ? (
        <p className="recreate-state">
          {sourceFilter
            ? showArchived
              ? "No archived versions of this page."
              : "No versions of this page here yet. Pages still building or queued are shown above."
            : showArchived
              ? "No archived pages."
              : "No recreated pages yet."}
        </p>
      ) : (
        <ul className="recreate-versions">
          {versions.map((item) => (
            <VersionRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}
