"use client";

import Link from "next/link";
import { useState } from "react";
import type { RecreateListItem } from "@/lib/recreateList";
import { formatSignal } from "@/lib/recreateSignals";
import { hubOpenHref } from "@/lib/recreateHubState";

/** One of the Recreate tab's slots: a page being built, or an empty slot. */
export function SlotCard({
  item,
  onStop,
}: {
  item: RecreateListItem | null;
  onStop?: (jobId: string) => Promise<void>;
}) {
  const [stopping, setStopping] = useState(false);

  if (!item) {
    return (
      <div className="recreate-card recreate-slot recreate-slot-empty">
        <span>Pick a page to recreate</span>
      </div>
    );
  }

  const pct = item.progress?.pct ?? 0;
  const jobId = item.jobId;
  const message = item.progress?.message || "Working";
  return (
    <div className="recreate-card recreate-slot">
      <div className="recreate-card-top">
        <strong className="recreate-name">{item.businessName || item.sourceName || item.sourceUrl || "Recreating"}</strong>
        <span className="status-pill status-running">Running</span>
      </div>
      {item.sourceUrl ? (
        <span className="recreate-url" title={item.sourceUrl}>
          {item.sourceUrl}
        </span>
      ) : null}
      <dl className="recreate-stats">
        <div className="recreate-stat">
          <dt>Days running</dt>
          <dd>{formatSignal(item.daysRunning)}</dd>
        </div>
        <div className="recreate-stat">
          <dt>Active ads</dt>
          <dd>{formatSignal(item.activeAds)}</dd>
        </div>
      </dl>
      <div className="recreate-progress-row">
        <div className="recreate-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="recreate-pct">{pct}%</span>
      </div>
      <p className="recreate-message" title={message}>
        {message}
      </p>
      <div className="recreate-actions">
        <Link href={hubOpenHref(item.openPath)} className="chip-btn">
          Open
        </Link>
        {jobId && onStop ? (
          <button
            type="button"
            className="recreate-danger"
            disabled={stopping}
            onClick={async () => {
              setStopping(true);
              try {
                await onStop(jobId);
              } finally {
                setStopping(false);
              }
            }}
          >
            {stopping ? "…" : "Stop"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
