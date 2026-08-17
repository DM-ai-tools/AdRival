"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type {
  FunnelStage,
  LookupCoreOfferLadder,
  LookupOffersReport,
  SearchCompetitorAdRecord,
  SearchJob,
} from "@/lib/types";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
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

function lpKey(url?: string | null): string {
  return (url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function competitorAnchorId(id: string): string {
  return `ads-competitor-${String(id).replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function ladderAnchorId(id: string): string {
  return `offer-ladder-${String(id).replace(/[^a-zA-Z0-9_-]+/g, "_")}`;
}

function adsForLadder(
  ladder: LookupCoreOfferLadder,
  ads: SearchCompetitorAdRecord[],
): SearchCompetitorAdRecord[] {
  const byId = new Map(ads.map((a) => [a.id, a]));
  const byArchive = new Map(ads.map((a) => [a.adArchiveId, a]));
  const seen = new Set<string>();
  const out: SearchCompetitorAdRecord[] = [];

  const push = (ad?: SearchCompetitorAdRecord | null) => {
    if (!ad || seen.has(ad.id)) return;
    seen.add(ad.id);
    out.push(ad);
  };

  for (const ref of ladder.sourceAdRefs || []) {
    push(
      byId.get(ref.adId) ||
        (ref.adArchiveId ? byArchive.get(ref.adArchiveId) : undefined),
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
    const matched = fromNames.filter((a) => lpKey(a.landingPageUrl) === targetLp);
    if (matched.length) return matched;
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
  const rosterKey = useMemo(
    () => roster.map((c) => c.id).join("|"),
    [roster],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!selectCompetitors) return;
    // Start empty so analysis does not auto-include everyone
    setSelectedIds([]);
  }, [selectCompetitors, job.id, rosterKey]);

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
            </span>
            <div className="offers-competitor-picker-actions">
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
              return (
                <label
                  key={c.id}
                  className={`offers-competitor-pick${checked ? " active" : ""}`}
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
              Select one or more competitors (or Select all) before generating.
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
  const [section, setSection] = useState<
    "ads" | "creatives" | "services" | "ladders"
  >("ads");
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [selectedOffer, setSelectedOffer] = useState<string | null>(null);
  const [funnelFilter, setFunnelFilter] = useState<FunnelStage | "all">("all");
  const [activeCompetitorJump, setActiveCompetitorJump] = useState<string | null>(
    null,
  );
  const [activeLadderJump, setActiveLadderJump] = useState<string | null>(null);

  useEffect(() => {
    if (!job.id || report?.status !== "completed") return;
    let cancelled = false;
    void fetch(`/api/search/status?jobId=${encodeURIComponent(job.id)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !Array.isArray(data.ads)) return;
        setAds(data.ads as SearchCompetitorAdRecord[]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [job.id, report?.updatedAt, report?.status]);

  const ladders = useMemo(
    () =>
      (report?.valueLadder?.ladders || []).slice().sort((a, b) => a.rank - b.rank),
    [report?.valueLadder?.ladders],
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

  return (
    <section className="panel">
      <div className="results-head">
        <h2>
          Offers dashboard
          <span className="muted-inline">
            {" "}
            · {groups.length} competitors · {ads.length} ads ·{" "}
            {creatives.length} creatives · {ladders.length} ladders
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

      {section === "ads" ? (
        groups.length === 0 ? (
          <p className="empty-hint">
            No cached ads for this run yet. Generate or re-analyze the offers
            dashboard.
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
            {groups.map((group) => (
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
                  {group.ads.map((ad) => (
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
              </section>
            ))}
          </div>
        )
      ) : null}

      {section === "creatives" ? (
        <div className="offers-pages-layout">
          <aside className="offers-page-list panel">
            <h2>Unique offers</h2>
            <p className="muted offers-block-lead">
              Filter creatives by offer / service signal
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
              {uniqueOffers.slice(0, 30).map((o) => (
                <li key={o.offer}>
                  <button
                    type="button"
                    className={`offers-page-row ${selectedOffer === o.offer ? "active" : ""}`}
                    onClick={() => setSelectedOffer(o.offer)}
                  >
                    <span className="offers-page-row-url">{o.offer}</span>
                    <span className="offers-meta-row">
                      <FunnelBadge stage={o.funnelStage} />
                      <span className="muted">
                        {o.adCount} ad{o.adCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
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
                    <p className="offers-card-offer">{c.offer}</p>
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
                      Core {ladder.rank}
                      {ladder.funnelStage ? ` · ${ladder.funnelStage}` : ""}
                    </span>
                  </button>
                ))}
              </nav>
              {ladders.map((ladder) => {
            const refs = adsForLadder(ladder, ads);
            const fallbackRefs = ladder.sourceAdRefs || [];
            return (
              <article
                key={ladder.id}
                id={ladderAnchorId(ladder.id)}
                className="offers-core-ladder"
              >
                <header className="offers-core-ladder-head">
                  <div className="offers-meta-row">
                    <span className="offers-card-kicker">Core {ladder.rank}</span>
                    <FunnelBadge stage={ladder.funnelStage} />
                    <span className="muted">
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


