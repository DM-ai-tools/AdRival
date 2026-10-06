"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_SEARCH_PAGES, type JobProgress, type JobStatus } from "@/lib/types";
import {
  STALLED_AFTER_MS,
  formatDuration,
  stageLabel,
  statusLabel,
} from "@/lib/progressLabels";

interface ProgressPanelProps {
  keyword: string;
  status: JobStatus | null;
  progress: JobProgress | null;
  /** Run start and last update, for elapsed time and the stalled warning. */
  createdAt?: string | null;
  updatedAt?: string | null;
  stopJobId?: string | null;
  onStop?: () => void;
  /** Start the same search again with the inputs this run used. */
  onRunAgain?: () => void;
  runAgainBusy?: boolean;
  /** What to do after a search finishes: go to the offers dashboard or the competitor list. */
}

const REASON_LABELS: Array<[keyof NonNullable<JobProgress["rejectReasons"]>, string]> = [
  ["llmReject", "Not relevant"],
  ["lowActiveAds", "Too few active ads"],
  ["shortDuration", "Ads too new"],
  ["noLandingPage", "No landing page"],
  ["noServiceSignal", "Service not mentioned"],
  ["nonEnglish", "Not in English"],
  ["guardrailReject", "Blocked by industry rules"],
  ["llmError", "Could not be checked"],
  ["noReadableCopy", "Ad text could not be read"],
  ["noAdsInRegion", "Sites with no Google ads in this country"],
  ["notCompetitorSite", "Search results that are not competitors"],
];

const RECENT_LIMIT = 5;

export function ProgressPanel({
  keyword,
  status,
  progress,
  createdAt,
  updatedAt,
  stopJobId,
  onStop,
  onRunAgain,
  runAgainBusy,
}: ProgressPanelProps) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [showReasons, setShowReasons] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [recent, setRecent] = useState<string[]>([]);
  const lastMessage = useRef<string | null>(null);

  const brandActive = progress?.stage === "brand_review";
  const offersActive = progress?.stage === "analyzing_offers";
  const working = status === "running" || brandActive || offersActive;

  // Tick once a second while working so elapsed time stays current.
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [working]);

  // Keep a short list of recent activity from the messages the poll returns.
  const message = progress?.message || "";
  useEffect(() => {
    if (!message || message === lastMessage.current) return;
    lastMessage.current = message;
    setRecent((prev) => [message, ...prev.filter((m) => m !== message)].slice(0, RECENT_LIMIT));
  }, [message]);

  if (!status || !progress) return null;

  const canStop = Boolean(stopJobId) && working;

  async function stopRun() {
    if (!stopJobId) return;
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: stopJobId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "The run could not be stopped. Try again.");
      }
      onStop?.();
    } catch (err) {
      setStopError((err as Error).message);
    } finally {
      setStopping(false);
    }
  }

  const brandTotal = Math.max(progress.brandReviewTotal || 0, progress.accepted || 0, 1);
  const brandDone = progress.brandReviewDone ?? 0;

  // Searching: count pages scanned as well as competitors found, so the bar
  // moves before the first competitor is accepted.
  const searchPct = Math.max(
    (progress.accepted / Math.max(progress.target, 1)) * 100,
    (progress.scannedPages / MAX_SEARCH_PAGES) * 90,
  );
  const pct = brandActive
    ? Math.min(100, Math.round((brandDone / brandTotal) * 100))
    : status === "running"
      ? Math.min(99, Math.round(searchPct))
      : status === "failed"
        ? Math.min(100, Math.round(searchPct))
        : 100;

  const started = createdAt ? Date.parse(createdAt) : NaN;
  const lastUpdate = updatedAt ? Date.parse(updatedAt) : NaN;
  const elapsed = Number.isFinite(started) ? now - started : null;
  const stalled =
    working && Number.isFinite(lastUpdate) && now - lastUpdate > STALLED_AFTER_MS;

  // Rough time left once a few competitors are in.
  let remaining: number | null = null;
  if (status === "running" && !brandActive && elapsed && progress.accepted >= 2) {
    const perCompetitor = elapsed / progress.accepted;
    remaining = perCompetitor * Math.max(progress.target - progress.accepted, 0);
  }

  const reasons = progress.rejectReasons;
  const reasonRows = reasons
    ? REASON_LABELS.map(([key, label]) => [label, Number(reasons[key] ?? 0)] as const).filter(
        ([, n]) => n > 0,
      )
    : [];
  const displayStatus = brandActive ? "brand_review" : status;
  const finished = !working;

  return (
    <section className={`progress-panel ${brandActive ? "progress-panel-brand" : ""}`}>
      <div className="progress-head">
        <h2>Run: {keyword}</h2>
        <div className="progress-head-actions">
          {canStop ? (
            <button
              type="button"
              className="danger-btn"
              disabled={stopping}
              onClick={() => void stopRun()}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          {finished && onRunAgain ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={runAgainBusy}
              onClick={onRunAgain}
            >
              {runAgainBusy ? "Starting…" : "Run again"}
            </button>
          ) : null}
          <span className={`status-pill status-${displayStatus}`}>
            {statusLabel(displayStatus)}
          </span>
        </div>
      </div>
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${brandActive ? "progress-bar-brand" : ""} ${
            status === "failed" && !working ? "progress-bar-failed" : ""
          }`}
          style={{ width: `${working && pct < 4 ? 4 : pct}%` }}
        />
      </div>
      <p className="progress-message">
        <strong>{stageLabel(progress.stage)}</strong>
        {progress.message ? ` · ${progress.message}` : ""}
      </p>
      {working ? (
        <p className="progress-hint">
          This keeps running if you leave the page. You can reopen it any time from History.
        </p>
      ) : null}
      {finished && progress.accepted === 0 ? (
        <div className="progress-next is-empty" role="note">
          <p>
            <strong>No competitors found.</strong> Try broader keywords, search the whole country instead of set
            locations, or switch off industry rules in the search form, then run again.
          </p>
        </div>
      ) : null}
      {working && elapsed !== null ? (
        <p className="progress-timing">
          Running for {formatDuration(elapsed)}
          {remaining !== null && remaining > 0
            ? `, about ${formatDuration(remaining)} left`
            : ""}
        </p>
      ) : null}
      {stalled ? (
        <p className="progress-stalled" role="status">
          No progress for {formatDuration(now - lastUpdate)}. It may be on a slow step. If it
          doesn&apos;t move soon, stop it and run it again.
        </p>
      ) : null}
      {stopError ? (
        <p className="error-text" role="alert">
          {stopError}
        </p>
      ) : null}
      {brandActive && (
        <div className="brand-review-inline">
          <span>
            Reviewing {brandDone}/{brandTotal}
            {progress.brandReviewCurrentName ? ` · ${progress.brandReviewCurrentName}` : ""}
          </span>
        </div>
      )}
      <dl className="progress-stats">
        <div>
          <dt>Competitors found</dt>
          <dd>
            {progress.accepted}/{progress.target}
          </dd>
        </div>
        <div>
          <dt>Ads scanned</dt>
          <dd>{progress.scannedAds}</dd>
        </div>
        <div>
          <dt>Pages read</dt>
          <dd>{progress.scannedPages}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{progress.rejected}</dd>
        </div>
      </dl>
      {reasonRows.length ? (
        <div className="progress-reasons">
          <button
            type="button"
            className="link-btn"
            aria-expanded={showReasons}
            onClick={() => setShowReasons((v) => !v)}
          >
            {showReasons ? "Hide why ads were rejected" : "Why were ads rejected?"}
          </button>
          {showReasons ? (
            <dl className="progress-stats reason-stats">
              {reasonRows.map(([label, n]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{n}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      ) : null}
      {working && recent.length > 1 ? (
        <div className="progress-recent">
          <h3>Recent activity</h3>
          <ol>
            {recent.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
