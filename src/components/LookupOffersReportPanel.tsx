"use client";

import { useMemo, useState } from "react";
import type {
  LookupJob,
  LookupOffersReport,
  LookupUniqueLandingPage,
} from "@/lib/types";

type DashSection = "overview" | "creatives" | "pages";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function isLegalOrUtilityPage(url: string, headline?: string | null): boolean {
  const hay = `${url} ${headline || ""}`.toLowerCase();
  return /privacy|terms|cookie|disclaimer|legal|policy|login|signin|sign-in|cart|checkout/i.test(
    hay,
  );
}

/** Compact card on the lookup results page — opens the full dashboard. */
export function LookupOffersTeaser({
  report,
  running,
  onOpen,
  onGenerate,
  generating,
}: {
  report?: LookupOffersReport | null;
  running?: boolean;
  onOpen: () => void;
  onGenerate?: () => void;
  generating?: boolean;
}) {
  const pending =
    report?.status === "pending" || running || generating;
  const ready = report?.status === "completed";
  const failed = report?.status === "failed";

  return (
    <section className="panel offers-teaser">
      <div className="offers-teaser-main">
        <div>
          <h2>Offers intelligence</h2>
          <p className="muted">
            {pending
              ? "Analyzing unique ad creatives and landing-page offers…"
              : failed
                ? report?.error || "Offers analysis failed"
                : ready
                  ? `${report.adCopy.uniqueOffers.length} creative offers · ${report.landingPages.uniqueOffers.length} page offers · ${report.landingPages.analyzed} LPs analyzed`
                  : "Unique offers from ad copies and landing pages"}
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

  const brand = job.selectedPage?.name || job.queryName;
  const platform = job.platform || "facebook";

  const offerPages = useMemo(
    () =>
      report.landingPages.pages.filter(
        (p) =>
          p.status === "completed" &&
          p.primaryOffer &&
          !isLegalOrUtilityPage(p.url, p.headline),
      ),
    [report.landingPages.pages],
  );

  const otherPages = useMemo(
    () =>
      report.landingPages.pages.filter(
        (p) =>
          !(
            p.status === "completed" &&
            p.primaryOffer &&
            !isLegalOrUtilityPage(p.url, p.headline)
          ),
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

  const topCreatives = report.adCopy.creatives.slice(0, 12);

  return (
    <div className="offers-dash">
      <header className="offers-dash-topbar">
        <button type="button" className="ghost-btn offers-back-btn" onClick={onBack}>
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
            ["pages", `Landing pages (${report.landingPages.uniqueUrls})`],
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
                      <strong>{o.offer}</strong>
                      <span className="offers-count">
                        {o.adCount} ad{o.adCount === 1 ? "" : "s"}
                      </span>
                    </div>
                    {o.sampleHooks?.[0] ? (
                      <p className="muted offers-pill-sub">“{o.sampleHooks[0]}”</p>
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
        </div>
      ) : null}

      {section === "creatives" ? (
        <div className="offers-dash-body">
          <section className="offers-block">
            <h2>Unique creatives</h2>
            <p className="muted offers-block-lead">
              Similar ads are grouped. Showing {topCreatives.length} of{" "}
              {report.adCopy.uniqueCreatives}.
            </p>
            <div className="offers-card-grid">
              {topCreatives.map((c) => (
                <article key={c.id} className="offers-card">
                  <p className="offers-card-kicker">
                    {c.adCount} similar ad{c.adCount === 1 ? "" : "s"}
                  </p>
                  <h3>{c.hook}</h3>
                  <p className="offers-card-offer">{c.offer}</p>
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
                    <span className="offers-page-row-url">
                      {shortUrl(p.url).slice(0, 48)}
                    </span>
                    <span className="muted">{p.adCount} ads</span>
                  </button>
                </li>
              ))}
              {otherPages.length > 0 ? (
                <li className="offers-page-other-label muted">Other destinations</li>
              ) : null}
              {otherPages.map((p) => (
                <li key={p.matchKey}>
                  <button
                    type="button"
                    className={`offers-page-row is-muted ${selectedPage?.matchKey === p.matchKey ? "active" : ""}`}
                    onClick={() => setSelectedPageKey(p.matchKey)}
                  >
                    <span className="offers-page-row-url">
                      {shortUrl(p.url).slice(0, 48)}
                    </span>
                    <span className={`status-pill status-${p.status}`}>
                      {p.status}
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
              <>
                <div className="offers-page-detail-head">
                  <div>
                    <h2>Page offer</h2>
                    <a href={selectedPage.url} target="_blank" rel="noreferrer">
                      {shortUrl(selectedPage.url)}
                    </a>
                  </div>
                  <span className={`status-pill status-${selectedPage.status}`}>
                    {selectedPage.status}
                  </span>
                </div>
                <p className="muted">
                  {selectedPage.adCount} ad
                  {selectedPage.adCount === 1 ? "" : "s"} use this destination
                </p>

                {selectedPage.status === "completed" ? (
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
                    {selectedPage.uniqueValueProps &&
                    selectedPage.uniqueValueProps.length > 0 ? (
                      <div className="offers-detail-wide">
                        <dt>Value props</dt>
                        <dd>
                          <ul className="offers-prop-list">
                            {selectedPage.uniqueValueProps.map((v) => (
                              <li key={v}>{v}</li>
                            ))}
                          </ul>
                        </dd>
                      </div>
                    ) : null}
                    {selectedPage.summary ? (
                      <div className="offers-detail-wide">
                        <dt>Summary</dt>
                        <dd>{selectedPage.summary}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : (
                  <p className="muted">
                    {selectedPage.error || "No offer analysis for this page."}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
