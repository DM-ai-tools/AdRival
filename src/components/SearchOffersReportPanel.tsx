"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FunnelStage,
  LookupCoreOfferLadder,
  LookupOffersReport,
  LookupUniqueLandingPage,
  SearchCompetitorAdRecord,
  SearchJob,
} from "@/lib/types";
import { OfferLadderFlow, ladderSteps } from "./OfferLadderFlow";

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
  return (
    <span className={`offers-funnel-badge ${mod}`.trim()}>{value}</span>
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

function ladderAnchorId(id: string): string {
  return `offer-ladder-${String(id).replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
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

function adsForLadder(
  ladder: LookupCoreOfferLadder,
  indexes: ReturnType<typeof buildAdIndexes>,
  ads: SearchCompetitorAdRecord[],
): SearchCompetitorAdRecord[] {
  const seen = new Set<string>();
  const out: SearchCompetitorAdRecord[] = [];

  const push = (ad?: SearchCompetitorAdRecord | null) => {
    if (!ad || seen.has(ad.id)) return;
    seen.add(ad.id);
    out.push(ad);
  };

  for (const ref of ladder.sourceAdRefs || []) {
    push(
      indexes.byId.get(ref.adId) ||
        (ref.adArchiveId ? indexes.byArchive.get(ref.adArchiveId) : undefined),
    );
  }

  if (out.length) return out;

  const names = new Set(
    (ladder.sourceCompetitors || []).map((n) => n.toLowerCase()),
  );
  const targetLp = lpKey(ladder.landingPageUrl);
  const fromNames = names.size
    ? ads.filter((a) => names.has(a.pageName.toLowerCase()))
    : ads;
  if (targetLp) {
    const matched =
      indexes.byLp.get(targetLp) ||
      fromNames.filter((a) => lpKey(a.landingPageUrl) === targetLp);
    if (matched.length) {
      for (const ad of matched) {
        if (!names.size || names.has(ad.pageName.toLowerCase())) push(ad);
      }
      if (out.length) return out;
    }
  }
  return fromNames;
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
    hydratedJobRef.current = job.id;
    setSelectedIds(fromSession.length > 0 ? fromSession : fromJob);
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
          <h2>Offers dashboard (keyword search)</h2>
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

      {selectCompetitors && roster.length > 0 && !running ? (
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
              {job.progress.offersPhase || "Offers analysis"}
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

export function SearchOffersDashboard({
  job,
}: {
  job: SearchJob;
}) {
  const report = job.offersReport as LookupOffersReport | null | undefined;
  const [ads, setAds] = useState<SearchCompetitorAdRecord[]>([]);
  const [adsLoaded, setAdsLoaded] = useState(false);
  const [section, setSection] = useState<
    "ads" | "pages" | "creatives" | "services" | "ladders"
  >("pages");
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  const [selectedPageKey, setSelectedPageKey] = useState<string | null>(null);
  const [funnelFilter, setFunnelFilter] = useState<FunnelStage | "all">("all");
  const [activeCompetitorJump, setActiveCompetitorJump] = useState<string | null>(
    null,
  );
  const [activeLadderJump, setActiveLadderJump] = useState<string | null>(null);
  const [expandedCompetitors, setExpandedCompetitors] = useState<
    Record<string, boolean>
  >({});
  const [showAllPageAds, setShowAllPageAds] = useState(false);

  const needsRawAds =
    section === "ads" || section === "ladders" || section === "pages";

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

  const adIndexes = useMemo(() => buildAdIndexes(ads), [ads]);

  const ladders = useMemo(
    () =>
      (report?.valueLadder?.ladders || []).slice().sort((a, b) => a.rank - b.rank),
    [report?.valueLadder?.ladders],
  );

  const ladderAdsById = useMemo(() => {
    const map = new Map<string, SearchCompetitorAdRecord[]>();
    for (const ladder of ladders) {
      map.set(ladder.id, adsForLadder(ladder, adIndexes, ads));
    }
    return map;
  }, [ladders, adIndexes, ads]);

  const groups = useMemo(() => {
    const selected =
      job.offersCompetitorIds && job.offersCompetitorIds.length > 0
        ? new Set(job.offersCompetitorIds)
        : null;
    const map = new Map<
      string,
      { id: string; name: string; ads: SearchCompetitorAdRecord[] }
    >();
    for (const ad of ads) {
      if (selected && !selected.has(ad.competitorId)) continue;
      const key = ad.competitorId || ad.pageName;
      const existing = map.get(key);
      if (existing) existing.ads.push(ad);
      else map.set(key, { id: key, name: ad.pageName, ads: [ad] });
    }
    return Array.from(map.values()).sort((a, b) => b.ads.length - a.ads.length);
  }, [ads, job.offersCompetitorIds]);

  const creatives = report?.adCopy?.creatives || [];
  const uniqueOffers = report?.adCopy?.uniqueOffers || [];
  const serviceNodes = report?.services?.nodes || [];
  const reportPages = report?.landingPages?.pages || [];

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

  const selectedServiceNode = useMemo(() => {
    if (!serviceNodes.length) return null;
    if (!selectedService) return serviceNodes[0];
    return (
      serviceNodes.find((n) => n.service === selectedService) || serviceNodes[0]
    );
  }, [selectedService, serviceNodes]);

  if (!report || report.status !== "completed") {
    return (
      <section className="panel">
        <p className="empty-hint">Generate offers dashboard to view ladders.</p>
      </section>
    );
  }

  const uniqueLpCount =
    report.landingPages?.uniqueUrls ||
    pageListOffer.length + pageListOther.length;

  return (
    <section className="panel">
      <div className="results-head">
        <h2>
          Offers dashboard
          <span className="muted-inline">
            {" "}
            · {groups.length || "—"} competitors ·{" "}
            {adsLoaded ? ads.length : report.adsAnalyzed} ads ·{" "}
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
          className={`tab-btn ${section === "services" ? "active" : ""}`}
          onClick={() => setSection("services")}
        >
          By service
        </button>
        <button
          type="button"
          role="tab"
          className={`tab-btn ${section === "ladders" ? "active" : ""}`}
          onClick={() => setSection("ladders")}
        >
          Offer ladders
        </button>
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
                          {p.status}
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
                      {selectedPage.status}
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
              Filter creatives by offer / service promise (not just price)
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

      {section === "services" ? (
        <div className="offers-pages-layout">
          <aside className="offers-page-list panel">
            <h2>Services</h2>
            <p className="muted offers-block-lead">
              {serviceNodes.length} service
              {serviceNodes.length === 1 ? "" : "s"} detected
            </p>
            {serviceNodes.length === 0 ? (
              <p className="empty-hint">
                No service tree yet. Re-analyze offers to rebuild it.
              </p>
            ) : (
              <ul>
                {serviceNodes.map((n) => (
                  <li key={n.service}>
                    <button
                      type="button"
                      className={`offers-page-row ${selectedServiceNode?.service === n.service ? "active" : ""}`}
                      onClick={() => setSelectedService(n.service)}
                    >
                      <span className="offers-page-row-url">{n.service}</span>
                      <span className="muted">
                        {n.landingPageCount} LP
                        {n.landingPageCount === 1 ? "" : "s"} · {n.adCount} ad
                        {n.adCount === 1 ? "" : "s"}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
          <section className="offers-page-detail panel">
            {!selectedServiceNode ? (
              <p className="empty-hint">Select a service to browse offers.</p>
            ) : (
              <div className="offers-tree">
                <div className="offers-tree-node">
                  <h2>{selectedServiceNode.service}</h2>
                  <div className="offers-meta-row">
                    <span>
                      {selectedServiceNode.adCount} ad
                      {selectedServiceNode.adCount === 1 ? "" : "s"}
                    </span>
                    <span>
                      {selectedServiceNode.landingPageCount} landing page
                      {selectedServiceNode.landingPageCount === 1 ? "" : "s"}
                    </span>
                    {selectedServiceNode.funnelStages
                      ? (
                          Object.entries(selectedServiceNode.funnelStages) as [
                            FunnelStage,
                            number,
                          ][]
                        )
                          .filter(([, count]) => count > 0)
                          .map(([stage, count]) => (
                            <span key={stage} className="offers-meta-row">
                              <FunnelBadge stage={stage} />
                              <span className="muted">{count}</span>
                            </span>
                          ))
                      : null}
                  </div>
                </div>
                <div className="offers-tree-branch">
                  {selectedServiceNode.landingPages.length === 0 ? (
                    <p className="empty-hint">No landing pages under this service.</p>
                  ) : (
                    selectedServiceNode.landingPages.map((lp) => (
                      <div key={lp.matchKey} className="offers-tree-node">
                        <div className="offers-meta-row">
                          <a href={lp.url} target="_blank" rel="noreferrer">
                            {shortUrl(lp.url).slice(0, 64)}
                          </a>
                          <FunnelBadge stage={lp.funnelStage} />
                          <span className="muted">
                            {lp.adCount} ad{lp.adCount === 1 ? "" : "s"}
                          </span>
                        </div>
                        {lp.primaryOffer ? (
                          <p className="offers-page-offer-inline">{lp.primaryOffer}</p>
                        ) : null}
                        {lp.cta ? <p className="muted">CTA: {lp.cta}</p> : null}
                        <div className="offers-tree-branch">
                          {!lp.ads || lp.ads.length === 0 ? (
                            <p className="muted">No ads attached.</p>
                          ) : (
                            <div className="offers-card-grid">
                              {lp.ads.map((ad) => (
                                <article
                                  key={`${lp.matchKey}-${ad.creativeId}`}
                                  className="offers-card"
                                >
                                  <div className="offers-meta-row">
                                    <FunnelBadge stage={ad.funnelStage} />
                                    <span className="offers-count">
                                      {ad.adCount} ad
                                      {ad.adCount === 1 ? "" : "s"}
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
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {section === "ladders" ? (
        <div className="offers-core-ladders offers-core-ladders-wide">
          {ladders.length === 0 ? (
            <p className="empty-hint">No offer ladders for this run yet.</p>
          ) : (
            <>
              <nav
                className="offers-competitor-jump"
                aria-label="Jump to core offer ladder"
              >
                {ladders.map((ladder) => (
                  <button
                    key={ladder.id}
                    type="button"
                    className={`offers-competitor-jump-box${
                      activeLadderJump === ladder.id ? " active" : ""
                    }`}
                    onClick={() => {
                      setActiveLadderJump(ladder.id);
                      document
                        .getElementById(ladderAnchorId(ladder.id))
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    <span className="offers-competitor-jump-name">
                      {ladder.coreOffer}
                    </span>
                    <span className="offers-competitor-jump-count">
                      Ladder {ladder.rank}
                      {` · ${ladderSteps(ladder).length} steps`}
                    </span>
                  </button>
                ))}
              </nav>
              {ladders.map((ladder) => {
            const refs = ladderAdsById.get(ladder.id) || [];
            const fallbackRefs = ladder.sourceAdRefs || [];
            return (
              <article
                key={ladder.id}
                id={ladderAnchorId(ladder.id)}
                className="offers-core-ladder"
              >
                <header className="offers-core-ladder-head">
                  <div className="offers-meta-row">
                    <span className="offers-card-kicker">Ladder {ladder.rank}</span>
                    <span className="muted">
                      {ladderSteps(ladder).length} steps ·{" "}
                      {ladder.sourceCompetitors?.length || 0} competitor
                      {(ladder.sourceCompetitors?.length || 0) === 1 ? "" : "s"}
                      {refs.length ? ` · ${refs.length} referenced ads` : ""}
                    </span>
                  </div>
                  <h3>{ladder.coreOffer}</h3>
                  {ladder.details ? <p>{ladder.details}</p> : null}
                  <div className="offers-meta-row">
                    {ladder.cta ? <span>CTA: {ladder.cta}</span> : null}
                    {ladder.pricing ? <span>Pricing: {ladder.pricing}</span> : null}
                    {ladder.landingPageUrl ? (
                      <a href={ladder.landingPageUrl} target="_blank" rel="noreferrer">
                        {shortUrl(ladder.landingPageUrl)}
                      </a>
                    ) : null}
                  </div>
                  {ladder.sourceCompetitors?.length ? (
                    <p className="muted">
                      Sources: {ladder.sourceCompetitors.join(", ")}
                    </p>
                  ) : null}
                </header>

                <OfferLadderFlow ladder={ladder} />

                {ladder.adOffers?.length ? (
                  <div className="offers-core-ladder-ads">
                    <p className="muted offers-block-lead">Mapped ad-copy offers</p>
                    {ladder.adOffers.map((ad) => (
                      <AdCopyBlock
                        key={`${ladder.id}-${ad.creativeId}`}
                        title={ad.hook || ad.offer}
                        body={ad.sampleCopy || ad.offer}
                        cta={ad.cta}
                        landingPageUrl={ad.landingPageUrl}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="offers-core-ladder-empty">
                    {ladder.emptyMessage || "No mapped ad-copy offers."}
                  </p>
                )}

                <div className="offers-core-ladder-ads">
                  <p className="muted offers-block-lead">Ad references</p>
                  {refs.length ? (
                    <div className="offers-ad-copy-list">
                      {refs.map((ad) => (
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
                  ) : fallbackRefs.length ? (
                    <div className="offers-ad-copy-list">
                      {fallbackRefs.map((r) => (
                        <AdCopyBlock
                          key={`${r.competitorId}:${r.adId}`}
                          competitorName={r.competitorName}
                          title={r.title}
                          body={r.body}
                          cta={r.ctaText}
                          landingPageUrl={r.landingPageUrl}
                          adLibraryUrl={r.adLibraryUrl}
                        />
                      ))}
                    </div>
                  ) : (
                    <p className="empty-hint">No ad references attached to this ladder.</p>
                  )}
                </div>

                <div className="offers-meta-row">
                  <Link
                    className="ghost-btn"
                    href={`/search-offers/${encodeURIComponent(job.id)}/${encodeURIComponent(ladder.id)}`}
                  >
                    Open ladder details
                  </Link>
                </div>
              </article>
            );
              })}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}


