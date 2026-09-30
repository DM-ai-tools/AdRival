"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SearchForm } from "@/components/SearchForm";
import { ProgressPanel } from "@/components/ProgressPanel";
import { JourneySteps } from "@/components/JourneySteps";
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

/** Stages in which a run is still working (mirrors the server's in-flight list). */
const SEARCH_BUSY_STAGES = new Set([
  "queued",
  "expanding_queries",
  "searching_ads",
  "analyzing_ad",
  "filling_quota",
  "brand_review",
  "analyzing_offers",
  "searching_pages",
  "fetching_ads",
]);
const LOOKUP_BUSY_STAGES = new Set([
  "searching_pages",
  "verifying_page",
  "fetching_ads",
  "analyzing_offers",
]);
type ResultsView = "website" | "preview" | "brand" | "offers";

/** sessionStorage key for the last screen, restored when landing on a bare "/". */
const LAST_VIEW_KEY = "adrival:lastView";

/** The address parts this page owns; dashboards add their own (DASHBOARD_PARAMS). */
const PAGE_PARAMS = ["mode", "run", "tab", "lookup", "item"] as const;
const DASHBOARD_PARAMS = ["osec", "offer", "ldash"] as const;

function pageParams(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of PAGE_PARAMS) {
    const value = params.get(key);
    if (value) out.set(key, value);
  }
  // Sorted, like the address this page writes, so the two compare equal.
  out.sort();
  return out;
}

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
  const [pageError, setPageError] = useState<string | null>(null);
  const [runAgainBusy, setRunAgainBusy] = useState(false);
  const historyReportRef = useRef<HTMLDivElement | null>(null);
  const searchFormRef = useRef<HTMLElement | null>(null);
  const searchResultsRef = useRef<HTMLElement | null>(null);
  const lastSearchStage = useRef<string | null>(null);
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
    // Open the Brand review tab when a brand review starts, but only then:
    // doing it on every poll would stop the user looking at other tabs.
    const stage = data.job?.progress?.stage ?? null;
    if (stage === "brand_review" && lastSearchStage.current !== "brand_review") {
      setResultsView("brand");
    }
    lastSearchStage.current = stage;
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
    async (run: UnifiedHistoryItem, tab?: ResultsView | null) => {
      setSelectedHistory(run);
      setHistoryJob(null);
      setHistoryCompetitors([]);
      setHistoryLookupJob(null);
      setHistoryLookupAds([]);
      // Open on the competitor list, like a live run.
      setHistoryResultsView(tab || "preview");
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
        setPageError((err as Error).message);
      } finally {
        setFetchingCandidateId(null);
      }
    },
    [],
  );

  /** Start the same lookup again: same brand name, platform and matched page. */
  const retryLookup = useCallback(async (source: LookupJob) => {
    setRunAgainBusy(true);
    setPageError(null);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: source.queryName,
          platform: source.platform,
          forcedCandidate: source.selectedPage ?? undefined,
          businessUrl: source.businessUrl ?? undefined,
          spaceId: source.spaceId ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The lookup could not be started. Try again.");
      setMode("lookup");
      if (source.platform) setPlatform(source.platform as AdPlatform);
      liveLookupId.current = data.lookupId;
      setLookupId(data.lookupId);
      setLookupQuery(data.queryName || source.queryName);
      setLookupJob(null);
      setLookupAds([]);
      setSelectedHistory(null);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setRunAgainBusy(false);
    }
  }, []);

  /** Start a new search with exactly the inputs an earlier run used. */
  const runSearchAgain = useCallback(async (source: SearchJob) => {
    setRunAgainBusy(true);
    setPageError(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: source.keywords?.length ? source.keywords : [source.keyword],
          platform: source.platform,
          geo: source.geo,
          geoMode: source.geoMode,
          selectedCategory: source.selectedCategory ?? null,
          businessUrl: source.businessUrl ?? null,
          businessProfile: source.businessProfile ?? null,
          skipGuardrails: Boolean(source.skipGuardrails),
          guardrailOverride: source.guardrailOverride ?? null,
          spaceId: source.spaceId ?? null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "The search could not be started. Try again.");
      liveSearchId.current = data.jobId;
      lastSearchStage.current = null;
      setJobId(data.jobId);
      setKeywords(data.keywords ?? [data.keyword]);
      if (data.platform) setPlatform(data.platform as AdPlatform);
      setJob(null);
      setCompetitors([]);
      setSearchCredits(null);
      setResultsView("preview");
      setMode("search");
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setRunAgainBusy(false);
    }
  }, []);

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

  // Poll quickly while something is running, slowly once the run is idle.
  // Actions started from this page (offers, brand review, page analysis)
  // update state themselves or run their own poll, so idle polling only has
  // to catch changes made elsewhere.
  const searchBusy =
    job?.status === "running" ||
    SEARCH_BUSY_STAGES.has(job?.progress?.stage || "") ||
    generatingSearchOffers ||
    competitors.some(
      (c) =>
        c.pageAnalysis?.status === "pending" ||
        c.recreatedPage?.status === "pending" ||
        c.recreatedPage?.status === "design_pending",
    );
  useEffect(() => {
    liveSearchId.current = jobId;
    if (!jobId) return;
    void pollSearch(jobId);
    const t = setInterval(() => void pollSearch(jobId), searchBusy ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [jobId, pollSearch, searchBusy]);

  // A run opened from History keeps updating while it is still working,
  // e.g. after a page refresh during a search.
  const historySearchBusy =
    historyJob?.status === "running" ||
    SEARCH_BUSY_STAGES.has(historyJob?.progress?.stage || "") ||
    generatingHistoryOffers;
  useEffect(() => {
    if (mode !== "history" || selectedHistory?.kind !== "search") return;
    if (!historySearchBusy) return;
    const id = selectedHistory.id;
    void pollHistorySearch(id);
    const t = setInterval(() => void pollHistorySearch(id), 2500);
    return () => clearInterval(t);
  }, [mode, selectedHistory, historySearchBusy, pollHistorySearch]);

  const historyLookupBusy =
    historyLookupJob?.status === "running" ||
    LOOKUP_BUSY_STAGES.has(historyLookupJob?.progress?.stage || "");
  useEffect(() => {
    if (mode !== "history" || selectedHistory?.kind !== "lookup") return;
    if (!historyLookupBusy) return;
    const id = selectedHistory.id;
    const poll = async () => {
      const res = await fetch(`/api/lookup/status?lookupId=${encodeURIComponent(id)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.job) setHistoryLookupJob(data.job as LookupJob);
      if (Array.isArray(data.ads)) setHistoryLookupAds(data.ads as LookupAdRecord[]);
      setHistoryCredits((data.credits as RunCredits) ?? null);
    };
    void poll();
    const t = setInterval(() => void poll(), 2500);
    return () => clearInterval(t);
  }, [mode, selectedHistory, historyLookupBusy]);

  const lookupBusy =
    lookupJob?.status === "running" ||
    LOOKUP_BUSY_STAGES.has(lookupJob?.progress?.stage || "") ||
    lookupAds.some((a) => a.pageAnalysis?.status === "pending");
  useEffect(() => {
    liveLookupId.current = lookupId;
    if (!lookupId) return;
    void pollLookup(lookupId);
    const t = setInterval(() => void pollLookup(lookupId), lookupBusy ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [lookupId, pollLookup, lookupBusy]);

  useEffect(() => {
    if (mode === "history") void loadHistory();
  }, [mode, loadHistory]);

  // ── Where the user is, kept in the address bar ──────────────────────────
  // ?mode=search&run=<id>&tab=offers, ?mode=lookup&lookup=<id>,
  // ?mode=history&item=search:<id>. A refresh, a shared link or the Back
  // button returns to the same run and tab. The last place is also kept for
  // this browser tab, so links back to "/" (from credits, admin, a recreated
  // page) land where the user left off.
  const pendingHistoryItem = useRef<string | null>(null);
  const pendingHistoryTab = useRef<ResultsView | null>(null);
  const applyingUrl = useRef(true);
  const lastPushed = useRef<string>("");

  const applyViewParams = useCallback((params: URLSearchParams) => {
    applyingUrl.current = true;
    const nextMode = params.get("mode");
    if (nextMode === "search" || nextMode === "lookup" || nextMode === "history") {
      setMode(nextMode);
    }
    const run = params.get("run");
    if (run && run !== liveSearchId.current) {
      liveSearchId.current = run;
      lastSearchStage.current = null;
      setJobId(run);
      setJob(null);
      setCompetitors([]);
    }
    const tab = params.get("tab");
    const validTab = tab === "website" || tab === "preview" || tab === "brand" || tab === "offers" ? tab : null;
    if (validTab && nextMode === "history") pendingHistoryTab.current = validTab;
    else if (validTab) setResultsView(validTab);
    const lookup = params.get("lookup");
    if (lookup && lookup !== liveLookupId.current) {
      liveLookupId.current = lookup;
      setLookupId(lookup);
      setLookupJob(null);
      setLookupAds([]);
    }
    pendingHistoryItem.current = params.get("item");
    lastPushed.current = pageParams(params).toString();
    // If some of the address could not be applied (e.g. a tab with no run),
    // stop waiting for the state to match it.
    window.setTimeout(() => {
      applyingUrl.current = false;
    }, 500);
  }, []);

  useEffect(() => {
    let params = new URLSearchParams(window.location.search);
    if (![...params.keys()].length) {
      try {
        const saved = sessionStorage.getItem(LAST_VIEW_KEY);
        if (saved) params = new URLSearchParams(saved);
      } catch {
        /* storage unavailable */
      }
    }
    applyViewParams(params);
    const onPop = () => applyViewParams(new URLSearchParams(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyViewParams]);

  useEffect(() => {
    const params = new URLSearchParams();
    params.set("mode", mode);
    if (mode === "search" && jobId) {
      params.set("run", jobId);
      params.set("tab", resultsView);
    }
    if (mode === "lookup" && lookupId) params.set("lookup", lookupId);
    if (mode === "history" && selectedHistory) {
      params.set("item", `${selectedHistory.kind}:${selectedHistory.id}`);
      if (selectedHistory.kind === "search") params.set("tab", historyResultsView);
    } else if (mode === "history" && pendingHistoryItem.current) {
      params.set("item", pendingHistoryItem.current);
      if (pendingHistoryTab.current) params.set("tab", pendingHistoryTab.current);
    }
    params.sort();
    const next = params.toString();
    // While a restored address is still being applied, the state lags behind
    // it; don't write the old state over the address.
    if (applyingUrl.current) {
      if (next === lastPushed.current) {
        applyingUrl.current = false;
        try {
          sessionStorage.setItem(LAST_VIEW_KEY, next);
        } catch {
          /* storage unavailable */
        }
        // Restored from this tab's last place: show it in the address too.
        if (!window.location.search && next) window.history.replaceState(null, "", `?${next}`);
      }
      return;
    }
    try {
      sessionStorage.setItem(LAST_VIEW_KEY, next);
    } catch {
      /* storage unavailable */
    }
    if (next === lastPushed.current) return;
    // A different screen or run is a new Back-button entry; a tab change only
    // updates the current one.
    const prev = new URLSearchParams(lastPushed.current);
    const sameScreen =
      prev.get("mode") === params.get("mode") &&
      prev.get("run") === params.get("run") &&
      prev.get("lookup") === params.get("lookup");
    if (sameScreen) {
      // A dashboard's own place (?osec=, ?offer=) stays while the tab does.
      let url = next;
      if (prev.get("tab") === params.get("tab")) {
        const current = new URLSearchParams(window.location.search);
        const kept = new URLSearchParams(next);
        for (const key of DASHBOARD_PARAMS) {
          const value = current.get(key);
          if (value) kept.set(key, value);
        }
        url = kept.toString();
      }
      window.history.replaceState(null, "", `?${url}`);
    } else {
      window.history.pushState(null, "", `?${next}`);
    }
    lastPushed.current = next;
  }, [mode, jobId, lookupId, resultsView, selectedHistory, historyResultsView]);

  // Reopen the history item named in the address once the list has loaded.
  useEffect(() => {
    const wanted = pendingHistoryItem.current;
    if (!wanted || mode !== "history" || !historyRuns.length) return;
    const found = historyRuns.find((r) => `${r.kind}:${r.id}` === wanted);
    pendingHistoryItem.current = null;
    const tab = pendingHistoryTab.current;
    pendingHistoryTab.current = null;
    if (found && (selectedHistory?.id !== found.id || selectedHistory.kind !== found.kind)) {
      void loadHistoryItem(found, tab);
    } else if (found && tab) {
      setHistoryResultsView(tab);
    }
  }, [mode, historyRuns, selectedHistory, loadHistoryItem]);

  // Refresh the history list when a run finishes. Depend on the status only:
  // every poll returns a new job object, which would reload history each time.
  const jobStatus = job?.status;
  useEffect(() => {
    if (jobStatus && jobStatus !== "running") void loadHistory();
  }, [jobStatus, loadHistory]);

  const lookupStatus = lookupJob?.status;
  useEffect(() => {
    if (lookupStatus && lookupStatus !== "running") void loadHistory();
  }, [lookupStatus, loadHistory]);

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

      {pageError ? (
        <div className="notice notice-error" role="alert">
          <p>{pageError}</p>
          <button type="button" className="link-btn" onClick={() => setPageError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

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
          <JourneySteps
            job={job}
            competitors={competitors}
            view={resultsView}
            onView={(v) => {
              setResultsView(v);
              window.setTimeout(() => searchResultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 30);
            }}
            onSetup={() => searchFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
          />
          <section className="panel glow-panel" ref={searchFormRef}>
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
              createdAt={job.createdAt}
              updatedAt={job.updatedAt}
              onRunAgain={() => void runSearchAgain(job)}
              runAgainBusy={runAgainBusy}
            />
          )}

          {job && !searchRunning ? (
            <RunCreditLine credits={searchCredits} />
          ) : null}

          <section className="results" ref={searchResultsRef}>
            <div className="results-head">
              <h2>
                Results{" "}
                <span className="muted-inline">
                  {/* The run's own platform, not whatever the picker shows now. */}
                  {(job?.platform && PLATFORM_META[job.platform as AdPlatform]?.short) || meta.short}
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
                Competitors
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
            ) : (
              <p className="empty-hint panel">
                Run a keyword search first — the offers dashboard is built from the competitors it finds.
              </p>
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
              onRetry={() => void retryLookup(lookupJob)}
              retryBusy={runAgainBusy}
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
                onRetry={() => void retryLookup(historyLookupJob)}
                retryBusy={runAgainBusy}
              />
            ) : historyJob ? (
              <>
                <JourneySteps
                  job={historyJob}
                  competitors={historyCompetitors}
                  view={historyResultsView}
                  onView={setHistoryResultsView}
                />
                <ProgressPanel
                  keyword={historyJob.keyword}
                  status={historyJob.status}
                  progress={historyJob.progress}
                  createdAt={historyJob.createdAt}
                  updatedAt={historyJob.updatedAt}
                  stopJobId={selectedHistory.id}
                  onStop={refreshAfterStop}
                  onRunAgain={() => void runSearchAgain(historyJob)}
                  runAgainBusy={runAgainBusy}
                />
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
                    Competitors
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
