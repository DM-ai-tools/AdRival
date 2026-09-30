"use client";

import { ReturnLink } from "./ReturnLink";
import { useEffect, useMemo, useState } from "react";
import type {
  LookupCoreOfferLadder,
  OfferTicketTier,
  SearchCompetitorAdRecord,
} from "@/lib/types";
import {
  adsForOffer,
  compareOffersLowToHigh,
  ladderSteps,
  tierName,
} from "./OfferLadderFlow";

const ADS_SHOWN = 6;
const OTHER = "Other advertisers";

type TierFilter = "all" | OfferTicketTier;

/** An ad shown under an offer. */
export type OfferWorkspaceAd = {
  id: string;
  title?: string | null;
  body?: string | null;
  ctaText?: string | null;
  adLibraryUrl?: string | null;
  offerMatch?: boolean;
};

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** One strip per competitor, offers cheapest first. An offer run by several
 *  competitors appears in each of their strips. */
function groupByCompetitor(offers: LookupCoreOfferLadder[]) {
  const map = new Map<string, LookupCoreOfferLadder[]>();
  for (const offer of offers) {
    const names = offer.sourceCompetitors?.length ? offer.sourceCompetitors : [OTHER];
    for (const name of names) {
      const list = map.get(name) ?? [];
      list.push(offer);
      map.set(name, list);
    }
  }
  return [...map.entries()]
    .map(([name, list]) => ({ name, offers: [...list].sort(compareOffersLowToHigh) }))
    .sort((a, b) => (a.name === OTHER ? 1 : b.name === OTHER ? -1 : b.offers.length - a.offers.length));
}

/**
 * The Offer ladders view: a strip of offers per competitor, low to high, and
 * one selected offer in detail. Every offer the report found is shown.
 */
export function OfferWorkspace({
  jobId,
  offers,
  ads,
  adsLoading,
  getAds,
  initialSelection,
  onSelect,
}: {
  /** Told whenever the shown offer changes (the dashboard keeps it in the address). */
  onSelect?: (selection: { id: string; competitor: string } | null) => void;
  /** Offer to show first, e.g. when arriving from Insights. */
  initialSelection?: { id: string; competitor: string } | null;
  /** Search run id; enables "Open full offer page". */
  jobId?: string | null;
  offers: LookupCoreOfferLadder[];
  ads?: SearchCompetitorAdRecord[];
  adsLoading?: boolean;
  /** Where the ads under an offer come from, when not from `ads`. */
  getAds?: (offer: LookupCoreOfferLadder) => OfferWorkspaceAd[];
}) {
  const [competitor, setCompetitor] = useState<string>("all");
  const [tier, setTier] = useState<TierFilter>("all");
  const [selected, setSelected] = useState<{ id: string; competitor: string } | null>(initialSelection ?? null);
  const [showAllAds, setShowAllAds] = useState(false);

  const allGroups = useMemo(() => groupByCompetitor(offers), [offers]);
  const groups = useMemo(
    () =>
      allGroups
        .filter((g) => competitor === "all" || g.name === competitor)
        .map((g) => ({
          ...g,
          offers: g.offers.filter((o) => tier === "all" || o.ticketTier === tier),
        }))
        .filter((g) => g.offers.length > 0),
    [allGroups, competitor, tier],
  );

  // Previous / next walk the strips in the order they are shown.
  const sequence = useMemo(
    () => groups.flatMap((g) => g.offers.map((o) => ({ id: o.id, competitor: g.name }))),
    [groups],
  );

  useEffect(() => {
    if (!sequence.length) {
      setSelected(null);
      return;
    }
    if (!selected || !sequence.some((s) => s.id === selected.id && s.competitor === selected.competitor)) {
      setSelected(sequence[0]);
    }
  }, [sequence, selected]);

  useEffect(() => setShowAllAds(false), [selected?.id, selected?.competitor]);

  useEffect(() => {
    onSelect?.(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report changes of the offer only
  }, [selected?.id, selected?.competitor]);

  // Arriving with an offer picked (from Insights): bring its tile into view.
  useEffect(() => {
    if (!initialSelection) return;
    const key = `${initialSelection.competitor}::${initialSelection.id}`;
    const el = document.querySelector(`[data-offer-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    // Only on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const index = selected
    ? sequence.findIndex((s) => s.id === selected.id && s.competitor === selected.competitor)
    : -1;
  const offer = selected ? offers.find((o) => o.id === selected.id) ?? null : null;
  const step = offer ? ladderSteps(offer)[0] : null;
  const competitorName = selected && selected.competitor !== OTHER ? selected.competitor : null;
  const offerAds = useMemo<OfferWorkspaceAd[]>(
    () =>
      offer ? (getAds ? getAds(offer) : adsForOffer(offer, ads || [], competitorName)) : [],
    [offer, ads, competitorName, getAds],
  );
  // Ads whose wording matches the offer come first; the rest (e.g. every ad
  // pointing at the same homepage) only on "Show all".
  const matching = offerAds.filter((ad) => ad.offerMatch);
  const primaryAds = matching.length ? matching : offerAds;
  const shownAds = showAllAds ? offerAds : primaryAds.slice(0, ADS_SHOWN);

  const tierCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const o of offers) counts[o.ticketTier] = (counts[o.ticketTier] || 0) + 1;
    return counts;
  }, [offers]);

  if (!offers.length) {
    return (
      <p className="empty-hint">
        No offers for the searched service in this report yet. Rebuild the report after the
        competitors have active ads with landing pages.
      </p>
    );
  }

  return (
    <div className="offer-ws">
      <div className="offer-ws-filters">
        <label className="offer-ws-filter">
          <span>Competitor</span>
          <select value={competitor} onChange={(e) => setCompetitor(e.target.value)}>
            <option value="all">All competitors ({allGroups.length})</option>
            {allGroups.map((g) => (
              <option key={g.name} value={g.name}>
                {g.name} ({g.offers.length})
              </option>
            ))}
          </select>
        </label>
        <div className="offer-ws-tiers" role="group" aria-label="Price level">
          {(["all", "low", "unknown", "mid", "high"] as TierFilter[])
            .filter((t) => t === "all" || tierCounts[t])
            .map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tier === t}
                className={tier === t ? "active" : ""}
                onClick={() => setTier(t)}
              >
                {t === "all" ? `All levels (${offers.length})` : `${tierName(t)} (${tierCounts[t]})`}
              </button>
            ))}
        </div>
      </div>

      <div className="offer-ws-body">
        <div className="offer-ws-strips">
          {groups.length === 0 ? (
            <p className="empty-hint">No offers match these filters.</p>
          ) : (
            groups.map((g) => (
              <section key={g.name} className="offer-ws-strip">
                <h3>
                  {g.name}
                  <span className="muted"> · {g.offers.length} offer{g.offers.length === 1 ? "" : "s"}, cheapest first</span>
                </h3>
                <ol>
                  {g.offers.map((o, i) => {
                    const active = selected?.id === o.id && selected.competitor === g.name;
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          className={`offer-ws-chip is-${o.ticketTier}${active ? " active" : ""}`}
                          aria-pressed={active}
                          data-offer-key={`${g.name}::${o.id}`}
                          onClick={() => setSelected({ id: o.id, competitor: g.name })}
                        >
                          <span className="offer-ws-chip-tier">{tierName(o.ticketTier)}</span>
                          <span className="offer-ws-chip-offer">{o.coreOffer}</span>
                          {o.pricing ? <span className="offer-ws-chip-price">{o.pricing}</span> : null}
                        </button>
                        {i < g.offers.length - 1 ? (
                          <span className="offer-ws-arrow" aria-hidden="true">
                            →
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))
          )}
        </div>

        {offer ? (
          <aside className="offer-ws-detail" aria-live="polite">
            <div className="offer-ws-detail-nav">
              <button
                type="button"
                className="ghost-btn"
                disabled={index <= 0}
                onClick={() => setSelected(sequence[index - 1])}
              >
                ← Previous
              </button>
              <span className="muted">
                {index + 1} of {sequence.length}
              </span>
              <button
                type="button"
                className="ghost-btn"
                disabled={index < 0 || index >= sequence.length - 1}
                onClick={() => setSelected(sequence[index + 1])}
              >
                Next →
              </button>
            </div>
            <span className={`offer-ws-chip-tier is-${offer.ticketTier}`}>{tierName(offer.ticketTier)}</span>
            <h3>{offer.coreOffer}</h3>
            <dl className="offer-ws-facts">
              {offer.pricing ? (
                <div>
                  <dt>Price</dt>
                  <dd>{offer.pricing}</dd>
                </div>
              ) : null}
              {offer.cta ? (
                <div>
                  <dt>Call to action</dt>
                  <dd>{offer.cta}</dd>
                </div>
              ) : null}
              {offer.sourceCompetitors?.length ? (
                <div>
                  <dt>Offered by</dt>
                  <dd>{offer.sourceCompetitors.join(", ")}</dd>
                </div>
              ) : null}
              {offer.landingPageUrl ? (
                <div>
                  <dt>Landing page</dt>
                  <dd>
                    <a href={offer.landingPageUrl} target="_blank" rel="noreferrer">
                      {shortUrl(offer.landingPageUrl)}
                    </a>
                  </dd>
                </div>
              ) : null}
            </dl>
            {step?.evidence ? (
              <blockquote className="offer-ws-evidence">
                “{step.evidence}”
                <cite>{step.evidenceSource === "ad" ? "From the ad" : "From the landing page"}</cite>
              </blockquote>
            ) : null}
            <h4>
              Ads behind this offer
              {competitorName ? <span className="muted"> · {competitorName}</span> : null}
            </h4>
            {adsLoading ? (
              <p className="muted">Loading ads…</p>
            ) : offerAds.length === 0 ? (
              <p className="muted">No individual ads are linked to this offer.</p>
            ) : (
              <ul className="offer-ws-ads">
                {shownAds.map((ad) => (
                  <li key={ad.id}>
                    {ad.title ? <strong>{ad.title}</strong> : null}
                    {ad.body ? <p>{ad.body}</p> : null}
                    <div className="offers-meta-row">
                      {ad.ctaText ? <span>CTA: {ad.ctaText}</span> : null}
                      {ad.adLibraryUrl ? (
                        <a href={ad.adLibraryUrl} target="_blank" rel="noreferrer">
                          Open ad
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {offerAds.length > shownAds.length || showAllAds ? (
              <button type="button" className="link-btn" onClick={() => setShowAllAds((v) => !v)}>
                {showAllAds ? "Show fewer ads" : `Show all ${offerAds.length} ads`}
              </button>
            ) : null}
            {jobId ? (
              <p>
                <ReturnLink
                  className="ghost-btn"
                  href={`/search-offers/${encodeURIComponent(jobId)}/${encodeURIComponent(offer.id)}`}
                >
                  Open full offer page
                </ReturnLink>
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
