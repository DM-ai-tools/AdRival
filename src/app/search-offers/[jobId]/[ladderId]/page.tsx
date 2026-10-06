"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  LookupCoreOfferLadder,
  SearchCompetitorAdRecord,
  SearchJob,
} from "@/lib/types";
import {
  OfferLadderFlow,
  adsForOffer,
  ladderSteps,
  splitLaddersByOffer,
  tierName,
  visibleOfferLadders,
} from "@/components/OfferLadderFlow";
import { searchedServiceFocus } from "@/lib/pipeline/offerServiceFocus";
import { readReturnPath, returnLabel, withReturn } from "@/lib/returnTo";
import { externalUrl } from "@/lib/externalUrl";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

export default function SearchOfferLadderPage() {
  const params = useParams<{ jobId: string; ladderId: string }>();
  const jobId = params.jobId;
  const ladderId = params.ladderId;
  const [job, setJob] = useState<SearchJob | null>(null);
  const [ads, setAds] = useState<SearchCompetitorAdRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [returnPath, setReturnPath] = useState<string | null>(null);
  useEffect(() => {
    setReturnPath(readReturnPath());
  }, []);
  const backHref = returnPath || `/?mode=search&run=${encodeURIComponent(jobId)}&tab=offers`;
  // Moving between offers keeps the way back.
  const offerHref = (id: string) =>
    withReturn(`/search-offers/${encodeURIComponent(jobId)}/${encodeURIComponent(id)}`, returnPath);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(
          `/api/search/status?jobId=${encodeURIComponent(jobId)}`,
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load offers ladder");
        if (cancelled) return;
        setJob(data.job as SearchJob);
        if (Array.isArray(data.ads)) {
          setAds(data.ads as SearchCompetitorAdRecord[]);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // The same list, ids and numbers as the dashboard's Offer ladders view.
  const offers = useMemo<LookupCoreOfferLadder[]>(() => {
    if (!job) return [];
    const focus = searchedServiceFocus(
      job.keywords?.length ? job.keywords : job.keyword ? [job.keyword] : [],
      job.selectedCategory?.label || null,
    );
    return visibleOfferLadders(job.offersReport?.valueLadder?.ladders || [], focus);
  }, [job]);

  const ladder = useMemo<LookupCoreOfferLadder | null>(() => {
    const found = offers.find((l) => l.id === ladderId);
    if (found) return found;
    // Links saved before the dashboard and this page shared one list.
    const legacy = splitLaddersByOffer(job?.offersReport?.valueLadder?.ladders || []);
    return legacy.find((l) => l.id === ladderId) || null;
  }, [offers, job?.offersReport?.valueLadder?.ladders, ladderId]);

  const position = ladder ? offers.findIndex((l) => l.id === ladder.id) : -1;
  const prev = position > 0 ? offers[position - 1] : null;
  const next = position >= 0 && position < offers.length - 1 ? offers[position + 1] : null;
  const firstStep = ladder ? ladderSteps(ladder)[0] : null;
  const evidence = firstStep?.evidence ?? null;

  const referencedAds = useMemo(
    () => (ladder ? adsForOffer(ladder, ads) : []),
    [ladder, ads],
  );

  return (
    <main className="page product-shell">
      <section className="panel">
        <nav className="crumbs" aria-label="You are here">
          <Link href={backHref}>{returnLabel(backHref)}</Link>
          <span aria-hidden="true">›</span>
          <Link href={backHref}>Offers dashboard</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">{ladder ? ladder.coreOffer.slice(0, 60) : "Offer"}</span>
        </nav>
        <div className="results-head">
          <h1>Offer details</h1>
          <Link className="ghost-btn" href={backHref}>
            ← Back to offers dashboard
          </Link>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        {!job ? <p className="empty-hint">Loading ladder…</p> : null}
        {job && !ladder ? (
          <p className="empty-hint">Ladder not found in this job report.</p>
        ) : null}
        {ladder ? (
          <article className="offers-core-ladder">
            {offers.length > 1 ? (
              <nav className="offer-ws-detail-nav" aria-label="Other offers">
                {prev ? (
                  <Link
                    className="ghost-btn"
                    href={offerHref(prev.id)}
                  >
                    ← {prev.coreOffer.slice(0, 40)}
                  </Link>
                ) : (
                  <span />
                )}
                <span className="muted">
                  Offer {position + 1} of {offers.length}
                </span>
                {next ? (
                  <Link
                    className="ghost-btn"
                    href={offerHref(next.id)}
                  >
                    {next.coreOffer.slice(0, 40)} →
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            ) : null}
            <header className="offers-core-ladder-head">
              <div className="offers-meta-row">
                <span className={`offer-ws-chip-tier is-${ladder.ticketTier}`}>
                  {tierName(ladder.ticketTier)}
                </span>
                <span className="muted">
                  {ladder.sourceCompetitors?.length || 0} competitor
                  {(ladder.sourceCompetitors?.length || 0) === 1 ? "" : "s"}
                </span>
              </div>
              <h2>{ladder.coreOffer}</h2>
              {ladder.details ? <p>{ladder.details}</p> : null}
              {ladder.cta ? <p>CTA: {ladder.cta}</p> : null}
              {ladder.pricing ? <p>Pricing: {ladder.pricing}</p> : null}
              {ladder.landingPageUrl ? (
                <a href={externalUrl(ladder.landingPageUrl)} target="_blank" rel="noreferrer">
                  {shortUrl(ladder.landingPageUrl)}
                </a>
              ) : null}
            </header>
            {evidence ? (
              <blockquote className="offer-ws-evidence">
                “{evidence}”
                <cite>{firstStep?.evidenceSource === "ad" ? "From the ad" : "From the landing page"}</cite>
              </blockquote>
            ) : null}
            <OfferLadderFlow ladder={ladder} />
            {ladder.sourceCompetitors?.length ? (
              <div className="offers-tree-node">
                <h3>Competitor sources</h3>
                <p className="muted">{ladder.sourceCompetitors.join(", ")}</p>
              </div>
            ) : null}
            {ladder.adOffers?.length ? (
              <div className="offers-tree-node">
                <h3>Mapped ad offers</h3>
                <div className="offers-ad-copy-list">
                  {ladder.adOffers.map((ad) => (
                    <article
                      key={`${ladder.id}-${ad.creativeId}`}
                      className="offers-ad-copy"
                    >
                      <h4>{ad.hook || ad.offer}</h4>
                      {ad.sampleCopy ? (
                        <p className="offers-ad-body">{ad.sampleCopy}</p>
                      ) : (
                        <p className="offers-card-offer">{ad.offer}</p>
                      )}
                      <div className="offers-meta-row">
                        {ad.cta ? <span>CTA: {ad.cta}</span> : null}
                        {ad.landingPageUrl ? (
                          <a href={externalUrl(ad.landingPageUrl)} target="_blank" rel="noreferrer">
                            {shortUrl(ad.landingPageUrl)}
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ) : (
              <p className="empty-hint">{ladder.emptyMessage || "No mapped ad offers."}</p>
            )}
            <div className="offers-tree-node">
              <h3>Ad references</h3>
              {referencedAds.length ? (
                <div className="offers-ad-copy-list">
                  {referencedAds.map((ad) => (
                    <article key={ad.id} className="offers-ad-copy">
                      <span className="offers-card-kicker">{ad.pageName}</span>
                      {ad.title ? <h4>{ad.title}</h4> : null}
                      {ad.body ? <p className="offers-ad-body">{ad.body}</p> : null}
                      <div className="offers-meta-row">
                        {ad.ctaText ? <span>CTA: {ad.ctaText}</span> : null}
                        {ad.landingPageUrl ? (
                          <a href={externalUrl(ad.landingPageUrl)} target="_blank" rel="noreferrer">
                            {shortUrl(ad.landingPageUrl)}
                          </a>
                        ) : null}
                        {ad.adLibraryUrl ? (
                          <a href={ad.adLibraryUrl} target="_blank" rel="noreferrer">
                            Open ad
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (ladder.sourceAdRefs || []).length ? (
                <div className="offers-ad-copy-list">
                  {(ladder.sourceAdRefs || []).map((r) => (
                    <article
                      key={`${r.competitorId}:${r.adId}`}
                      className="offers-ad-copy"
                    >
                      <span className="offers-card-kicker">{r.competitorName}</span>
                      {r.title ? <h4>{r.title}</h4> : null}
                      {r.body ? <p className="offers-ad-body">{r.body}</p> : null}
                      <div className="offers-meta-row">
                        {r.ctaText ? <span>CTA: {r.ctaText}</span> : null}
                        {r.landingPageUrl ? (
                          <a href={externalUrl(r.landingPageUrl)} target="_blank" rel="noreferrer">
                            {shortUrl(r.landingPageUrl)}
                          </a>
                        ) : null}
                        {r.adLibraryUrl ? (
                          <a href={r.adLibraryUrl} target="_blank" rel="noreferrer">
                            Open ad
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="empty-hint">No ad references on this ladder.</p>
              )}
            </div>
          </article>
        ) : null}
      </section>
    </main>
  );
}
