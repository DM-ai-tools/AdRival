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
      <div className="history-item">
        <p className="empty-hint">Pick a page to recreate</p>
      </div>
    );
  }

  const pct = item.progress?.pct ?? 0;
  const jobId = item.jobId;
  return (
    <div className="history-item">
      <div className="history-item-main">
        <div className="history-item-top">
          <strong className="history-keyword">{item.businessName || item.sourceName || item.sourceUrl || "Recreating"}</strong>
          <span className="status-pill status-running">Running</span>
        </div>
        {item.sourceUrl ? (
          <div className="history-item-meta">
            <span>{item.sourceUrl}</span>
          </div>
        ) : null}
        <div className="history-item-meta">
          <span>Days running: {formatSignal(item.daysRunning)}</span>
          <span>Active ads: {formatSignal(item.activeAds)}</span>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          style={{ height: 6, borderRadius: 3, background: "var(--line)", overflow: "hidden", margin: "8px 0 4px" }}
        >
          <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent, currentColor)" }} />
        </div>
        <div className="history-item-meta">
          <span>
            {item.progress?.message || "Working"} · {pct}%
          </span>
        </div>
      </div>
      <div className="history-actions">
        <Link href={hubOpenHref(item.openPath)} className="chip-btn">
          Open
        </Link>
        {jobId && onStop ? (
          <button
            type="button"
            className="history-delete"
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
