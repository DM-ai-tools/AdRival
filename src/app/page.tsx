"use client";

import { useCallback, useEffect, useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { ProgressPanel } from "@/components/ProgressPanel";
import { CompetitorTable } from "@/components/CompetitorTable";
import { BrandReviewPanel } from "@/components/BrandReviewPanel";
import { ExportButton } from "@/components/ExportButton";
import { LookupForm } from "@/components/LookupForm";
import { LookupResults } from "@/components/LookupResults";
import { UnifiedHistoryPanel } from "@/components/UnifiedHistoryPanel";
import { PlatformPicker } from "@/components/PlatformPicker";
import { PLATFORM_META, type AdPlatform } from "@/lib/platforms";
import type { UnifiedHistoryItem } from "@/lib/historyUnified";
import type {
  CompetitorRecord,
  LookupAdRecord,
  LookupJob,
  SearchJob,
} from "@/lib/types";

type Mode = "search" | "lookup" | "history";
type ResultsView = "preview" | "brand";

export default function HomePage() {
  const [platform, setPlatform] = useState<AdPlatform>("facebook");
  const [mode, setMode] = useState<Mode>("search");
  const [resultsView, setResultsView] = useState<ResultsView>("preview");
  const [historyResultsView, setHistoryResultsView] =
    useState<ResultsView>("preview");

  const [jobId, setJobId] = useState<string | null>(null);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [job, setJob] = useState<SearchJob | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorRecord[]>([]);

  const [lookupId, setLookupId] = useState<string | null>(null);
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupJob, setLookupJob] = useState<LookupJob | null>(null);
  const [lookupAds, setLookupAds] = useState<LookupAdRecord[]>([]);

  const [historyRuns, setHistoryRuns] = useState<UnifiedHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<
    "all" | "search" | "lookup"
  >("all");
  const [selectedHistory, setSelectedHistory] =
    useState<UnifiedHistoryItem | null>(null);
  const [historyJob, setHistoryJob] = useState<SearchJob | null>(null);
  const [historyCompetitors, setHistoryCompetitors] = useState<
    CompetitorRecord[]
  >([]);
  const [historyLookupJob, setHistoryLookupJob] = useState<LookupJob | null>(
    null,
  );
  const [historyLookupAds, setHistoryLookupAds] = useState<LookupAdRecord[]>(
    [],
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const pollSearch = useCallback(async (id: string) => {
    const res = await fetch(`/api/search/status?jobId=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setJob(data.job);
    setCompetitors(data.competitors ?? []);
  }, []);

  const pollLookup = useCallback(async (id: string) => {
    const res = await fetch(`/api/lookup/status?lookupId=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    setLookupJob(data.job);
    setLookupAds(data.ads ?? []);
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await fetch("/api/history/unified");
      if (!res.ok) return;
      const data = await res.json();
      setHistoryRuns(data.runs ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const loadHistoryItem = useCallback(async (run: UnifiedHistoryItem) => {
    setSelectedHistory(run);
    setHistoryJob(null);
    setHistoryCompetitors([]);
    setHistoryLookupJob(null);
    setHistoryLookupAds([]);
    const res = await fetch(
      `/api/history/unified?runId=${encodeURIComponent(run.id)}&kind=${run.kind}`,
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data.kind === "lookup") {
      setHistoryLookupJob(data.job ?? null);
      setHistoryLookupAds(data.ads ?? []);
    } else {
      setHistoryJob(data.job ?? null);
      setHistoryCompetitors(data.competitors ?? []);
    }
  }, []);

  const deleteHistoryItem = useCallback(
    async (run: UnifiedHistoryItem) => {
      setDeletingId(`${run.kind}:${run.id}`);
      try {
        await fetch(
          `/api/history/unified?runId=${encodeURIComponent(run.id)}&kind=${run.kind}`,
          { method: "DELETE" },
        );
        if (selectedHistory?.id === run.id && selectedHistory.kind === run.kind) {
          setSelectedHistory(null);
          setHistoryJob(null);
          setHistoryCompetitors([]);
          setHistoryLookupJob(null);
          setHistoryLookupAds([]);
        }
        await loadHistory();
      } finally {
        setDeletingId(null);
      }
    },
    [selectedHistory, loadHistory],
  );

  const clearAllHistory = useCallback(async () => {
    setDeletingId("__all__");
    try {
      await fetch("/api/history/unified?all=1", { method: "DELETE" });
      setSelectedHistory(null);
      setHistoryRuns([]);
      setHistoryJob(null);
      setHistoryCompetitors([]);
      setHistoryLookupJob(null);
      setHistoryLookupAds([]);
      await loadHistory();
    } finally {
      setDeletingId(null);
    }
  }, [loadHistory]);

  useEffect(() => {
    if (!jobId) return;
    void pollSearch(jobId);
    const t = setInterval(() => void pollSearch(jobId), 2500);
    return () => clearInterval(t);
  }, [jobId, pollSearch]);

  useEffect(() => {
    if (!lookupId) return;
    void pollLookup(lookupId);
    const t = setInterval(() => void pollLookup(lookupId), 2500);
    return () => clearInterval(t);
  }, [lookupId, pollLookup]);

  useEffect(() => {
    if (mode === "history") void loadHistory();
  }, [mode, loadHistory]);

  useEffect(() => {
    if (job && job.status !== "running") void loadHistory();
  }, [job?.status, loadHistory, job]);

  useEffect(() => {
    if (lookupJob && lookupJob.status !== "running") void loadHistory();
  }, [lookupJob?.status, loadHistory, lookupJob]);

  const searchRunning = job?.status === "running";
  const lookupRunning = lookupJob?.status === "running";
  const meta = PLATFORM_META[platform];

  return (
    <main className="page product-shell">
      <div className="atmosphere" aria-hidden />

      <header className="product-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Competitive ad intelligence</h1>
          <p className="lede">
            Glass-clear workspace to find agency competitors and pull creatives
            across Meta, Google, YouTube, and LinkedIn — search and lookup in
            one place.
          </p>
        </div>
      </header>

      <div className="tab-bar tab-bar-wide mode-bar" role="tablist">
        <button
          type="button"
          role="tab"
          className={`tab-btn ${mode === "search" ? "active" : ""}`}
          onClick={() => setMode("search")}
        >
          Keyword search
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${mode === "lookup" ? "active" : ""}`}
          onClick={() => setMode("lookup")}
        >
          Competitor lookup
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${mode === "history" ? "active" : ""}`}
          onClick={() => setMode("history")}
        >
          History
        </button>
      </div>

      {mode !== "history" && (
        <>
          <PlatformPicker
            value={platform}
            onChange={(p) => {
              setPlatform(p);
            }}
          />
          <p className="platform-context">
            <strong>{meta.label}</strong> — {meta.description}
          </p>
        </>
      )}

      {mode === "search" && (
        <>
          <section className="panel glow-panel">
            <SearchForm
              platform={platform}
              disabled={searchRunning}
              onStarted={(id, kws, p) => {
                setJobId(id);
                setKeywords(kws);
                setPlatform(p);
                setJob(null);
                setCompetitors([]);
                setResultsView("preview");
                setMode("search");
              }}
            />
          </section>

          {job && (
            <ProgressPanel
              keyword={keywords.join(", ") || job.keyword}
              status={job.status}
              progress={job.progress}
            />
          )}

          <section className="results">
            <div className="results-head">
              <h2>
                Results{" "}
                <span className="muted-inline">
                  {meta.short}
                  {keywords.length > 1 ? ` · ${keywords.length} keywords` : ""}
                  {competitors.length
                    ? ` · ${competitors.length} competitors`
                    : ""}
                </span>
              </h2>
              <ExportButton jobId={jobId} disabled={!competitors.length} />
            </div>

            <div className="tab-bar results-subtabs" role="tablist">
              <button
                type="button"
                role="tab"
                className={`tab-btn ${resultsView === "preview" ? "active" : ""}`}
                onClick={() => setResultsView("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                role="tab"
                className={`tab-btn ${resultsView === "brand" ? "active" : ""}`}
                onClick={() => setResultsView("brand")}
              >
                Brand review
              </button>
            </div>

            {resultsView === "preview" ? (
              <CompetitorTable competitors={competitors} />
            ) : (
              <BrandReviewPanel competitors={competitors} />
            )}
          </section>
        </>
      )}

      {mode === "lookup" && (
        <>
          <section className="panel glow-panel">
            <LookupForm
              platform={platform}
              disabled={lookupRunning}
              onStarted={(id, name, p) => {
                setLookupId(id);
                setLookupQuery(name);
                setPlatform(p);
                setLookupJob(null);
                setLookupAds([]);
                setMode("lookup");
              }}
            />
          </section>
          {lookupJob && <LookupResults job={lookupJob} ads={lookupAds} />}
          {!lookupJob && lookupQuery && (
            <p className="empty-hint">Starting lookup for {lookupQuery}…</p>
          )}
        </>
      )}

      {mode === "history" && (
        <section className="history-layout">
          <div className="panel history-sidebar">
            <div className="results-head">
              <h2>Unified history</h2>
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void loadHistory()}
              >
                Refresh
              </button>
            </div>
            <UnifiedHistoryPanel
              runs={historyRuns}
              selectedId={selectedHistory?.id ?? null}
              selectedKind={selectedHistory?.kind ?? null}
              onSelect={(run) => void loadHistoryItem(run)}
              onDelete={(run) => void deleteHistoryItem(run)}
              onClearAll={() => void clearAllHistory()}
              loading={historyLoading}
              deletingId={deletingId}
              filterKind={historyFilter}
              onFilterKind={setHistoryFilter}
            />
          </div>

          <div className="panel history-detail">
            {!selectedHistory ? (
              <p className="empty-hint">
                Select a search or lookup run. Platform badges show where each
                run came from.
              </p>
            ) : selectedHistory.kind === "lookup" && historyLookupJob ? (
              <LookupResults job={historyLookupJob} ads={historyLookupAds} />
            ) : historyJob ? (
              <>
                <div className="results-head">
                  <h2>
                    {historyJob.keyword}{" "}
                    <span className="muted-inline">
                      ({String(historyJob.platform || "facebook")} ·{" "}
                      {historyCompetitors.length} competitors)
                    </span>
                  </h2>
                  <ExportButton
                    jobId={selectedHistory.id}
                    disabled={!historyCompetitors.length}
                  />
                </div>
                <div className="tab-bar results-subtabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    className={`tab-btn ${historyResultsView === "preview" ? "active" : ""}`}
                    onClick={() => setHistoryResultsView("preview")}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`tab-btn ${historyResultsView === "brand" ? "active" : ""}`}
                    onClick={() => setHistoryResultsView("brand")}
                  >
                    Brand review
                  </button>
                </div>
                {historyResultsView === "preview" ? (
                  <CompetitorTable competitors={historyCompetitors} />
                ) : (
                  <BrandReviewPanel competitors={historyCompetitors} />
                )}
              </>
            ) : (
              <p className="empty-hint">Loading run…</p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
