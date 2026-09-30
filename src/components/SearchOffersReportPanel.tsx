"use client";

import { offersPhaseLabel, statusLabel } from "@/lib/progressLabels";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FunnelStage,
  LookupOffersReport,
  LookupUniqueLandingPage,
  SearchCompetitorAdRecord,
  SearchJob,
} from "@/lib/types";
import { visibleOfferLadders } from "./OfferLadderFlow";
import { OfferWorkspace } from "./OfferWorkspace";
import { OfferInsights } from "./OfferInsights";
import {
  offerFitsSearchedService,
  searchedServiceFocus,
} from "@/lib/pipeline/offerServiceFocus";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function lpKey(url?: string | null): string {
  return (url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function FunnelBadge({ stage }: { stage?: FunnelStage | null }) {
  const value = stage || "unknown";
  const mod =
    value === "TOFU"
      ? "offers-funnel-tofu"
      : value === "MOFU"
        ? "offers-funnel-mofu"
        : value === "BOFU"
          ? "offers-funnel-bofu"
          : "";
  // Plain words with the marketing term in the tooltip.
  const words: Record<string, [string, string]> = {
    TOFU: ["Awareness", "Top of funnel (TOFU): reaching people who don't know the business yet"],
    MOFU: ["Consideration", "Middle of funnel (MOFU): people comparing options"],
    BOFU: ["Ready to buy", "Bottom of funnel (BOFU): people ready to book or buy"],
  };
  const [label, title] = words[value] || ["Stage unclear", "The funnel stage could not be told from the ad"];
  return (
    <span className={`offers-funnel-badge ${mod}`.trim()} title={title}>
      {label}
    </span>
  );
}

function isWeakOfferLabel(offer: string): boolean {
  const t = (offer || "").trim();
  if (!t || t.length < 6) return true;
  if (
    /^(?:\$|₹|£|€)\s?\d[\d,.]*(?:\s*\/\s*\w+)?\s*[·•|\-–—]\s*/i.test(t) &&
    t.length < 48
  ) {
    return true;
  }
  if (
    /^(get offer|learn more|see details|apply now|shop now|sign up|click here|get started|book now)$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:\$|₹|£|€)\s?\d[\d,.]*(?:\s*\/\s*\w+)?$/i.test(t)) return true;
  return false;
}

/** Prefer a readable promise; fall back to hook when label is price·CTA. */
function displayOfferLabel(input: {
  offer: string;
  pricing?: string | null;
  sampleHooks?: string[] | null;
  cta?: string | null;
}): string {
  const offer = (input.offer || "").trim();
  if (offer && !isWeakOfferLabel(offer)) return offer;
  const hook = (input.sampleHooks || []).find(
    (h) => h && !isWeakOfferLabel(h) && h.length >= 10,
  );
  if (hook) return hook;
  if (offer && input.pricing && !offer.includes(input.pricing)) {
    return `${offer} (${input.pricing})`;
  }
  return offer || input.cta || "Offer";
}

function isLegalOrUtilityPage(url: string, headline?: string | null): boolean {
  const hay = `${url} ${headline || ""}`.toLowerCase();
  return /privacy|terms|cookie|disclaimer|legal|policy|login|signin|sign-in|cart|checkout/i.test(
    hay,
  );
}

const ADS_PER_COMPETITOR_CAP = 12;
const ADS_PER_PAGE_CAP = 24;

function competitorAnchorId(id: string): string {
  return `ads-competitor-${String(id).replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function buildAdIndexes(ads: SearchCompetitorAdRecord[]) {
  const byId = new Map<string, SearchCompetitorAdRecord>();
  const byArchive = new Map<string, SearchCompetitorAdRecord>();
  const byLp = new Map<string, SearchCompetitorAdRecord[]>();
  for (const ad of ads) {
    byId.set(ad.id, ad);
    if (ad.adArchiveId) byArchive.set(ad.adArchiveId, ad);
    const key = lpKey(ad.landingPageUrl);
    if (!key) continue;
    const list = byLp.get(key);
    if (list) list.push(ad);
    else byLp.set(key, [ad]);
  }
  return { byId, byArchive, byLp };
}

function AdCopyBlock({
  title,
  body,
  cta,
  landingPageUrl,
  adLibraryUrl,
  competitorName,
}: {
  title?: string | null;
  body?: string | null;
  cta?: string | null;
  landingPageUrl?: string | null;
  adLibraryUrl?: string | null;
  competitorName?: string | null;
}) {
  return (
    <article className="offers-ad-copy">
      {competitorName ? (
        <span className="offers-card-kicker">{competitorName}</span>
      ) : null}
      {title ? <h4>{title}</h4> : null}
      {body ? <p className="offers-ad-body">{body}</p> : null}
      {!title && !body ? (
        <p className="muted">No headline or body copy stored for this ad.</p>
      ) : null}
      <div className="offers-meta-row">
        {cta ? <span>CTA: {cta}</span> : null}
        {landingPageUrl ? (
          <a href={landingPageUrl} target="_blank" rel="noreferrer">
            {shortUrl(landingPageUrl)}
          </a>
        ) : null}
        {adLibraryUrl ? (
          <a href={adLibraryUrl} target="_blank" rel="noreferrer">
            Open ad
          </a>
        ) : null}
      </div>
    </article>
  );
}

export function SearchOffersTeaser({
  job,
  competitors,
  selectCompetitors,
  onGenerate,
  generating,
  onStop,
}: {
  job: SearchJob;
  /** When selectCompetitors is true, used for the picker. */
  competitors?: Array<{
    id: string;
    pageName: string;
    activeAdsCount?: number;
    platform?: string | null;
  }>;
  /** Fresh runs only — require choosing competitors before analysis. */
  selectCompetitors?: boolean;
  onGenerate: (opts?: { competitorIds?: string[] }) => void;
  generating?: boolean;
  onStop?: () => void;
}) {
  const report = job.offersReport;
  const running = job.progress.stage === "analyzing_offers";
  const [stopping, setStopping] = useState(false);
  const roster = competitors || [];
  const rosterIds = useMemo(() => roster.map((c) => c.id), [roster]);
  const rosterIdSet = useMemo(() => new Set(rosterIds), [rosterIds]);
  const storageKey = `offers-comp-sel:${job.id}`;

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Once a report exists the picker folds to one line; it opens again on demand.
  const reportReady = job.offersReport?.status === "completed";
  const [pickerOpen, setPickerOpen] = useState(false);
  const hydratedJobRef = useRef<string | null>(null);

  // Restore selection when returning to this tab / remounting.
  // Prefer in-progress session picks, then last analyzed set on the job.
  useEffect(() => {
    if (!selectCompetitors) return;
    if (rosterIdSet.size === 0) return;

    // Already hydrated for this job — only drop ids that left the roster.
    if (hydratedJobRef.current === job.id) {
      setSelectedIds((prev) => prev.filter((id) => rosterIdSet.has(id)));
      return;
    }

    const filterToRoster = (ids: string[]) =>
      ids.filter((id) => rosterIdSet.has(id));

    let fromSession: string[] = [];
    try {
      const raw =
        typeof sessionStorage !== "undefined"
          ? sessionStorage.getItem(storageKey)
          : null;
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          fromSession = filterToRoster(
            parsed.filter((x): x is string => typeof x === "string"),
          );
        }
      }
    } catch {
      /* ignore */
    }

    const fromJob = filterToRoster(job.offersCompetitorIds || []);
    // First visit: start with the competitors that advertise most (10+ active
    // ads), or everyone, so the build button is ready to press.
    const busy = roster.filter((c) => (c.activeAdsCount ?? 0) >= 10).map((c) => c.id);
    const defaults = busy.length ? busy : rosterIds;
    hydratedJobRef.current = job.id;
    setSelectedIds(fromSession.length > 0 ? fromSession : fromJob.length > 0 ? fromJob : defaults);
  }, [
    selectCompetitors,
    job.id,
    storageKey,
    rosterIdSet,
    job.offersCompetitorIds,
  ]);

  // Persist picks so Preview ↔ Offers tab switches keep the checkboxes.
  useEffect(() => {
    if (!selectCompetitors) return;
    try {
      if (typeof sessionStorage !== "undefined") {
        sessionStorage.setItem(storageKey, JSON.stringify(selectedIds));
      }
    } catch {
      /* ignore */
    }
  }, [selectedIds, storageKey, selectCompetitors]);

  const lastAnalyzedIds = useMemo(() => {
    const ids = (job.offersCompetitorIds || []).filter((id) =>
      rosterIdSet.has(id),
    );
    return ids;
  }, [job.offersCompetitorIds, rosterIdSet]);

  const lastAnalyzedNames = useMemo(() => {
    if (!lastAnalyzedIds.length) return [];
    const byId = new Map(roster.map((c) => [c.id, c.pageName]));
    return lastAnalyzedIds.map((id) => byId.get(id) || id);
  }, [lastAnalyzedIds, roster]);

  async function stopOffers() {
    setStopping(true);
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jobId: job.id }),
      });
      onStop?.();
    } finally {
      setStopping(false);
    }
  }

  function toggleId(id: string) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  const canGenerate =
    !running &&
    !generating &&
    (!selectCompetitors || selectedIds.length > 0);

  return (
    <section className="panel offers-teaser">
      <div className="offers-teaser-main">
        <div>
          <h2>{reportReady ? "Offers analysis" : "Build the offers dashboard"}</h2>
          <p className="muted">
            {running
              ? job.progress.message
              : report?.status === "completed"
                ? `${report.adsAnalyzed} cached ads analyzed · ${report.valueLadder?.ladders.length || 0} deduped offer ladders`
                : report?.status === "failed"
                  ? report.error || job.progress.message || "Offers analysis failed. Try again."
                  : selectCompetitors
                    ? "Choose which competitors to include, then generate the offer intelligence dashboard."
                    : "Analyze ads from competitors with 10+ active ads and build a deduped offer intelligence dashboard."}
          </p>
          {report?.status === "completed" ? (
            <p className="muted" style={{ marginTop: 6 }}>
              Re-analyze reuses ads already stored for this run and rebuilds
              creatives, services, funnel stages, and ladders.
              {lastAnalyzedNames.length > 0 ? (
                <>
                  {" "}
                  Last run used {lastAnalyzedNames.length} competitor
                  {lastAnalyzedNames.length === 1 ? "" : "s"}:{" "}
                  <strong>{lastAnalyzedNames.join(", ")}</strong>.
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div className="offers-teaser-actions">
          {running ? (
            <button
              type="button"
              className="danger-btn"
              disabled={stopping}
              onClick={() => void stopOffers()}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : null}
          <button
            type="button"
            className="search-btn"
            disabled={!canGenerate}
            onClick={() =>
              onGenerate(
                selectCompetitors
                  ? { competitorIds: selectedIds }
                  : undefined,
              )
            }
          >
            {running || generating
              ? "Analyzing offers…"
              : report?.status === "completed"
                ? selectCompetitors
                  ? `Re-analyze selected (${selectedIds.length})`
                  : "Re-analyze offers"
                : selectCompetitors
                  ? `Generate for selected (${selectedIds.length})`
                  : "Generate offers dashboard"}
          </button>
        </div>
      </div>

      {selectCompetitors && roster.length > 0 && !running && reportReady && !pickerOpen ? (
        <div className="offers-competitor-picker offers-competitor-picker-collapsed">
          <span>
            {selectedIds.length || lastAnalyzedIds.length} competitor
            {(selectedIds.length || lastAnalyzedIds.length) === 1 ? "" : "s"} analysed
          </span>
          <button type="button" className="link-btn" onClick={() => setPickerOpen(true)}>
            Change competitors
          </button>
        </div>
      ) : null}

      {selectCompetitors && roster.length > 0 && !running && (!reportReady || pickerOpen) ? (
        <div className="offers-competitor-picker">
          <div className="offers-competitor-picker-bar">
            <span className="search-label" style={{ margin: 0 }}>
              Competitors for offers analysis
              {selectedIds.length > 0
                ? ` · ${selectedIds.length} selected`
                : ""}
            </span>
            <div className="offers-competitor-picker-actions">
              {lastAnalyzedIds.length > 0 ? (
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={generating}
                  onClick={() => setSelectedIds(lastAnalyzedIds)}
                  title="Restore the competitors from the last offers analysis"
                >
                  Restore last run
                </button>
              ) : null}
              <button
                type="button"
                className="ghost-btn"
                disabled={generating}
                onClick={() => setSelectedIds(roster.map((c) => c.id))}
              >
                Select all
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={generating || selectedIds.length === 0}
                onClick={() => setSelectedIds([])}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="offers-competitor-picker-grid" role="group">
            {roster.map((c) => {
              const checked = selectedIds.includes(c.id);
              const inLastRun = lastAnalyzedIds.includes(c.id);
              return (
                <label
                  key={c.id}
                  className={`offers-competitor-pick${checked ? " active" : ""}${inLastRun && !checked ? " offers-competitor-pick-prior" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={generating}
                    onChange={() => toggleId(c.id)}
                  />
                  <span className="offers-competitor-pick-body">
                    <span className="offers-competitor-pick-name">
                      {c.pageName}
                      {inLastRun ? (
                        <span className="offers-competitor-pick-badge">
                          Last run
                        </span>
                      ) : null}
                    </span>
                    <span className="offers-competitor-pick-meta">
                      {typeof c.activeAdsCount === "number"
                        ? `${c.activeAdsCount} active ads`
                        : "—"}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {selectedIds.length === 0 ? (
            <p className="form-hint">
              {lastAnalyzedIds.length > 0
                ? "Selection cleared — use Restore last run, or select competitors again before re-analyzing."
                : "Select one or more competitors (or Select all) before generating."}
            </p>
          ) : null}
        </div>
      ) : null}
      {running ? (
        <div className="offers-analysis-progress" aria-live="polite">
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              {offersPhaseLabel(job.progress.offersPhase) || "Offers analysis"}
              {job.progress.offersCurrentName
                ? ` · ${job.progress.offersCurrentName}`
                : ""}
            </span>
            <span className="offers-analysis-progress-count">
              {job.progress.offersTotal
                ? `${job.progress.offersDone ?? 0}/${job.progress.offersTotal}`
                : ""}
              {job.progress.offersTotal ? " · " : ""}
              {`${Math.round(job.progress.offersPct ?? 0)}%`}
            </span>
          </div>
          <div className="progress-bar-track offers-analysis-bar">
            <div
              className="progress-bar-fill progress-bar-offers"
              style={{
                width: `${Math.min(100, Math.max(job.progress.offersPct ?? 0, 1))}%`,
              }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Tab → name used on its download button. */
const SECTION_EXPORT_LABEL: Record<"insights" | "ads" | "pages" | "creatives" | "ladders", string> = {
  insights: "insights (full report)",
  ads: "ads by competitor",
  pages: "landing pages",
  creatives: "creatives & offers",
  ladders: "offer ladders",
};

export function SearchOffersDashboard({
  job,
}: {
  job: SearchJob;
}) {
  const report = job.offersReport as LookupOffersReport | null | undefined;
  const [ads, setAds] = useState<SearchCompetitorAdRecord[]>([]);
  const [adsLoaded, setAdsLoaded] = useState(false);
  const [section, setSection] = useState<
    "insights" | "ads" | "pages" | "creatives" | "ladders"
  >("insights");
  /** Offer to open on the ladders tab when arriving from Insights. */
  const [ladderFocus, setLadderFocus] = useState<{ id: string; competitor: string } | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  const [selectedPageKey, setSelectedPageKey] = useState<string | null>(null);
  const [funnelFilter, setFunnelFilter] = useState<FunnelStage | "all">("all");
  const [activeCompetitorJump, setActiveCompetitorJump] = useState<string | null>(
    null,
  );
  const [expandedCompetitors, setExpandedCompetitors] = useState<
    Record<string, boolean>
  >({});
  const [showAllPageAds, setShowAllPageAds] = useState(false);

  const needsRawAds =
    section === "insights" || section === "ads" || section === "ladders" || section === "pages";

  useEffect(() => {
    if (!job.id || report?.status !== "completed" || !needsRawAds) return;
    if (adsLoaded) return;
    let cancelled = false;
    void fetch(`/api/search/status?jobId=${encodeURIComponent(job.id)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.ads)) return;
        setAds(data.ads as SearchCompetitorAdRecord[]);
        setAdsLoaded(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, report?.updatedAt, report?.status, needsRawAds, adsLoaded]);

  useEffect(() => {
    setAdsLoaded(false);
    setAds([]);
  }, [job.id, report?.updatedAt]);

  const serviceFocus = useMemo(
    () =>
      searchedServiceFocus(
        job.keywords?.length ? job.keywords : job.keyword ? [job.keyword] : [],
        job.selectedCategory?.label || null,
      ),
    [job.keywords, job.keyword, job.selectedCategory?.label],
  );

  const visibleAds = useMemo(
    () =>
      ads.filter((ad) =>
        offerFitsSearchedService(
          `${ad.title || ""} ${ad.body || ""} ${ad.ctaText || ""}`,
          serviceFocus,
        ),
      ),
    [ads, serviceFocus],
  );

  const adIndexes = useMemo(() => buildAdIndexes(visibleAds), [visibleAds]);

  const ladders = useMemo(
    () => visibleOfferLadders(report?.valueLadder?.ladders || [], serviceFocus),
    [report?.valueLadder?.ladders, serviceFocus],
  );

  const groups = useMemo(() => {
    const selected =
      job.offersCompetitorIds && job.offersCompetitorIds.length > 0
        ? new Set(job.offersCompetitorIds)
        : null;
    const map = new Map<
      string,
      { id: string; name: string; ads: SearchCompetitorAdRecord[] }
    >();
    for (const ad of visibleAds) {
      if (selected && !selected.has(ad.competitorId)) continue;
      const key = ad.competitorId || ad.pageName;
      const existing = map.get(key);
      if (existing) existing.ads.push(ad);
      else map.set(key, { id: key, name: ad.pageName, ads: [ad] });
    }
    return Array.from(map.values()).sort((a, b) => b.ads.length - a.ads.length);
  }, [visibleAds, job.offersCompetitorIds]);

  const creatives = useMemo(
    () =>
      (report?.adCopy?.creatives || []).filter((creative) =>
        offerFitsSearchedService(
          `${creative.offer} ${creative.hook} ${creative.serviceTargeted || ""} ${creative.sampleCopy || ""} ${creative.cta || ""}`,
          serviceFocus,
          { requireMatch: true },
        ),
      ),
    [report?.adCopy?.creatives, serviceFocus],
  );
  const uniqueOffers = useMemo(
    () =>
      (report?.adCopy?.uniqueOffers || []).filter((line) =>
        offerFitsSearchedService(
          `${line.offer} ${line.pricing || ""} ${line.cta || ""} ${(line.sampleHooks || []).join(" ")}`,
          serviceFocus,
          { requireMatch: true },
        ),
      ),
    [report?.adCopy?.uniqueOffers, serviceFocus],
  );
  const reportPages = useMemo(
    () =>
      (report?.landingPages?.pages || []).filter((page) =>
        offerFitsSearchedService(
          `${page.primaryOffer || ""} ${page.headline || ""} ${page.serviceTargeted || ""} ${page.summary || ""} ${page.cta || ""}`,
          serviceFocus,
          {
            requireMatch: page.status === "completed" && Boolean(page.primaryOffer),
          },
        ),
      ),
    [report?.landingPages?.pages, serviceFocus],
  );

  const offerPages = useMemo(() => {
    const list = reportPages.filter(
      (p) =>
        p.status === "completed" &&
        p.primaryOffer &&
        !isLegalOrUtilityPage(p.url, p.headline),
    );
    return [...list].sort(
      (a, b) =>
        (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
        b.adCount - a.adCount,
    );
  }, [reportPages]);

  const otherPages = useMemo(() => {
    const list = reportPages.filter(
      (p) =>
        !(
          p.status === "completed" &&
          p.primaryOffer &&
          !isLegalOrUtilityPage(p.url, p.headline)
        ),
    );
    return [...list].sort(
      (a, b) =>
        (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
        b.adCount - a.adCount,
    );
  }, [reportPages]);

  /** Fallback unique LPs from raw ads when the report has no page tree yet. */
  const fallbackPages = useMemo((): LookupUniqueLandingPage[] => {
    if (reportPages.length > 0) return [];
    const out: LookupUniqueLandingPage[] = [];
    for (const [matchKey, list] of adIndexes.byLp) {
      const sample = list[0];
      const blob = list
        .slice(0, 6)
        .map((a) => `${a.title || ""} ${a.body || ""}`)
        .join(" ");
      const kw = (job.keywords?.length ? job.keywords : [job.keyword])
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      let relevanceScore = 0;
      if (kw) {
        const tokens = kw.split(/\s+/).filter((t) => t.length >= 3);
        const hay = `${matchKey} ${blob}`.toLowerCase();
        const hits = tokens.filter((t) => hay.includes(t)).length;
        relevanceScore = tokens.length
          ? Math.min(1, hits / Math.min(4, tokens.length))
          : 0;
      }
      out.push({
        url: sample.landingPageUrl || `https://${matchKey}`,
        matchKey,
        adCount: list.length,
        status: "skipped",
        headline: sample.title || null,
        primaryOffer: null,
        ads: [],
        relevanceScore,
      });
    }
    return out.sort(
      (a, b) =>
        (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
        b.adCount - a.adCount,
    );
  }, [reportPages.length, adIndexes.byLp, job.keyword, job.keywords]);

  const pageListOffer = offerPages.length ? offerPages : fallbackPages;
  const pageListOther = offerPages.length ? otherPages : [];

  const selectedPage: LookupUniqueLandingPage | null = useMemo(() => {
    const all = [...pageListOffer, ...pageListOther];
    if (!all.length) return null;
    if (!selectedPageKey) return all[0];
    return all.find((p) => p.matchKey === selectedPageKey) || all[0];
  }, [selectedPageKey, pageListOffer, pageListOther]);

  const selectedPageRawAds = useMemo(() => {
    if (!selectedPage) return [] as SearchCompetitorAdRecord[];
    const fromIndex = adIndexes.byLp.get(lpKey(selectedPage.url)) || [];
    if (fromIndex.length) return fromIndex;
    // Also try matchKey directly
    return adIndexes.byLp.get(selectedPage.matchKey) || [];
  }, [selectedPage, adIndexes.byLp]);

  const funnelDistribution = useMemo(() => {
    const counts: Partial<Record<FunnelStage, number>> = {};
    for (const c of creatives) {
      const stage: FunnelStage = c.funnelStage || "unknown";
      counts[stage] = (counts[stage] || 0) + c.adCount;
    }
    return (["TOFU", "MOFU", "BOFU", "unknown"] as FunnelStage[])
      .map((stage) => ({ stage, count: counts[stage] || 0 }))
      .filter((row) => row.count > 0);
  }, [creatives]);

  const filteredCreatives = useMemo(() => {
    let list = creatives;
    if (funnelFilter !== "all") {
      list = list.filter((c) => (c.funnelStage || "unknown") === funnelFilter);
    }
    if (selectedOffer) {
      const offerKey = selectedOffer.toLowerCase();
      list = list.filter(
        (c) =>
          c.offer.toLowerCase().includes(offerKey) ||
          c.hook.toLowerCase().includes(offerKey) ||
          (c.serviceTargeted || "").toLowerCase().includes(offerKey),
      );
    }
    return list.slice(0, 48);
  }, [creatives, funnelFilter, selectedOffer]);

  if (!report || report.status !== "completed") {
    return (
      <section className="panel">
        <p className="empty-hint">Generate offers dashboard to view ladders.</p>
      </section>
    );
  }

  const uniqueLpCount = pageListOffer.length + pageListOther.length;

  return (
    <section className="panel">
      <div className="results-head">
        <h2>
          Offers dashboard
          <span className="muted-inline">
            {" "}
            · {groups.length || "—"} competitors ·{" "}
            {adsLoaded ? visibleAds.length : report.adsAnalyzed} ads ·{" "}
            {creatives.length} creatives · {uniqueLpCount} landing pages ·{" "}
            {ladders.length} ladders
          </span>
        </h2>
      </div>

      {funnelDistribution.length > 0 ? (
        <div className="offers-funnel-summary" aria-label="Funnel distribution">
          {funnelDistribution.map((row) => (
            <button
              key={row.stage}
              type="button"
              className={`offers-funnel-chip ${funnelFilter === row.stage ? "active" : ""}`}
              onClick={() => {
                setFunnelFilter((prev) =>
                  prev === row.stage ? "all" : row.stage,
                );
                setSection("creatives");
              }}
            >
              <FunnelBadge stage={row.stage} />
              <span>
                {row.count} ad{row.count === 1 ? "" : "s"}
              </span>
            </button>
          ))}
          {funnelFilter !== "all" ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => setFunnelFilter("all")}
            >
              Clear funnel filter
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="tab-bar results-subtabs results-subtabs-wide" role="tablist">
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "insights" ? "active" : ""}`}
          onClick={() => setSection("insights")}
        >
          Insights
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "pages" ? "active" : ""}`}
          onClick={() => {
            setSection("pages");
            setShowAllPageAds(false);
          }}
        >
          By landing page ({uniqueLpCount})
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "ads" ? "active" : ""}`}
          onClick={() => setSection("ads")}
        >
          Ads by competitor
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "creatives" ? "active" : ""}`}
          onClick={() => setSection("creatives")}
        >
          Creatives & offers
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "ladders" ? "active" : ""}`}
          onClick={() => {
            setLadderFocus(null);
            setSection("ladders");
          }}
        >
          Offer ladders
        </button>
      </div>

      <div className="offers-export-row">
        <a
          className="ghost-btn"
          href={`/api/search/offers-report/export?jobId=${encodeURIComponent(job.id)}&part=${section === "insights" ? "all" : section}`}
          download
        >
          Download {SECTION_EXPORT_LABEL[section]} (Excel)
        </a>
        <a
          className="ghost-btn"
          href={`/api/search/offers-report/export?jobId=${encodeURIComponent(job.id)}&part=all`}
          download
        >
          Download full report (Excel)
        </a>
        <span className="muted">Every ad analysed, creatives, unique offers, ladders and landing pages — one sheet each.</span>
      </div>

      {section === "pages" ? (
        pageListOffer.length + pageListOther.length === 0 ? (
          <p className="empty-hint">
            {needsRawAds && !adsLoaded
              ? "Loading landing pages…"
              : "No unique landing pages found for this run."}
          </p>
        ) : (
          <div className="offers-pages-layout">
            <aside className="offers-page-list panel">
              <h2>Landing pages</h2>
              <p className="muted offers-block-lead">
                Ranked by service / offer relevance, then ad volume
                {pageListOffer.length
                  ? ` · ${pageListOffer.length} destination${pageListOffer.length === 1 ? "" : "s"}`
                  : ""}
                {pageListOther.length
                  ? ` · ${pageListOther.length} other / skipped`
                  : ""}
              </p>
              <ul>
                {pageListOffer.map((p) => (
                  <li key={p.matchKey}>
                    <button
                      type="button"
                      className={`offers-page-row ${selectedPage?.matchKey === p.matchKey ? "active" : ""}`}
                      onClick={() => {
                        setSelectedPageKey(p.matchKey);
                        setShowAllPageAds(false);
                      }}
                    >
                      <span className="offers-page-row-url" title={p.url}>
                        {p.primaryOffer && !isWeakOfferLabel(p.primaryOffer)
                          ? p.primaryOffer
                          : shortUrl(p.url)}
                      </span>
                      <span className="offers-page-row-meta">
                        <FunnelBadge stage={p.funnelStage} />
                        {(p.relevanceScore || 0) > 0 ? (
                          <span className="muted">
                            {Math.round((p.relevanceScore || 0) * 100)}% match
                          </span>
                        ) : null}
                        <span className="muted">
                          {p.adCount} ad{p.adCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {pageListOther.length > 0 ? (
                  <li className="offers-page-other-label muted">
                    Other destinations
                  </li>
                ) : null}
                {pageListOther.map((p) => (
                  <li key={p.matchKey}>
                    <button
                      type="button"
                      className={`offers-page-row is-muted ${selectedPage?.matchKey === p.matchKey ? "active" : ""}`}
                      onClick={() => {
                        setSelectedPageKey(p.matchKey);
                        setShowAllPageAds(false);
                      }}
                    >
                      <span className="offers-page-row-url" title={p.url}>
                        {shortUrl(p.url)}
                      </span>
                      <span className="offers-page-row-meta">
                        <FunnelBadge stage={p.funnelStage} />
                        {(p.relevanceScore || 0) > 0 ? (
                          <span className="muted">
                            {Math.round((p.relevanceScore || 0) * 100)}% match
                          </span>
                        ) : null}
                        <span className={`status-pill status-${p.status}`}>
                          {statusLabel(p.status)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>

            <section className="offers-page-detail panel">
              {!selectedPage ? (
                <p className="empty-hint">Select a landing page to inspect.</p>
              ) : (
                <div className="offers-tree">
                  <div className="offers-page-detail-head">
                    <div>
                      <h2>Page offer</h2>
                      <a
                        href={selectedPage.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortUrl(selectedPage.url)}
                      </a>
                    </div>
                    <span className={`status-pill status-${selectedPage.status}`}>
                      {statusLabel(selectedPage.status)}
                    </span>
                  </div>
                  <p className="muted">
                    {Math.max(
                      selectedPage.adCount,
                      selectedPageRawAds.length,
                      selectedPage.ads?.length || 0,
                    )}{" "}
                    ad
                    {Math.max(
                      selectedPage.adCount,
                      selectedPageRawAds.length,
                      selectedPage.ads?.length || 0,
                    ) === 1
                      ? ""
                      : "s"}{" "}
                    use this destination
                  </p>

                  {selectedPage.status === "completed" ? (
                    <div className="offers-tree-node">
                      <div className="offers-meta-row">
                        {selectedPage.funnelStage ? (
                          <FunnelBadge stage={selectedPage.funnelStage} />
                        ) : null}
                        {selectedPage.serviceTargeted ? (
                          <span>Service: {selectedPage.serviceTargeted}</span>
                        ) : null}
                      </div>
                      <dl className="offers-detail-grid">
                        {selectedPage.headline ? (
                          <div>
                            <dt>Headline</dt>
                            <dd>{selectedPage.headline}</dd>
                          </div>
                        ) : null}
                        {selectedPage.primaryOffer ? (
                          <div className="offers-detail-wide">
                            <dt>Primary offer</dt>
                            <dd>{selectedPage.primaryOffer}</dd>
                          </div>
                        ) : null}
                        {selectedPage.pricing ? (
                          <div>
                            <dt>Pricing</dt>
                            <dd>{selectedPage.pricing}</dd>
                          </div>
                        ) : null}
                        {selectedPage.cta ? (
                          <div>
                            <dt>CTA</dt>
                            <dd>{selectedPage.cta}</dd>
                          </div>
                        ) : null}
                        {selectedPage.summary ? (
                          <div className="offers-detail-wide">
                            <dt>Summary</dt>
                            <dd>{selectedPage.summary}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  ) : selectedPage.error ? (
                    <p className="muted">{selectedPage.error}</p>
                  ) : null}

                  {selectedPage.ads && selectedPage.ads.length > 0 ? (
                    <div className="offers-tree-branch">
                      <h3>Creative clusters on this page</h3>
                      <div className="offers-card-grid">
                        {selectedPage.ads.map((ad) => (
                          <article
                            key={`${selectedPage.matchKey}-${ad.creativeId}`}
                            className="offers-card"
                          >
                            <div className="offers-meta-row">
                              <FunnelBadge stage={ad.funnelStage} />
                              <span className="offers-count">
                                {ad.adCount} ad{ad.adCount === 1 ? "" : "s"}
                              </span>
                            </div>
                            {ad.hook ? <h4>{ad.hook}</h4> : null}
                            {ad.offer ? (
                              <p className="offers-card-offer">{ad.offer}</p>
                            ) : null}
                            {ad.sampleCopy ? (
                              <p className="offers-ad-body">{ad.sampleCopy}</p>
                            ) : null}
                            <div className="offers-meta-row">
                              {ad.cta ? <span>CTA: {ad.cta}</span> : null}
                              {ad.serviceTargeted ? (
                                <span>Service: {ad.serviceTargeted}</span>
                              ) : null}
                            </div>
                          </article>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="offers-tree-branch">
                    <h3>Ads on this page</h3>
                    {selectedPageRawAds.length === 0 ? (
                      <p className="muted">
                        {needsRawAds && !adsLoaded
                          ? "Loading ad copy…"
                          : "No individual ads matched this URL in the cached set."}
                      </p>
                    ) : (
                      <>
                        <div className="offers-ad-copy-list">
                          {(showAllPageAds
                            ? selectedPageRawAds
                            : selectedPageRawAds.slice(0, ADS_PER_PAGE_CAP)
                          ).map((ad) => (
                            <AdCopyBlock
                              key={ad.id}
                              competitorName={ad.pageName}
                              title={ad.title}
                              body={ad.body}
                              cta={ad.ctaText}
                              landingPageUrl={ad.landingPageUrl}
                              adLibraryUrl={ad.adLibraryUrl}
                            />
                          ))}
                        </div>
                        {selectedPageRawAds.length > ADS_PER_PAGE_CAP ? (
                          <button
                            type="button"
                            className="ghost-btn"
                            onClick={() => setShowAllPageAds((v) => !v)}
                          >
                            {showAllPageAds
                              ? "Show fewer ads"
                              : `Show all ${selectedPageRawAds.length} ads`}
                          </button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        )
      ) : null}

      {section === "ads" ? (
        groups.length === 0 ? (
          <p className="empty-hint">
            {needsRawAds && !adsLoaded
              ? "Loading ads…"
              : "No cached ads for this run yet. Generate or re-analyze the offers dashboard."}
          </p>
        ) : (
          <div className="offers-competitor-groups">
            <nav
              className="offers-competitor-jump"
              aria-label="Jump to competitor ads"
            >
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  className={`offers-competitor-jump-box${
                    activeCompetitorJump === group.id ? " active" : ""
                  }`}
                  onClick={() => {
                    setActiveCompetitorJump(group.id);
                    const el = document.getElementById(
                      competitorAnchorId(group.id),
                    );
                    el?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  <span className="offers-competitor-jump-name">
                    {group.name}
                  </span>
                  <span className="offers-competitor-jump-count">
                    {group.ads.length} ad{group.ads.length === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </nav>
            {groups.map((group) => {
              const expanded = Boolean(expandedCompetitors[group.id]);
              const visible = expanded
                ? group.ads
                : group.ads.slice(0, ADS_PER_COMPETITOR_CAP);
              return (
                <section
                  key={group.id}
                  id={competitorAnchorId(group.id)}
                  className="offers-competitor-group"
                >
                  <header className="offers-competitor-group-head">
                    <h3>{group.name}</h3>
                    <span className="muted">
                      {group.ads.length} ad{group.ads.length === 1 ? "" : "s"}
                    </span>
                  </header>
                  <div className="offers-ad-copy-list">
                    {visible.map((ad) => (
                      <AdCopyBlock
                        key={ad.id}
                        title={ad.title}
                        body={ad.body}
                        cta={ad.ctaText}
                        landingPageUrl={ad.landingPageUrl}
                        adLibraryUrl={ad.adLibraryUrl}
                      />
                    ))}
                  </div>
                  {group.ads.length > ADS_PER_COMPETITOR_CAP ? (
                    <button
                      type="button"
                      className="ghost-btn"
                      onClick={() =>
                        setExpandedCompetitors((prev) => ({
                          ...prev,
                          [group.id]: !expanded,
                        }))
                      }
                    >
                      {expanded
                        ? "Show fewer"
                        : `Show all ${group.ads.length} ads`}
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        )
      ) : null}

      {section === "creatives" ? (
        <div className="offers-pages-layout">
          <aside className="offers-page-list panel">
            <h2>Unique offers</h2>
            <p className="muted offers-block-lead">
              Offers that match the service in your keyword
            </p>
            <ul>
              <li>
                <button
                  type="button"
                  className={`offers-page-row ${!selectedOffer ? "active" : ""}`}
                  onClick={() => setSelectedOffer(null)}
                >
                  <span className="offers-page-row-url">All offers</span>
                  <span className="muted">{creatives.length} creatives</span>
                </button>
              </li>
              {uniqueOffers.slice(0, 30).map((o) => {
                const label = displayOfferLabel({
                  offer: o.offer,
                  pricing: o.pricing,
                  sampleHooks: o.sampleHooks,
                  cta: o.cta,
                });
                return (
                  <li key={o.offer}>
                    <button
                      type="button"
                      className={`offers-page-row ${selectedOffer === o.offer ? "active" : ""}`}
                      onClick={() => setSelectedOffer(o.offer)}
                      title={label}
                    >
                      <span className="offers-page-row-url">{label}</span>
                      <span className="offers-meta-row">
                        <FunnelBadge stage={o.funnelStage} />
                        {o.pricing ? (
                          <span className="muted">{o.pricing}</span>
                        ) : null}
                        <span className="muted">
                          {o.adCount} ad{o.adCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
          <section className="offers-page-detail panel">
            <h2>
              Creatives
              {funnelFilter !== "all" ? ` · ${funnelFilter}` : ""}
              {selectedOffer ? ` · ${selectedOffer}` : ""}
            </h2>
            <p className="muted offers-block-lead">
              Showing {filteredCreatives.length}
              {creatives.length > filteredCreatives.length
                ? ` of ${creatives.length}`
                : ""}{" "}
              unique creatives with TOFU / MOFU / BOFU tags.
            </p>
            {filteredCreatives.length === 0 ? (
              <p className="empty-hint">No creatives match this filter.</p>
            ) : (
              <div className="offers-card-grid">
                {filteredCreatives.map((c) => (
                  <article key={c.id} className="offers-card">
                    <div className="offers-meta-row">
                      <FunnelBadge stage={c.funnelStage} />
                      <span className="offers-card-kicker">
                        {c.adCount} similar ad{c.adCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    <h3>{c.hook}</h3>
                    <p className="offers-card-offer">
                      {displayOfferLabel({
                        offer: c.offer,
                        sampleHooks: [c.hook],
                        cta: c.cta,
                      })}
                    </p>
                    {c.sampleCopy ? (
                      <p className="offers-ad-body">{c.sampleCopy}</p>
                    ) : null}
                    <div className="offers-meta-row">
                      {c.cta ? <span>CTA: {c.cta}</span> : null}
                      {c.serviceTargeted ? (
                        <span>Service: {c.serviceTargeted}</span>
                      ) : null}
                    </div>
                    {c.landingPageUrl ? (
                      <a
                        className="offers-card-link"
                        href={c.landingPageUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortUrl(c.landingPageUrl).slice(0, 56)}
                      </a>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {section === "insights" ? (
        <OfferInsights
          ladders={ladders}
          ads={visibleAds}
          adsLoading={!adsLoaded}
          summary={report.summary || report.valueLadder?.summary || null}
          onOpenOffer={(id, competitor) => {
            setLadderFocus({ id, competitor: competitor || "Other advertisers" });
            setSection("ladders");
          }}
        />
      ) : null}

      {section === "ladders" ? (
        <OfferWorkspace
          key={ladderFocus ? `${ladderFocus.competitor}::${ladderFocus.id}` : "ladders"}
          jobId={job.id}
          offers={ladders}
          ads={visibleAds}
          adsLoading={needsRawAds && !adsLoaded}
          initialSelection={ladderFocus}
        />
      ) : null}
    </section>
  );
}


