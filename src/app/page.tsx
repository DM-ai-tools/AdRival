"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { ProgressPanel } from "@/components/ProgressPanel";
import { CompetitorTable } from "@/components/CompetitorTable";
import { BrandReviewPanel } from "@/components/BrandReviewPanel";
import { ExportButton } from "@/components/ExportButton";
import { LookupForm } from "@/components/LookupForm";
import { LookupResults } from "@/components/LookupResults";
import {
  SearchOffersDashboard,
  SearchOffersTeaser,
} from "@/components/SearchOffersReportPanel";
import { UnifiedHistoryPanel } from "@/components/UnifiedHistoryPanel";
import { KillWorkButton } from "@/components/KillWorkButton";
import { AuthHeaderActions } from "@/components/AuthHeaderActions";
import { ClientSpaceBar, SPACE_EVENT, type SpaceSelection } from "@/components/ClientSpaceBar";
import { PlatformPicker } from "@/components/PlatformPicker";
import { BusinessProfileSummary } from "@/components/BusinessProfileSummary";
import { RunCreditLine, type RunCredits } from "@/components/RunCreditLine";
import { PLATFORM_META, type AdPlatform } from "@/lib/platforms";
import type { UnifiedHistoryItem } from "@/lib/historyUnified";
import type {
  CompetitorRecord,
  LookupAdRecord,
  LookupJob,
  LookupPageCandidate,
  SearchJob,
} from "@/lib/types";

type Mode = "search" | "lookup" | "history";
type ResultsView = "website" | "preview" | "brand" | "offers";

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
  const [generatingSearchOffers, setGeneratingSearchOffers] = useState(false);
  const [searchOffersError, setSearchOffersError] = useState<string | null>(null);

  const [lookupId, setLookupId] = useState<string | null>(null);
  const [lookupQuery, setLookupQuery] = useState("");
  const [lookupJob, setLookupJob] = useState<LookupJob | null>(null);
  const [lookupAds, setLookupAds] = useState<LookupAdRecord[]>([]);

  const [searchCredits, setSearchCredits] = useState<RunCredits | null>(null);
  const [lookupCredits, setLookupCredits] = useState<RunCredits | null>(null);
  const [historyCredits, setHistoryCredits] = useState<RunCredits | null>(null);

  const [historyRuns, setHistoryRuns] = useState<UnifiedHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<
    "all" | "search" | "lookup"
  >("all");
  const [activeSpace, setActiveSpace] = useState<SpaceSelection>({
    id: "",
    clientName: "",
    role: "",
  });
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
  const [generatingHistoryOffers, setGeneratingHistoryOffers] = useState(false);
  const [historyOffersError, setHistoryOffersError] = useState<string | null>(
    null,
  );
  const [fetchingCandidateId, setFetchingCandidateId] = useState<string | null>(
    null,
  );
  const historyReportRef = useRef<HTMLDivElement | null>(null);
  const liveSearchId = useRef<string | null>(null);
  const liveLookupId = useRef<string | null>(null);

  const scrollToHistoryReport = useCallback(() => {
    // Wait a frame so the report panel has content before scrolling
    requestAnimationFrame(() => {
      historyReportRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);

  const pollSearch = useCallback(async (id: string) => {
    const res = await fetch(`/api/search/status?jobId=${id}`);
    if (liveSearchId.current !== id) return;
    if (res.status === 404) {
      liveSearchId.current = null;
      setJobId(null);
      setJob(null);
      setCompetitors([]);
      setSearchCredits(null);
      setGeneratingSearchOffers(false);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (liveSearchId.current !== id) return;
    setJob(data.job);
    setCompetitors(data.competitors ?? []);
    setSearchCredits((data.credits as RunCredits) ?? null);
    // Surface brand-review stage on the Brand review tab
    if (data.job?.progress?.stage === "brand_review") {
      setResultsView("brand");
    }
  }, []);

  const pollHistorySearch = useCallback(async (id: string) => {
    const res = await fetch(`/api/search/status?jobId=${id}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.job) setHistoryJob(data.job as SearchJob);
    if (Array.isArray(data.competitors)) {
      setHistoryCompetitors(data.competitors as CompetitorRecord[]);
    }
    setHistoryCredits((data.credits as RunCredits) ?? null);
  }, []);

  const pollLookup = useCallback(async (id: string) => {
    const res = await fetch(`/api/lookup/status?lookupId=${id}`);
    if (liveLookupId.current !== id) return;
    if (res.status === 404) {
      liveLookupId.current = null;
      setLookupId(null);
      setLookupJob(null);
      setLookupAds([]);
      setLookupCredits(null);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (liveLookupId.current !== id) return;
    setLookupJob(data.job);
    setLookupCredits((data.credits as RunCredits) ?? null);
    const incoming = (data.ads ?? []) as LookupAdRecord[];
    setLookupAds((prev) => {
      if (!prev.length) return incoming;
      const prevById = new Map(prev.map((a) => [a.id, a]));
      return incoming.map((next) => {
        const old = prevById.get(next.id);
        if (!old?.pageAnalysis) return next;
        const oldStatus = old.pageAnalysis.status;
        const nextStatus = next.pageAnalysis?.status;
        // Don't let a slow poll regress completed/failed → pending
        if (
          (oldStatus === "completed" || oldStatus === "failed") &&
          nextStatus === "pending"
        ) {
          return { ...next, pageAnalysis: old.pageAnalysis };
        }
        if (
          oldStatus === "completed" &&
          nextStatus === "completed" &&
          (old.pageAnalysis.analyzedAt || "") >
            (next.pageAnalysis?.analyzedAt || "")
        ) {
          return { ...next, pageAnalysis: old.pageAnalysis };
        }
        return next;
      });
    });
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

  useEffect(() => {
    const onSpace = (event: Event) => {
      const detail = (event as CustomEvent<SpaceSelection | string>).detail;
      if (typeof detail === "string") {
        setActiveSpace({ id: detail, clientName: "", role: "" });
        return;
      }
      setActiveSpace(detail ?? { id: "", clientName: "", role: "" });
    };
    window.addEventListener(SPACE_EVENT, onSpace);
    return () => window.removeEventListener(SPACE_EVENT, onSpace);
  }, []);

  const loadHistoryItem = useCallback(
    async (run: UnifiedHistoryItem) => {
      setSelectedHistory(run);
      setHistoryJob(null);
      setHistoryCompetitors([]);
      setHistoryLookupJob(null);
      setHistoryLookupAds([]);
      setHistoryResultsView(run.kind === "search" ? "website" : "preview");
      setHistoryOffersError(null);
      setHistoryCredits(null);
      setGeneratingHistoryOffers(false);
      // Immediate scroll so the user sees the report region loading
      scrollToHistoryReport();

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
      setHistoryCredits((data.credits as RunCredits) ?? null);
      // Scroll again after content paints
      setTimeout(() => scrollToHistoryReport(), 80);
    },
    [scrollToHistoryReport],
  );

  const deleteHistoryItem = useCallback(
    async (run: UnifiedHistoryItem) => {
      setDeletingId(`${run.kind}:${run.id}`);
      try {
        const res = await fetch(
          `/api/history/unified?runId=${encodeURIComponent(run.id)}&kind=${run.kind}`,
          { method: "DELETE" },
        );
        if (!res.ok) return;
        if (run.kind === "search" && (jobId === run.id || liveSearchId.current === run.id)) {
          liveSearchId.current = null;
          setJobId(null);
          setJob(null);
          setCompetitors([]);
          setSearchCredits(null);
          setGeneratingSearchOffers(false);
          setSearchOffersError(null);
        }
        if (run.kind === "lookup" && (lookupId === run.id || liveLookupId.current === run.id)) {
          liveLookupId.current = null;
          setLookupId(null);
          setLookupJob(null);
          setLookupAds([]);
          setLookupCredits(null);
        }
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
    [selectedHistory, loadHistory, jobId, lookupId],
  );

  const startLookupForCandidate = useCallback(
    async (candidate: LookupPageCandidate, plat: AdPlatform) => {
      setFetchingCandidateId(candidate.pageId);
      try {
        const res = await fetch("/api/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: candidate.name,
            platform: plat,
            forcedCandidate: candidate,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Lookup failed");
        setMode("lookup");
        setPlatform(plat);
        liveLookupId.current = data.lookupId;
        setLookupId(data.lookupId);
        setLookupQuery(data.queryName || candidate.name);
        setLookupJob(null);
        setLookupAds([]);
        setSelectedHistory(null);
      } catch (err) {
        console.error(err);
        alert((err as Error).message);
      } finally {
        setFetchingCandidateId(null);
      }
    },
    [],
  );

  const clearAllHistory = useCallback(async () => {
    setDeletingId("__all__");
    try {
      await fetch("/api/history/unified?all=1", { method: "DELETE" });
      liveSearchId.current = null;
      liveLookupId.current = null;
      setJobId(null);
      setJob(null);
      setCompetitors([]);
      setSearchCredits(null);
      setGeneratingSearchOffers(false);
      setLookupId(null);
      setLookupJob(null);
      setLookupAds([]);
      setLookupCredits(null);
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
    liveSearchId.current = jobId;
    if (!jobId) return;
    void pollSearch(jobId);
    const t = setInterval(() => void pollSearch(jobId), 2500);
    return () => clearInterval(t);
  }, [jobId, pollSearch]);

  useEffect(() => {
    if (mode !== "history" || selectedHistory?.kind !== "search") return;
    const running =
      historyJob?.progress?.stage === "analyzing_offers" ||
      generatingHistoryOffers;
    if (!running) return;
    const id = selectedHistory.id;
    void pollHistorySearch(id);
    const t = setInterval(() => void pollHistorySearch(id), 2500);
    return () => clearInterval(t);
  }, [
    mode,
    selectedHistory,
    historyJob?.progress?.stage,
    generatingHistoryOffers,
    pollHistorySearch,
  ]);

  useEffect(() => {
    liveLookupId.current = lookupId;
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
  const searchOffersRunning = job?.progress?.stage === "analyzing_offers";
  const historyOffersRunning =
    historyJob?.progress?.stage === "analyzing_offers";
  const lookupRunning = lookupJob?.status === "running";
  const lookupOffersRunning =
    lookupJob?.progress?.stage === "analyzing_offers";
  const historyLookupRunning =
    historyLookupJob?.status === "running" ||
    historyLookupJob?.progress?.stage === "analyzing_offers";
  const workActive = Boolean(
    searchRunning ||
      searchOffersRunning ||
      lookupRunning ||
      lookupOffersRunning ||
      historyOffersRunning ||
      historyLookupRunning ||
      job?.progress?.stage === "brand_review" ||
      historyJob?.progress?.stage === "brand_review" ||
      generatingSearchOffers ||
      generatingHistoryOffers,
  );
  const meta = PLATFORM_META[platform];

  const refreshAfterStop = useCallback(() => {
    if (jobId) void pollSearch(jobId);
    if (lookupId) void pollLookup(lookupId);
    if (selectedHistory?.kind === "search") {
      void pollHistorySearch(selectedHistory.id);
    }
    if (selectedHistory?.kind === "lookup") {
      void loadHistoryItem(selectedHistory);
    }
    setGeneratingSearchOffers(false);
    setGeneratingHistoryOffers(false);
  }, [
    jobId,
    lookupId,
    selectedHistory,
    pollSearch,
    pollLookup,
    pollHistorySearch,
    loadHistoryItem,
  ]);

  return (
    <main className="page product-shell">
      <div className="atmosphere" aria-hidden />

      <header className="product-header">
        <div className="product-brand-block">
          <p className="brand">AdRival</p>
          <h1>Competitive ad intelligence</h1>
          <p className="lede">
            Paste any business URL to understand its industry, then find
            competitors advertising across Meta, Google, YouTube, and LinkedIn —
            search and lookup in one place.
          </p>
        </div>
        <div className="product-header-actions">
          <AuthHeaderActions />
          <KillWorkButton
            active={workActive}
            jobId={jobId || historyJob?.id}
            lookupId={lookupId || historyLookupJob?.id}
            onStopped={refreshAfterStop}
          />
        </div>
      </header>

      <ClientSpaceBar />

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
                liveSearchId.current = id;
                setJobId(id);
                setKeywords(kws);
                setPlatform(p);
                setJob(null);
                setCompetitors([]);
                setSearchCredits(null);
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
              onStop={
                searchRunning ||
                searchOffersRunning ||
                job.progress.stage === "brand_review"
                  ? refreshAfterStop
                  : undefined
              }
              stopJobId={jobId}
            />
          )}

          {job && !searchRunning ? (
            <RunCreditLine credits={searchCredits} />
          ) : null}

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
                className={`tab-btn ${resultsView === "website" ? "active" : ""}`}
                onClick={() => setResultsView("website")}
              >
                Your website
              </button>
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
                {job?.progress?.stage === "brand_review" && (
                  <span className="tab-live-dot" aria-label="In progress" />
                )}
              </button>
              <button
                type="button"
                role="tab"
                className={`tab-btn ${resultsView === "offers" ? "active" : ""}`}
                onClick={() => setResultsView("offers")}
              >
                Offers dashboard
                {searchOffersRunning && (
                  <span className="tab-live-dot" aria-label="In progress" />
                )}
              </button>
            </div>

            {resultsView === "website" ? (
              <BusinessProfileSummary
                profile={job?.businessProfile}
                businessUrl={job?.businessUrl}
                selectedCategory={job?.selectedCategory}
                keyword={job?.keyword}
                keywords={job?.keywords || keywords}
                geoMode={job?.geoMode}
                targetLocations={job?.targetLocations}
              />
            ) : resultsView === "preview" ? (
              <CompetitorTable
                competitors={competitors}
                runId={jobId}
                onCompetitorUpdated={(updated) => {
                  setCompetitors((prev) =>
                    prev.map((c) => (c.id === updated.id ? updated : c)),
                  );
                }}
                onCompetitorsUpdated={setCompetitors}
              />
            ) : resultsView === "brand" ? (
              <BrandReviewPanel
                competitors={competitors}
                runId={jobId}
                liveProgress={job?.progress ?? null}
                onCompetitorsUpdated={setCompetitors}
              />
            ) : job ? (
              <>
                {searchOffersError ? (
                  <p className="error-text panel" role="alert">
                    {searchOffersError}
                  </p>
                ) : null}
                <SearchOffersTeaser
                  job={job}
                  competitors={competitors}
                  selectCompetitors
                  generating={generatingSearchOffers}
                  onStop={refreshAfterStop}
                  onGenerate={(opts) => {
                    if (!jobId) return;
                    setSearchOffersError(null);
                    setGeneratingSearchOffers(true);
                    fetch("/api/search/offers-report", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        jobId,
                        force: true,
                        refetchAds: false,
                        competitorIds: opts?.competitorIds,
                      }),
                    })
                      .then(async (r) => {
                        const data = await r.json();
                        if (!r.ok) throw new Error(data.error || "Offers report failed");
                        if (data.job) setJob(data.job as SearchJob);
                        if (Array.isArray(data.competitors)) {
                          setCompetitors(data.competitors as CompetitorRecord[]);
                        }
                      })
                      .catch((err) => setSearchOffersError((err as Error).message))
                      .finally(() => setGeneratingSearchOffers(false));
                  }}
                />
                <SearchOffersDashboard job={job} />
              </>
            ) : null}
            
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
                liveLookupId.current = id;
                setLookupId(id);
                setLookupQuery(name);
                setPlatform(p);
                setLookupJob(null);
                setLookupAds([]);
                setLookupCredits(null);
                setMode("lookup");
              }}
            />
          </section>
          {lookupJob && !lookupRunning ? (
            <RunCreditLine credits={lookupCredits} />
          ) : null}
          {lookupJob && (
            <LookupResults
              job={lookupJob}
              ads={lookupAds}
              fetchingCandidateId={fetchingCandidateId}
              onFetchCandidate={(c) =>
                void startLookupForCandidate(
                  c,
                  (lookupJob.platform || platform) as AdPlatform,
                )
              }
              onAdUpdated={(ad) => {
                setLookupAds((prev) =>
                  prev.map((a) => (a.id === ad.id ? ad : a)),
                );
              }}
              onJobUpdated={(nextJob, nextAds) => {
                setLookupJob(nextJob);
                if (nextAds) setLookupAds(nextAds);
              }}
              onReload={async () => {
                if (lookupId) await pollLookup(lookupId);
              }}
              onStop={refreshAfterStop}
            />
          )}
          {!lookupJob && lookupQuery && (
            <p className="empty-hint">Starting lookup for {lookupQuery}…</p>
          )}
        </>
      )}

      {mode === "history" && (
        <section className="history-layout">
          <div className="panel history-list-panel">
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
              spaceId={activeSpace.id || null}
              spaceName={activeSpace.clientName || null}
            />
          </div>

          <div
            className="panel history-report-panel"
            ref={historyReportRef}
            id="history-report"
            tabIndex={-1}
          >
            <div className="results-head">
              <h2>Report</h2>
              {selectedHistory && (
                <span className="muted-inline">
                  {selectedHistory.kind === "lookup" ? "Lookup" : "Search"} ·{" "}
                  {selectedHistory.title}
                  {historyJob?.businessProfile?.businessName
                    ? ` · ${historyJob.businessProfile.businessName}`
                    : ""}
                  {historyJob?.businessUrl || historyJob?.businessProfile?.url
                    ? ` · ${historyJob.businessUrl || historyJob.businessProfile?.url}`
                    : ""}
                </span>
              )}
            </div>
            {selectedHistory ? (
              <RunCreditLine credits={historyCredits} />
            ) : null}
            {!selectedHistory ? (
              <p className="empty-hint">
                Select a search or lookup run above to open its report.
              </p>
            ) : selectedHistory.kind === "lookup" && historyLookupJob ? (
              <LookupResults
                job={historyLookupJob}
                ads={historyLookupAds}
                fetchingCandidateId={fetchingCandidateId}
                onFetchCandidate={(c) =>
                  void startLookupForCandidate(
                    c,
                    (historyLookupJob.platform || platform) as AdPlatform,
                  )
                }
                onAdUpdated={(ad) => {
                  setHistoryLookupAds((prev) =>
                    prev.map((a) => (a.id === ad.id ? ad : a)),
                  );
                }}
                onJobUpdated={(nextJob, nextAds) => {
                  setHistoryLookupJob(nextJob);
                  if (nextAds) setHistoryLookupAds(nextAds);
                }}
                onReload={async () => {
                  if (selectedHistory) await loadHistoryItem(selectedHistory);
                }}
                onStop={refreshAfterStop}
              />
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
                    className={`tab-btn ${historyResultsView === "website" ? "active" : ""}`}
                    onClick={() => setHistoryResultsView("website")}
                  >
                    Your website
                  </button>
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
                    {historyJob?.progress?.stage === "brand_review" && (
                      <span className="tab-live-dot" aria-label="In progress" />
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`tab-btn ${historyResultsView === "offers" ? "active" : ""}`}
                    onClick={() => setHistoryResultsView("offers")}
                  >
                    Offers dashboard
                    {historyOffersRunning && (
                      <span className="tab-live-dot" aria-label="In progress" />
                    )}
                  </button>
                </div>
                {historyResultsView === "website" ? (
                  <BusinessProfileSummary
                    profile={historyJob.businessProfile}
                    businessUrl={historyJob.businessUrl}
                    selectedCategory={historyJob.selectedCategory}
                    keyword={historyJob.keyword}
                    keywords={historyJob.keywords}
                    geoMode={historyJob.geoMode}
                    targetLocations={historyJob.targetLocations}
                  />
                ) : historyResultsView === "preview" ? (
                  <CompetitorTable
                    competitors={historyCompetitors}
                    runId={selectedHistory?.id}
                    onCompetitorUpdated={(updated) => {
                      setHistoryCompetitors((prev) =>
                        prev.map((c) => (c.id === updated.id ? updated : c)),
                      );
                    }}
                    onCompetitorsUpdated={setHistoryCompetitors}
                  />
                ) : historyResultsView === "brand" ? (
                  <BrandReviewPanel
                    competitors={historyCompetitors}
                    runId={selectedHistory?.id}
                    liveProgress={historyJob?.progress ?? null}
                    onCompetitorsUpdated={(next) => {
                      setHistoryCompetitors(next);
                      // Keep history job progress in sync while redo polls
                      if (selectedHistory?.kind === "search") {
                        void fetch(
                          `/api/search/status?jobId=${encodeURIComponent(selectedHistory.id)}`,
                        )
                          .then((r) => r.json())
                          .then((data) => {
                            if (data.job) setHistoryJob(data.job);
                          })
                          .catch(() => undefined);
                      }
                    }}
                  />
                ) : (
                  <>
                    {historyOffersError ? (
                      <p className="error-text panel" role="alert">
                        {historyOffersError}
                      </p>
                    ) : null}
                    <SearchOffersTeaser
                      job={historyJob}
                      generating={generatingHistoryOffers}
                      onStop={refreshAfterStop}
                      onGenerate={() => {
                        if (!selectedHistory?.id) return;
                        setHistoryOffersError(null);
                        setGeneratingHistoryOffers(true);
                        fetch("/api/search/offers-report", {
                          method: "POST",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            jobId: selectedHistory.id,
                            force: true,
                            refetchAds: false,
                          }),
                        })
                          .then(async (r) => {
                            const data = await r.json();
                            if (!r.ok) {
                              throw new Error(
                                data.error || "Offers report failed",
                              );
                            }
                            if (data.job) setHistoryJob(data.job as SearchJob);
                            if (Array.isArray(data.competitors)) {
                              setHistoryCompetitors(
                                data.competitors as CompetitorRecord[],
                              );
                            }
                          })
                          .catch((err) =>
                            setHistoryOffersError((err as Error).message),
                          )
                          .finally(() => setGeneratingHistoryOffers(false));
                      }}
                    />
                    <SearchOffersDashboard job={historyJob} />
                  </>
                )}
              </>
            ) : (
              <p className="empty-hint">Loading report…</p>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
