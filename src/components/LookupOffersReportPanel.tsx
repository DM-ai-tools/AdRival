"use client";

import { useMemo, useState } from "react";
import type {
  FunnelStage,
  LookupJob,
  LookupOfferAdLeaf,
  LookupOffersReport,
  LookupServiceOfferingNode,
  LookupUniqueLandingPage,
  OfferTicketTier,
} from "@/lib/types";
import { splitLaddersByOffer } from "./OfferLadderFlow";

type DashSection =
  | "overview"
  | "creatives"
  | "pages"
  | "services"
  | "ladder";

const CREATIVE_DISPLAY_CAP = 24;

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function isLegalOrUtilityPage(url: string, headline?: string | null): boolean {
  const hay = `${url} ${headline || ""}`.toLowerCase();
  return /privacy|terms|cookie|disclaimer|legal|policy|login|signin|sign-in|cart|checkout/i.test(
    hay,
  );
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

function TicketBadge({ tier }: { tier?: OfferTicketTier | null }) {
  const value = tier || "unknown";
  return <span className="offers-ticket-badge">{value}</span>;
}

function AdLeafCard({ ad }: { ad: LookupOfferAdLeaf }) {
  return (
    <article className="offers-card offers-tree-node">
      <div className="offers-meta-row">
        <FunnelBadge stage={ad.funnelStage} />
        <span className="offers-count">
          {ad.adCount} ad{ad.adCount === 1 ? "" : "s"}
        </span>
      </div>
      {ad.hook ? <h4>{ad.hook}</h4> : null}
      {ad.offer ? <p className="offers-card-offer">{ad.offer}</p> : null}
      {ad.sampleCopy ? (
        <p className="offers-ad-body">{ad.sampleCopy}</p>
      ) : null}
      <div className="offers-meta-row">
        {ad.cta ? <span>CTA: {ad.cta}</span> : null}
        {ad.serviceTargeted ? <span>Service: {ad.serviceTargeted}</span> : null}
      </div>
      {ad.landingPageUrl ? (
        <a
          className="offers-card-link"
          href={ad.landingPageUrl}
          target="_blank"
          rel="noreferrer"
        >
          {shortUrl(ad.landingPageUrl).slice(0, 56)}
        </a>
      ) : null}
    </article>
  );
}

function EmptyRefreshHint({ label }: { label: string }) {
  return (
    <p className="empty-hint">
      {label} Refresh the offers report to populate this section.
    </p>
  );
}

/** Compact card on the lookup results page — opens the full dashboard. */
export function LookupOffersTeaser({
  report,
  running,
  onOpen,
  onGenerate,
  generating,
  progress,
}: {
  report?: LookupOffersReport | null;
  running?: boolean;
  onOpen: () => void;
  onGenerate?: () => void;
  generating?: boolean;
  progress?: {
    message?: string;
    offersPhase?: string | null;
    offersDone?: number;
    offersTotal?: number;
    offersCurrentName?: string | null;
    offersPct?: number;
  } | null;
}) {
  const pending = report?.status === "pending" || running || generating;
  const ready = report?.status === "completed";
  const failed = report?.status === "failed";

  const pct = Math.min(
    100,
    Math.max(
      pending ? 4 : 0,
      progress?.offersPct ??
        (progress?.offersTotal
          ? Math.round(
              ((progress.offersDone || 0) / Math.max(progress.offersTotal, 1)) *
                100,
            )
          : pending
            ? 8
            : 0),
    ),
  );

  const phaseLabel =
    progress?.offersPhase === "creatives"
      ? "Creatives"
      : progress?.offersPhase === "landing_pages"
        ? "Landing pages"
        : progress?.offersPhase === "ladder"
          ? "Value ladder"
          : progress?.offersPhase === "starting"
            ? "Starting"
            : pending
              ? "Analyzing"
              : null;

  return (
    <section className={`panel offers-teaser ${pending ? "is-analyzing" : ""}`}>
      <div className="offers-teaser-main">
        <div>
          <h2>Offers intelligence</h2>
          <p className="muted">
            {pending
              ? progress?.message ||
                "Analyzing unique ad creatives and landing-page offers…"
              : failed
                ? report?.error || "Offers analysis failed"
                : ready
                  ? `${report.adCopy.uniqueOffers.length} creative offers · ${report.landingPages.uniqueOffers.length} page offers · ${report.landingPages.analyzed} LPs analyzed`
                  : "Optional — generate a summary after analyzing ads. Per-ad analysis still runs via Get offer & page details."}
          </p>
        </div>
        <div className="offers-teaser-actions">
          {ready ? (
            <button type="button" className="search-btn" onClick={onOpen}>
              Open offers dashboard
            </button>
          ) : null}
          {!ready && onGenerate ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={Boolean(pending)}
              onClick={onGenerate}
            >
              {generating || pending ? "Working…" : "Generate report"}
            </button>
          ) : null}
          {ready && onGenerate ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={Boolean(pending)}
              onClick={onGenerate}
            >
              Refresh
            </button>
          ) : null}
        </div>
      </div>

      {pending ? (
        <div className="offers-analysis-progress" aria-live="polite">
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              {phaseLabel || "Offers analysis"}
              {progress?.offersCurrentName
                ? ` · ${progress.offersCurrentName}`
                : ""}
            </span>
            <span className="offers-analysis-progress-count">
              {progress?.offersTotal
                ? `${progress.offersDone ?? 0}/${progress.offersTotal}`
                : `${pct}%`}
            </span>
          </div>
          <div className="progress-bar-track offers-analysis-bar">
            <div
              className="progress-bar-fill progress-bar-offers"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : null}

      {ready ? (
        <div className="offers-teaser-stats">
          <div>
            <strong>{report.adsAnalyzed}</strong>
            <span>Ads</span>
          </div>
          <div>
            <strong>{report.adCopy.uniqueCreatives}</strong>
            <span>Creatives</span>
          </div>
          <div>
            <strong>{report.adCopy.uniqueOffers.length}</strong>
            <span>Ad offers</span>
          </div>
          <div>
            <strong>{report.landingPages.uniqueUrls}</strong>
            <span>Landing pages</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Full-screen (in-app) offers dashboard — not a browser tab. */
export function LookupOffersDashboard({
  job,
  report,
  regenerating,
  onBack,
  onRegenerate,
}: {
  job: LookupJob;
  report: LookupOffersReport;
  regenerating?: boolean;
  onBack: () => void;
  onRegenerate?: () => void;
}) {
  const [section, setSection] = useState<DashSection>("overview");
  const [selectedPageKey, setSelectedPageKey] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<string | null>(null);

  const brand = job.selectedPage?.name || job.queryName;
  const platform = job.platform || "facebook";

  const offerPages = useMemo(
    () =>
      report.landingPages.pages
        .filter(
          (p) =>
            p.status === "completed" &&
            p.primaryOffer &&
            !isLegalOrUtilityPage(p.url, p.headline),
        )
        .slice()
        .sort(
          (a, b) =>
            (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
            b.adCount - a.adCount,
        ),
    [report.landingPages.pages],
  );

  const otherPages = useMemo(
    () =>
      report.landingPages.pages
        .filter(
          (p) =>
            !(
              p.status === "completed" &&
              p.primaryOffer &&
              !isLegalOrUtilityPage(p.url, p.headline)
            ),
        )
        .slice()
        .sort(
          (a, b) =>
            (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
            b.adCount - a.adCount,
        ),
    [report.landingPages.pages],
  );

  const selectedPage: LookupUniqueLandingPage | null = useMemo(() => {
    const key = selectedPageKey;
    if (!key) return offerPages[0] || report.landingPages.pages[0] || null;
    return (
      report.landingPages.pages.find((p) => p.matchKey === key) ||
      offerPages[0] ||
      null
    );
  }, [selectedPageKey, offerPages, report.landingPages.pages]);

  const serviceNodes: LookupServiceOfferingNode[] =
    report.services?.nodes || [];

  const selectedServiceNode = useMemo(() => {
    if (!serviceNodes.length) return null;
    if (!selectedService) return serviceNodes[0];
    return (
      serviceNodes.find((n) => n.service === selectedService) ||
      serviceNodes[0]
    );
  }, [selectedService, serviceNodes]);

  const allCreatives = report.adCopy.creatives;
  const shownCreatives =
    allCreatives.length <= CREATIVE_DISPLAY_CAP
      ? allCreatives
      : allCreatives.slice(0, CREATIVE_DISPLAY_CAP);

  const funnelDistribution = useMemo(() => {
    const counts: Partial<Record<FunnelStage, number>> = {};
    for (const c of allCreatives) {
      const stage: FunnelStage = c.funnelStage || "unknown";
      counts[stage] = (counts[stage] || 0) + c.adCount;
    }
    return (["TOFU", "MOFU", "BOFU", "unknown"] as FunnelStage[])
      .map((stage) => ({ stage, count: counts[stage] || 0 }))
      .filter((row) => row.count > 0);
  }, [allCreatives]);

  const coreLadders = useMemo(() => {
    const ladders = report.valueLadder?.ladders || [];
    if (ladders.length > 0) {
      return splitLaddersByOffer([...ladders].sort((a, b) => a.rank - b.rank));
    }
    // Legacy flat steps → synthetic single-rung ladders
    const steps = report.valueLadder?.steps || [];
    return [...steps]
      .sort((a, b) => a.rank - b.rank)
      .map((step) => ({
        id: step.id,
        rank: step.rank,
        coreOffer: step.offer,
        details: step.details,
        cta: step.cta,
        ticketTier: step.ticketTier,
        pricing: step.pricing,
        funnelStage: step.funnelStage,
        landingPageUrl: null as string | null,
        adCount: step.adCount,
        adOffers: [] as LookupOfferAdLeaf[],
        emptyMessage: "No value ladder found for this core offer",
      }));
  }, [report.valueLadder?.ladders, report.valueLadder?.steps]);

  return (
    <div className="offers-dash">
      <header className="offers-dash-topbar">
        <button
          type="button"
          className="ghost-btn offers-back-btn"
          onClick={onBack}
        >
          ← Back to lookup
        </button>
        <div className="offers-dash-title">
          <h1>Offers dashboard</h1>
          <p className="muted">
            {brand} · {platform}
            {report.summary ? ` · ${report.adsAnalyzed} ads analyzed` : ""}
          </p>
        </div>
        <div className="offers-dash-actions">
          <span className={`status-pill status-${report.status}`}>
            {report.status}
          </span>
          {onRegenerate ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={regenerating}
              onClick={onRegenerate}
            >
              {regenerating ? "Refreshing…" : "Refresh"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="offers-dash-metrics">
        <div className="offers-metric">
          <strong>{report.adsAnalyzed}</strong>
          <span>Ads scanned</span>
        </div>
        <div className="offers-metric">
          <strong>{report.adCopy.uniqueCreatives}</strong>
          <span>Unique creatives</span>
        </div>
        <div className="offers-metric">
          <strong>{report.adCopy.uniqueOffers.length}</strong>
          <span>Creative offers</span>
        </div>
        <div className="offers-metric">
          <strong>{offerPages.length}</strong>
          <span>Offer pages</span>
        </div>
      </div>

      <nav className="offers-dash-tabs" role="tablist" aria-label="Offers sections">
        {(
          [
            ["overview", "Overview"],
            ["creatives", `Creatives (${report.adCopy.uniqueCreatives})`],
            ["pages", `By landing page (${report.landingPages.uniqueUrls})`],
            [
              "services",
              `Services (${report.services?.uniqueServices ?? serviceNodes.length})`,
            ],
            ["ladder", `Value ladders (${coreLadders.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={`offers-tab ${section === id ? "active" : ""}`}
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>

      {section === "overview" ? (
        <div className="offers-dash-body offers-overview">
          <section className="offers-block">
            <h2>Top offers from ad creatives</h2>
            <p className="muted offers-block-lead">
              Deduped promises appearing across the ad set
            </p>
            {report.adCopy.uniqueOffers.length === 0 ? (
              <p className="empty-hint">No creative offers extracted.</p>
            ) : (
              <ul className="offers-pill-list">
                {report.adCopy.uniqueOffers.slice(0, 10).map((o) => (
                  <li key={`ov-ac-${o.offer}`}>
                    <div className="offers-pill-main">
                      <strong>
                        {o.pricing &&
                        /^(?:\$|₹|£|€)/.test(o.offer) &&
                        /[·•]/.test(o.offer)
                          ? o.sampleHooks?.[0] || o.offer
                          : o.offer}
                      </strong>
                      {o.pricing ? (
                        <span className="muted">{o.pricing}</span>
                      ) : null}
                      <span className="offers-count">
                        {o.adCount} ad{o.adCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    {o.sampleHooks?.[0] ? (
                      <p className="muted offers-pill-sub">
                        “{o.sampleHooks[0]}”
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="offers-block">
            <h2>Top offers from landing pages</h2>
            <p className="muted offers-block-lead">
              From analyzed destinations (legal / utility pages hidden)
            </p>
            {report.landingPages.uniqueOffers.filter(
              (o) =>
                !o.urls?.some((u) => isLegalOrUtilityPage(u)) &&
                !isLegalOrUtilityPage("", o.offer),
            ).length === 0 && offerPages.length === 0 ? (
              <p className="empty-hint">No landing-page offers extracted.</p>
            ) : (
              <ul className="offers-pill-list">
                {(offerPages.length
                  ? offerPages.map((p) => ({
                      offer: p.primaryOffer || "",
                      adCount: p.adCount,
                      urls: [p.url],
                      sampleHooks: p.headline ? [p.headline] : [],
                    }))
                  : report.landingPages.uniqueOffers
                )
                  .filter((o) => o.offer)
                  .slice(0, 8)
                  .map((o) => (
                    <li key={`ov-lp-${o.offer}`}>
                      <div className="offers-pill-main">
                        <strong>{o.offer}</strong>
                        <span className="offers-count">
                          {o.adCount} ad{o.adCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      {o.urls?.[0] ? (
                        <p className="muted offers-pill-sub">
                          <a href={o.urls[0]} target="_blank" rel="noreferrer">
                            {shortUrl(o.urls[0]).slice(0, 64)}
                          </a>
                        </p>
                      ) : null}
                    </li>
                  ))}
              </ul>
            )}
          </section>

          {funnelDistribution.length > 0 ? (
            <section className="offers-block">
              <h2>Funnel distribution</h2>
              <p className="muted offers-block-lead">
                Ad volume by creative funnel stage
              </p>
              <ul className="offers-pill-list">
                {funnelDistribution.map((row) => (
                  <li key={row.stage}>
                    <div className="offers-pill-main">
                      <FunnelBadge stage={row.stage} />
                      <span className="offers-count">
                        {row.count} ad{row.count === 1 ? "" : "s"}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="offers-block">
            <h2>Offer value ladder</h2>
            <p className="muted offers-block-lead">
              {coreLadders.length > 0
                ? `${coreLadders.length} core landing-page offer${coreLadders.length === 1 ? "" : "s"} with mapped ad-copy ladders.`
                : "No value ladder found — analyze landing pages, then Refresh."}
            </p>
            {coreLadders.length > 0 ? (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => setSection("ladder")}
              >
                View value ladders →
              </button>
            ) : null}
          </section>
        </div>
      ) : null}

      {section === "creatives" ? (
        <div className="offers-dash-body">
          <section className="offers-block">
            <h2>Unique creatives</h2>
            <p className="muted offers-block-lead">
              Similar ads are grouped. Showing {shownCreatives.length} of{" "}
              {report.adCopy.uniqueCreatives}
              {allCreatives.length > CREATIVE_DISPLAY_CAP
                ? ` (first ${CREATIVE_DISPLAY_CAP})`
                : ""}
              .
            </p>
            {shownCreatives.length === 0 ? (
              <EmptyRefreshHint label="No unique creatives in this report." />
            ) : (
              <div className="offers-card-grid">
                {shownCreatives.map((c) => (
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
            {allCreatives.length > CREATIVE_DISPLAY_CAP ? (
              <p className="muted offers-block-lead">
                Showing first {CREATIVE_DISPLAY_CAP} of {allCreatives.length}{" "}
                creatives.
              </p>
            ) : null}
          </section>
        </div>
      ) : null}

      {section === "pages" ? (
        <div className="offers-dash-body offers-pages-layout">
          <aside className="offers-page-list panel">
            <h2>Destinations</h2>
            <p className="muted offers-block-lead">
              {offerPages.length} offer page
              {offerPages.length === 1 ? "" : "s"}
              {otherPages.length
                ? ` · ${otherPages.length} other / skipped`
                : ""}
            </p>
            <ul>
              {offerPages.map((p) => (
                <li key={p.matchKey}>
                  <button
                    type="button"
                    className={`offers-page-row ${selectedPage?.matchKey === p.matchKey ? "active" : ""}`}
                    onClick={() => setSelectedPageKey(p.matchKey)}
                  >
                    <span className="offers-page-row-url" title={p.url}>
                      {shortUrl(p.url)}
                    </span>
                    <span className="offers-page-row-meta">
                      <FunnelBadge stage={p.funnelStage} />
                      <span className="muted">
                        {p.adCount} ad{p.adCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {otherPages.length > 0 ? (
                <li className="offers-page-other-label muted">
                  Other destinations
                </li>
              ) : null}
              {otherPages.map((p) => (
                <li key={p.matchKey}>
                  <button
                    type="button"
                    className={`offers-page-row is-muted ${selectedPage?.matchKey === p.matchKey ? "active" : ""}`}
                    onClick={() => setSelectedPageKey(p.matchKey)}
                  >
                    <span className="offers-page-row-url" title={p.url}>
                      {shortUrl(p.url)}
                    </span>
                    <span className="offers-page-row-meta">
                      <FunnelBadge stage={p.funnelStage} />
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
                  <span
                    className={`status-pill status-${selectedPage.status}`}
                  >
                    {selectedPage.status}
                  </span>
                </div>
                <p className="muted">
                  {selectedPage.adCount} ad
                  {selectedPage.adCount === 1 ? "" : "s"} use this destination
                </p>

                {selectedPage.status === "completed" ? (
                  <>
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

                    <div className="offers-tree-branch">
                      <h3>Ads on this page</h3>
                      {!selectedPage.ads || selectedPage.ads.length === 0 ? (
                        <EmptyRefreshHint label="No per-page ads attached yet." />
                      ) : (
                        <div className="offers-card-grid">
                          {selectedPage.ads.map((ad) => (
                            <AdLeafCard
                              key={`${selectedPage.matchKey}-${ad.creativeId}`}
                              ad={ad}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="muted">
                    {selectedPage.error ||
                      "No offer analysis for this page."}
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {section === "services" ? (
        <div className="offers-dash-body offers-pages-layout">
          <aside className="offers-page-list panel">
            <h2>Services</h2>
            <p className="muted offers-block-lead">
              {serviceNodes.length} service
              {serviceNodes.length === 1 ? "" : "s"} detected
            </p>
            {serviceNodes.length === 0 ? (
              <EmptyRefreshHint label="No service tree in this report." />
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
              <EmptyRefreshHint label="Select a service, or refresh if none are listed." />
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
                    <EmptyRefreshHint label="No landing pages under this service." />
                  ) : (
                    selectedServiceNode.landingPages.map((lp) => (
                      <div
                        key={lp.matchKey}
                        className="offers-tree-node"
                      >
                        <div className="offers-meta-row">
                          <a
                            href={lp.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortUrl(lp.url).slice(0, 64)}
                          </a>
                          <FunnelBadge stage={lp.funnelStage} />
                          <span className="muted">
                            {lp.adCount} ad{lp.adCount === 1 ? "" : "s"}
                          </span>
                        </div>
                        {lp.primaryOffer ? (
                          <p className="offers-page-offer-inline">
                            {lp.primaryOffer}
                          </p>
                        ) : null}
                        {lp.cta ? (
                          <p className="muted">CTA: {lp.cta}</p>
                        ) : null}

                        <div className="offers-tree-branch">
                          {!lp.ads || lp.ads.length === 0 ? (
                            <p className="muted">No ads attached.</p>
                          ) : (
                            <div className="offers-card-grid">
                              {lp.ads.map((ad) => (
                                <AdLeafCard
                                  key={`${lp.matchKey}-${ad.creativeId}`}
                                  ad={ad}
                                />
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

      {section === "ladder" ? (
        <div className="offers-dash-body">
          <section className="offers-block">
            <h2>Offer value ladders</h2>
            <p className="muted offers-block-lead">
              One ladder per unique landing-page (core) offer. Ad-copy offers are
              mapped under each core.
              {report.valueLadder?.summary
                ? ` · ${report.valueLadder.summary}`
                : ""}
            </p>
            {coreLadders.length === 0 ? (
              <EmptyRefreshHint label="No value ladder found." />
            ) : (
              <div className="offers-core-ladders">
                {coreLadders.map((ladder) => (
                  <article key={ladder.id} className="offers-core-ladder">
                    <header className="offers-core-ladder-head">
                      <div className="offers-meta-row">
                        <span className="offers-card-kicker">
                          Core {ladder.rank}
                        </span>
                        <TicketBadge tier={ladder.ticketTier} />
                        <FunnelBadge stage={ladder.funnelStage} />
                        <span className="muted">
                          {ladder.adCount} ad
                          {ladder.adCount === 1 ? "" : "s"} on LP
                        </span>
                      </div>
                      <h3>{ladder.coreOffer}</h3>
                      {ladder.details ? <p>{ladder.details}</p> : null}
                      <div className="offers-meta-row">
                        {ladder.cta ? <span>CTA: {ladder.cta}</span> : null}
                        {ladder.pricing ? (
                          <span>Pricing: {ladder.pricing}</span>
                        ) : null}
                        {ladder.landingPageUrl ? (
                          <a
                            href={ladder.landingPageUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {shortUrl(ladder.landingPageUrl).slice(0, 48)}
                          </a>
                        ) : null}
                      </div>
                    </header>

                    {ladder.emptyMessage || ladder.adOffers.length === 0 ? (
                      <p className="offers-core-ladder-empty">
                        {ladder.emptyMessage ||
                          "No value ladder found for this core offer"}
                      </p>
                    ) : (
                      <div className="offers-ladder offers-core-ladder-ads">
                        <p className="muted offers-block-lead">
                          Mapped ad-copy offers
                        </p>
                        {ladder.adOffers.map((ad) => (
                          <div key={`${ladder.id}-${ad.creativeId}`}>
                            <div
                              className="offers-ladder-connector"
                              aria-hidden
                            />
                            <AdLeafCard ad={ad} />
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
