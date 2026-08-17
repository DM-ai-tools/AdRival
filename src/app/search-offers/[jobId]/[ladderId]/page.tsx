"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type {
  LookupCoreOfferLadder,
  SearchCompetitorAdRecord,
  SearchJob,
} from "@/lib/types";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function lpKey(url?: string | null): string {
  return (url || "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "")
    .toLowerCase();
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

export default function SearchOfferLadderPage() {
  const params = useParams<{ jobId: string; ladderId: string }>();
  const jobId = params.jobId;
  const ladderId = params.ladderId;
  const [job, setJob] = useState<SearchJob | null>(null);
  const [ads, setAds] = useState<SearchCompetitorAdRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const ladder = useMemo<LookupCoreOfferLadder | null>(() => {
    const ladders = job?.offersReport?.valueLadder?.ladders || [];
    return ladders.find((l) => l.id === ladderId) || null;
  }, [job?.offersReport?.valueLadder?.ladders, ladderId]);

  const referencedAds = useMemo(
    () => (ladder ? adsForLadder(ladder, ads) : []),
    [ladder, ads],
  );

  return (
    <main className="page product-shell">
      <section className="panel">
        <div className="results-head">
          <h1>Offer ladder details</h1>
          <Link className="ghost-btn" href="/">
            ← Back to search
          </Link>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        {!job ? <p className="empty-hint">Loading ladder…</p> : null}
        {job && !ladder ? (
          <p className="empty-hint">Ladder not found in this job report.</p>
        ) : null}
        {ladder ? (
          <article className="offers-core-ladder">
            <header className="offers-core-ladder-head">
              <div className="offers-meta-row">
                <span className="offers-card-kicker">Core {ladder.rank}</span>
                <span className="muted">
                  {ladder.sourceCompetitors?.length || 0} competitor sources
                </span>
              </div>
              <h2>{ladder.coreOffer}</h2>
              {ladder.details ? <p>{ladder.details}</p> : null}
              {ladder.cta ? <p>CTA: {ladder.cta}</p> : null}
              {ladder.pricing ? <p>Pricing: {ladder.pricing}</p> : null}
              {ladder.landingPageUrl ? (
                <a href={ladder.landingPageUrl} target="_blank" rel="noreferrer">
                  {shortUrl(ladder.landingPageUrl)}
                </a>
              ) : null}
            </header>
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
                          <a href={ad.landingPageUrl} target="_blank" rel="noreferrer">
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
                          <a href={ad.landingPageUrl} target="_blank" rel="noreferrer">
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
                          <a href={r.landingPageUrl} target="_blank" rel="noreferrer">
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
