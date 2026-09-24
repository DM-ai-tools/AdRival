"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BrandReview, CompetitorRecord, JobProgress } from "@/lib/types";
import { ConfirmDialog } from "./ConfirmDialog";

function fmtMetric(present: boolean, n?: number | null): string {
  if (!present) return "Not present";
  if (n == null) return "Unavailable";
  return n.toLocaleString();
}

function hasFacebook(b: BrandReview) {
  return Boolean(b.facebookUrl);
}
function hasInstagram(b: BrandReview) {
  return Boolean(b.instagramHandle);
}
function hasTwitter(b: BrandReview) {
  return Boolean(b.twitterHandle);
}
function hasYouTube(b: BrandReview) {
  return Boolean(b.youtubeUrl || b.youtubeHandle);
}
function hasLinkedIn(b: BrandReview) {
  return Boolean(b.linkedinUrl);
}

type SortKey =
  | "score"
  | "name"
  | "facebook"
  | "instagram"
  | "twitter"
  | "youtube"
  | "employees"
  | "linkedin"
  | "revenue";

function hasSizeSignal(b: BrandReview | undefined): boolean {
  if (!b) return false;
  return (
    b.facebookFollowers != null ||
    b.instagramFollowers != null ||
    b.twitterFollowers != null ||
    b.youtubeSubscribers != null ||
    b.linkedinFollowers != null ||
    b.linkedinEmployees != null ||
    Boolean(b.companyRevenue)
  );
}

function revenueSortValue(raw?: string | null): number | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/[$,]/g, " ");
  const unit = /\bbillion\b|\db\b/.test(text)
    ? 1e9
    : /\bmillion\b|\dm\b/.test(text)
      ? 1e6
      : /\bthousand\b|\dk\b/.test(text)
        ? 1e3
        : null;
  const nums = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  if (!nums.length || unit == null) return null;
  const scaled = nums.map((n) => n * unit);
  return scaled.length > 1 ? (scaled[0] + scaled[1]) / 2 : scaled[0];
}

function compareNullable(
  a: number | string | null,
  b: number | string | null,
  dir: 1 | -1,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return (a - b) * dir;
  return String(a).localeCompare(String(b)) * dir;
}

type LocalProgress = {
  done: number;
  total: number;
  currentName: string | null;
  message: string;
};

function SortHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: 1 | -1;
  onSort: (key: SortKey) => void;
}) {
  const active = activeKey === sortKey;
  return (
    <th aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={active ? "brand-sort-btn is-active" : "brand-sort-btn"}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {active ? (dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );
}

interface BrandReviewPanelProps {
  competitors: CompetitorRecord[];
  runId?: string | null;
  onCompetitorsUpdated?: (competitors: CompetitorRecord[]) => void;
  /** Live job progress (search run) so auto brand-review is visible here too */
  liveProgress?: JobProgress | null;
  showActions?: boolean;
}

export function BrandReviewPanel({
  competitors,
  runId,
  onCompetitorsUpdated,
  liveProgress = null,
  showActions = true,
}: BrandReviewPanelProps) {
  const [batchBusy, setBatchBusy] = useState(false);
  const [scoreBusy, setScoreBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRedoAll, setConfirmRedoAll] = useState(false);
  const [localProgress, setLocalProgress] = useState<LocalProgress | null>(
    null,
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autoScoreKey = useRef<string | null>(null);

  const resolvedRunId = runId || competitors[0]?.runId || null;

  const liveBrandActive = liveProgress?.stage === "brand_review";

  const displayProgress = useMemo(() => {
    if (localProgress) return localProgress;
    if (liveBrandActive && liveProgress) {
      return {
        done: liveProgress.brandReviewDone ?? 0,
        total:
          liveProgress.brandReviewTotal ??
          Math.max(competitors.length, liveProgress.accepted || 0),
        currentName: liveProgress.brandReviewCurrentName ?? null,
        message: liveProgress.message,
      };
    }
    return null;
  }, [localProgress, liveBrandActive, liveProgress, competitors.length]);

  const pct = displayProgress
    ? Math.min(
        100,
        Math.round(
          (displayProgress.done /
            Math.max(displayProgress.total || competitors.length || 1, 1)) *
            100,
        ),
      )
    : 0;

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      abortRef.current?.abort();
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling(jobId: string) {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(
          `/api/search/status?jobId=${encodeURIComponent(jobId)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const progress = data.job?.progress as JobProgress | undefined;
        if (progress) {
          setLocalProgress({
            done: progress.brandReviewDone ?? 0,
            total:
              progress.brandReviewTotal ??
              Math.max(competitors.length, progress.accepted || 0),
            currentName: progress.brandReviewCurrentName ?? null,
            message: progress.message || "Brand review in progress…",
          });
          if (
            progress.stage !== "brand_review" &&
            progress.stopRequested
          ) {
            setBatchBusy(false);
            setStopping(false);
          }
        }
        if (Array.isArray(data.competitors) && data.competitors.length) {
          onCompetitorsUpdated?.(data.competitors);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 1200);
  }

  async function stopBrandReview() {
    if (!resolvedRunId || stopping) return;
    setStopping(true);
    setError(null);
    abortRef.current?.abort();
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: resolvedRunId }),
      });
      setLocalProgress((prev) =>
        prev
          ? {
              ...prev,
              currentName: null,
              message: "Stopping brand review…",
            }
          : {
              done: 0,
              total: competitors.length,
              currentName: null,
              message: "Stopping brand review…",
            },
      );
    } catch (err) {
      setError((err as Error).message);
      setStopping(false);
    }
  }

  async function runBatch(force: boolean) {
    if (!resolvedRunId) return;
    setConfirmRedoAll(false);
    setBatchBusy(true);
    setStopping(false);
    setError(null);
    setLocalProgress({
      done: 0,
      total: competitors.length,
      currentName: null,
      message: force
        ? "Re-running brand review for all competitors…"
        : "Starting brand review…",
    });
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    startPolling(resolvedRunId);
    try {
      const res = await fetch("/api/competitors/brand-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: resolvedRunId, force }),
        signal: ac.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (ac.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || "Brand review failed");
      if (Array.isArray(data.competitors)) {
        onCompetitorsUpdated?.(data.competitors);
      }
      const wasStopped = Boolean(data.stopped);
      setLocalProgress({
        done: data.updated ?? competitors.length,
        total: competitors.length,
        currentName: null,
        message: wasStopped
          ? `Brand review stopped · ${data.updated ?? 0} updated`
          : force
            ? `Redo complete · ${data.updated ?? competitors.length} updated`
            : `Brand review complete · ${data.updated ?? competitors.length} updated`,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setLocalProgress({
          done: localProgress?.done ?? 0,
          total: competitors.length,
          currentName: null,
          message: "Brand review stopped",
        });
      } else {
        setError((err as Error).message);
        setLocalProgress(null);
      }
    } finally {
      stopPolling();
      setBatchBusy(false);
      setStopping(false);
      setConfirmRedoAll(false);
      window.setTimeout(() => setLocalProgress(null), 3500);
    }
  }

  async function redoOne(competitorId: string) {
    const name =
      competitors.find((c) => c.id === competitorId)?.pageName || "competitor";
    setRowBusy(competitorId);
    setError(null);
    setLocalProgress({
      done: 0,
      total: 1,
      currentName: name,
      message: `Re-scraping socials for ${name}…`,
    });
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/competitors/brand-review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ competitorId }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (ac.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || "Brand review failed");
      if (data.competitor && onCompetitorsUpdated) {
        onCompetitorsUpdated(
          competitors.map((c) =>
            c.id === competitorId ? (data.competitor as CompetitorRecord) : c,
          ),
        );
      }
      setLocalProgress({
        done: 1,
        total: 1,
        currentName: name,
        message: `Updated ${name}`,
      });
      window.setTimeout(() => setLocalProgress(null), 2500);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
        setLocalProgress(null);
      }
    } finally {
      setRowBusy(null);
    }
  }

  async function runScores() {
    if (!resolvedRunId || scoreBusy || batchBusy || liveBrandActive || rowBusy) return;
    setScoreBusy(true);
    setError(null);
    setLocalProgress({
      done: 0,
      total: competitors.length,
      currentName: null,
      message: "Scoring brands from saved follower and size metrics…",
    });
    try {
      const res = await fetch("/api/competitors/brand-score", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: resolvedRunId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Brand score failed");
      if (Array.isArray(data.competitors)) {
        onCompetitorsUpdated?.(data.competitors);
      }
      setLocalProgress({
        done: data.scored ?? competitors.length,
        total: competitors.length,
        currentName: null,
        message: `Brand scores updated · ${data.scored ?? 0} scored`,
      });
      window.setTimeout(() => setLocalProgress(null), 2500);
    } catch (err) {
      setError((err as Error).message);
      setLocalProgress(null);
    } finally {
      setScoreBusy(false);
    }
  }

  const reviewing = batchBusy || liveBrandActive || Boolean(rowBusy);
  const controlsLocked = reviewing || scoreBusy;

  const missingScores = competitors.some(
    (c) => c.brand?.brandScore == null && hasSizeSignal(c.brand),
  );

  useEffect(() => {
    if (!resolvedRunId || reviewing || scoreBusy || !missingScores) return;
    const key = `${resolvedRunId}:${competitors.map((c) => c.id).join(",")}`;
    if (autoScoreKey.current === key) return;
    autoScoreKey.current = key;
    void runScores();
    // Score once when saved metrics exist and brand review is idle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedRunId, reviewing, scoreBusy, missingScores, competitors]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === 1 ? -1 : 1));
      return;
    }
    setSortKey(key);
    setSortDir(key === "name" ? 1 : -1);
  }

  const sortedCompetitors = useMemo(() => {
    const dir = sortDir;
    const valueOf = (c: CompetitorRecord): number | string | null => {
      const b = c.brand || {};
      switch (sortKey) {
        case "score":
          return b.brandScore ?? null;
        case "name":
          return c.pageName || "";
        case "facebook":
          return b.facebookFollowers ?? null;
        case "instagram":
          return b.instagramFollowers ?? null;
        case "twitter":
          return b.twitterFollowers ?? null;
        case "youtube":
          return b.youtubeSubscribers ?? null;
        case "employees":
          return b.linkedinEmployees ?? null;
        case "linkedin":
          return b.linkedinFollowers ?? null;
        case "revenue":
          return revenueSortValue(b.companyRevenue);
        default:
          return null;
      }
    };
    return [...competitors].sort((a, b) => compareNullable(valueOf(a), valueOf(b), dir));
  }, [competitors, sortKey, sortDir]);

  if (competitors.length === 0) {
    return (
      <p className="empty-hint">
        Find competitors first (top 10). Then click <strong>Run brand review</strong>{" "}
        here to scrape each domain for socials and pull follower / employee metrics.
      </p>
    );
  }

  return (
    <div className="brand-review-panel">
      {showActions && resolvedRunId && (
        <div className="history-actions brand-review-actions">
          <button
            type="button"
            className="chip-btn"
            disabled={controlsLocked}
            onClick={() => void runBatch(false)}
          >
            {batchBusy ? "Running…" : "Run brand review"}
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={controlsLocked}
            onClick={() => setConfirmRedoAll(true)}
          >
            Redo all
          </button>
          <button
            type="button"
            className="chip-btn"
            disabled={controlsLocked}
            onClick={() => void runScores()}
          >
            {scoreBusy ? "Scoring…" : "Redo brand scores"}
          </button>
          {reviewing && (
            <button
              type="button"
              className="chip-btn"
              disabled={stopping}
              onClick={() => void stopBrandReview()}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
        </div>
      )}

      {displayProgress && (
        <div
          className={`brand-review-progress ${reviewing ? "is-active" : "is-done"}`}
          aria-live="polite"
        >
          <div className="brand-review-progress-head">
            <span className="brand-review-progress-label">
              {scoreBusy
                ? "Brand scores"
                : liveBrandActive && !batchBusy
                ? "Brand review in progress"
                : batchBusy
                  ? "Brand review running"
                  : rowBusy
                    ? "Updating competitor"
                    : "Brand review"}
            </span>
            <span className="brand-review-progress-count">
              {displayProgress.done}/{displayProgress.total || "—"}
            </span>
          </div>
          <div className="progress-bar-track brand-review-bar">
            <div
              className="progress-bar-fill"
              style={{ width: `${reviewing && pct < 8 ? 8 : pct}%` }}
            />
          </div>
          <p className="brand-review-progress-msg">
            {displayProgress.message}
          </p>
        </div>
      )}

      {error && (
        <div className="brand-review-error" role="alert">
          {error}
        </div>
      )}

      <div className="table-wrap">
        <table className="comp-table brand-review-table">
          <thead>
            <tr>
              <SortHeader label="Score" sortKey="score" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="Company" sortKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <th>Website</th>
              <SortHeader label="FB followers" sortKey="facebook" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="IG followers" sortKey="instagram" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="X followers" sortKey="twitter" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="YouTube subs" sortKey="youtube" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="LI employees" sortKey="employees" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="LI followers" sortKey="linkedin" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortHeader label="Company revenue" sortKey="revenue" activeKey={sortKey} dir={sortDir} onSort={toggleSort} />
              {showActions && <th />}
            </tr>
          </thead>
          <tbody>
            {sortedCompetitors.map((c) => {
              const b = c.brand || {};
              const busy = rowBusy === c.id;
              const isCurrent =
                reviewing &&
                displayProgress?.currentName &&
                displayProgress.currentName === c.pageName;
              return (
                <tr
                  key={c.id}
                  className={
                    busy || isCurrent ? "brand-review-row-active" : undefined
                  }
                >
                  <td className="brand-score-cell">
                    {b.brandScore == null ? (
                      "—"
                    ) : (
                      <>
                        <strong className="brand-score-num">{b.brandScore}</strong>
                        {b.brandScoreSummary && (
                          <div className="brand-score-summary">{b.brandScoreSummary}</div>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <strong>{c.pageName}</strong>
                    {b.category && <div className="muted">{b.category}</div>}
                    {(busy || isCurrent) && (
                      <div className="brand-review-row-status">Reviewing…</div>
                    )}
                  </td>
                  <td className="lp-cell">
                    {b.website ? (
                      <a
                        href={
                          b.website.startsWith("http")
                            ? b.website
                            : `https://${b.website}`
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        {b.website.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      "Not present"
                    )}
                  </td>
                  <td>{fmtMetric(hasFacebook(b), b.facebookFollowers)}</td>
                  <td>{fmtMetric(hasInstagram(b), b.instagramFollowers)}</td>
                  <td>{fmtMetric(hasTwitter(b), b.twitterFollowers)}</td>
                  <td>{fmtMetric(hasYouTube(b), b.youtubeSubscribers)}</td>
                  <td>{fmtMetric(hasLinkedIn(b), b.linkedinEmployees)}</td>
                  <td>{fmtMetric(hasLinkedIn(b), b.linkedinFollowers)}</td>
                  <td>
                    {b.companyRevenue ? (
                      <span title={b.companyRevenueSource || undefined}>
                        {String(b.companyRevenue).replace(/^["']|["']$/g, "")}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  {showActions && (
                    <td>
                      <button
                        type="button"
                        className="linkish-btn"
                        disabled={controlsLocked}
                        onClick={() => void redoOne(c.id)}
                      >
                        {busy ? "…" : "Redo"}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmRedoAll}
        title="Redo brand review for all?"
        description="This re-scrapes each competitor website and refreshes Facebook, Instagram, X, YouTube, and LinkedIn metrics. Existing brand metrics will be replaced."
        confirmLabel="Redo all"
        cancelLabel="Cancel"
        tone="danger"
        busy={false}
        onCancel={() => setConfirmRedoAll(false)}
        onConfirm={() => void runBatch(true)}
      />
    </div>
  );
}
