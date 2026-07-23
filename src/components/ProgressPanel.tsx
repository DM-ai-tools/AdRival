"use client";

import type { JobProgress, JobStatus } from "@/lib/types";

interface ProgressPanelProps {
  keyword: string;
  status: JobStatus | null;
  progress: JobProgress | null;
}

export function ProgressPanel({
  keyword,
  status,
  progress,
}: ProgressPanelProps) {
  if (!status || !progress) return null;

  const pct = Math.min(
    100,
    Math.round((progress.accepted / Math.max(progress.target, 1)) * 100),
  );

  const reasons = progress.rejectReasons;

  return (
    <section className="progress-panel">
      <div className="progress-head">
        <h2>Run: {keyword}</h2>
        <span className={`status-pill status-${status}`}>{status}</span>
      </div>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="progress-message">{progress.message}</p>
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
            <dt>LLM reject</dt>
            <dd>{reasons.llmReject}</dd>
          </div>
          <div>
            <dt>LLM error</dt>
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
