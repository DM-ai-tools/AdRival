"use client";

import { useState } from "react";
import type { JobProgress, JobStatus } from "@/lib/types";

interface ProgressPanelProps {
  keyword: string;
  status: JobStatus | null;
  progress: JobProgress | null;
  stopJobId?: string | null;
  onStop?: () => void;
}

export function ProgressPanel({
  keyword,
  status,
  progress,
  stopJobId,
  onStop,
}: ProgressPanelProps) {
  const [stopping, setStopping] = useState(false);
  if (!status || !progress) return null;

  const brandActive = progress.stage === "brand_review";
  const offersActive = progress.stage === "analyzing_offers";
  const canStop =
    Boolean(stopJobId) &&
    (status === "running" || brandActive || offersActive);

  async function stopRun() {
    if (!stopJobId) return;
    setStopping(true);
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: stopJobId }),
      });
      onStop?.();
    } finally {
      setStopping(false);
    }
  }

  const brandTotal = Math.max(
    progress.brandReviewTotal || 0,
    progress.accepted || 0,
    1,
  );
  const brandDone = progress.brandReviewDone ?? 0;

  const pct = brandActive
    ? Math.min(100, Math.round((brandDone / brandTotal) * 100))
    : Math.min(
        100,
        Math.round((progress.accepted / Math.max(progress.target, 1)) * 100),
      );

  const reasons = progress.rejectReasons;
  const displayStatus = brandActive ? "brand_review" : status;

  return (
    <section
      className={`progress-panel ${brandActive ? "progress-panel-brand" : ""}`}
    >
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
          <span className={`status-pill status-${displayStatus}`}>
            {brandActive ? "BRAND REVIEW" : status}
          </span>
        </div>
      </div>
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill ${brandActive ? "progress-bar-brand" : ""}`}
          style={{ width: `${brandActive && pct < 8 ? 8 : pct}%` }}
        />
      </div>
      <p className="progress-message">{progress.message}</p>
      {brandActive && (
        <div className="brand-review-inline">
          <span>
            Reviewing {brandDone}/{brandTotal}
            {progress.brandReviewCurrentName
              ? ` · ${progress.brandReviewCurrentName}`
              : ""}
          </span>
        </div>
      )}
      <dl className="progress-stats">
        <div>
          <dt>Accepted</dt>
          <dd>
            {progress.accepted}/{progress.target}
          </dd>
        </div>
        <div>
          <dt>Ads scanned</dt>
          <dd>{progress.scannedAds}</dd>
        </div>
        <div>
          <dt>Pages</dt>
          <dd>{progress.scannedPages}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{progress.rejected}</dd>
        </div>
        <div>
          <dt>Stage</dt>
          <dd>{progress.stage}</dd>
        </div>
      </dl>
      {reasons && (
        <dl className="progress-stats reason-stats">
          <div>
            <dt>Short duration</dt>
            <dd>{reasons.shortDuration}</dd>
          </div>
          <div>
            <dt>No service signal</dt>
            <dd>{reasons.noServiceSignal}</dd>
          </div>
          <div>
            <dt>Non-English</dt>
            <dd>{reasons.nonEnglish ?? 0}</dd>
          </div>
          <div>
            <dt>No landing page</dt>
            <dd>{reasons.noLandingPage ?? 0}</dd>
          </div>
          <div>
            <dt>Relevance reject</dt>
            <dd>{reasons.llmReject}</dd>
          </div>
          <div>
            <dt>SOP guardrail</dt>
            <dd>{reasons.guardrailReject ?? 0}</dd>
          </div>
          <div>
            <dt>Relevance error</dt>
            <dd>{reasons.llmError}</dd>
          </div>
          <div>
            <dt>Low active ads</dt>
            <dd>{reasons.lowActiveAds}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
