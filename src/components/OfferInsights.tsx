"use client";

import { useMemo, useState } from "react";
import type { LookupCoreOfferLadder, SearchCompetitorAdRecord } from "@/lib/types";
import { adDays, competitorLadder, marketSnapshot, rankOffers, type OfferInsight } from "@/lib/offerInsights";
import { tierName } from "./OfferLadderFlow";
import { externalUrl } from "@/lib/externalUrl";

const TOP = 5;

function host(url: string | null | undefined): string {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

function funnelWords(stage?: string | null): string | null {
  if (stage === "TOFU") return "Awareness";
  if (stage === "MOFU") return "Consideration";
  if (stage === "BOFU") return "Ready to buy";
  return null;
}

function days(n: number | null): string {
  if (n === null) return "—";
  return `${n} day${n === 1 ? "" : "s"}`;
}

function clip(text: string | null | undefined, max: number): string {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Why an offer ranks where it does, in plain words. */
function reasons(row: OfferInsight): string[] {
  const out: string[] = [];
  out.push(`${row.adCount} ad${row.adCount === 1 ? "" : "s"} pushing it`);
  if (row.longestDays !== null) out.push(`running up to ${days(row.longestDays)}`);
  if (row.competitors.length > 1) out.push(`${row.competitors.length} competitors run it`);
  if (row.activeAds) out.push(`${row.activeAds} still live`);
  return out;
}

/**
 * Insights: the offers that are winning in this market and the ladders they
 * sit on, so a strategist can see what to copy or beat at a glance.
 */
export function OfferInsights({
  ladders,
  ads,
  adsLoading,
  summary,
  onOpenOffer,
}: {
  ladders: LookupCoreOfferLadder[];
  ads: SearchCompetitorAdRecord[];
  adsLoading?: boolean;
  summary?: string | null;
  onOpenOffer: (offerId: string, competitor: string) => void;
}) {
  const ranked = useMemo(() => rankOffers(ladders, ads), [ladders, ads]);
  const snapshot = useMemo(() => marketSnapshot(ladders, ads), [ladders, ads]);
  const [showAll, setShowAll] = useState(false);

  if (adsLoading && !ads.length) return <p className="empty-hint">Working out which offers perform best…</p>;
  if (!ranked.length) {
    return <p className="empty-hint">No offers were found for this search yet, so there is nothing to rank.</p>;
  }
  const top = ranked.slice(0, TOP);

  return (
    <div className="insights">
      <section className="insights-snapshot" aria-label="Market snapshot">
        <div className="insights-stat">
          <strong>{snapshot.competitors}</strong>
          <span>competitors analysed</span>
        </div>
        <div className="insights-stat">
          <strong>{snapshot.ads}</strong>
          <span>ads read</span>
        </div>
        <div className="insights-stat">
          <strong>{snapshot.offers}</strong>
          <span>distinct offers · {snapshot.tiers.low} entry, {snapshot.tiers.mid} core, {snapshot.tiers.high} premium</span>
        </div>
        <div className="insights-stat">
          <strong>{snapshot.topCta ? `“${clip(snapshot.topCta.label, 22)}”` : "—"}</strong>
          <span>most used call to action{snapshot.topCta ? ` (${snapshot.topCta.count} ads)` : ""}</span>
        </div>
      </section>
      {/* Only a written takeaway; a line of counts repeats the tiles above. */}
      {summary && !/^\s*\d+\s+(cached\s+)?ads\b/i.test(summary) ? <p className="insights-summary">{summary}</p> : null}

      <div className="insights-head">
        <h3>Top offers by virality</h3>
        <p className="muted">
          Ranked by how many ads push the offer, how long those ads have been kept running (advertisers keep paying
          for what converts) and how many competitors run it.
        </p>
      </div>

      <ol className="insights-list">
        {top.map((row, i) => {
          const ladder = competitorLadder(ladders, row.competitor);
          const funnel = funnelWords(row.ladder.funnelStage);
          const evidence = row.ladder.steps?.[0]?.evidence;
          return (
            <li key={row.ladder.id} className="insights-card">
              <div className="insights-card-rank" aria-label={`Rank ${i + 1}`}>
                {i + 1}
              </div>
              <div className="insights-card-main">
                <div className="insights-card-top">
                  <div>
                    <span className={`offer-ws-chip-tier is-${row.ladder.ticketTier}`}>{tierName(row.ladder.ticketTier)}</span>
                    <h4>{row.ladder.coreOffer}</h4>
                    {row.ladder.pricing ? <p className="insights-price">{row.ladder.pricing}</p> : null}
                  </div>
                  <div className="insights-score" title="Virality score out of 100">
                    <span className="insights-score-num">{row.score}</span>
                    <span className="insights-score-bar" aria-hidden="true">
                      <i style={{ width: `${row.score}%` }} />
                    </span>
                    <span className="muted">virality</span>
                  </div>
                </div>

                <ul className="insights-reasons">
                  {reasons(row).map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>

                <dl className="insights-facts">
                  <div>
                    <dt>Run by</dt>
                    <dd>
                      {row.competitor || "Several competitors"}
                      {row.competitors.length > 1 ? (
                        <span className="muted"> + {row.competitors.length - 1} more</span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Business website</dt>
                    <dd>
                      {row.website ? (
                        <a href={externalUrl(row.website)} target="_blank" rel="noopener noreferrer">
                          {host(row.website)}
                        </a>
                      ) : (
                        <span className="muted">Not found in their ads</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Landing page</dt>
                    <dd>
                      {row.landingPage ? (
                        <a href={externalUrl(row.landingPage)} target="_blank" rel="noopener noreferrer" title={row.landingPage}>
                          {clip(host(row.landingPage), 48)}
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Call to action</dt>
                    <dd>{row.ladder.cta || row.bestAd?.ctaText || <span className="muted">—</span>}</dd>
                  </div>
                  {funnel ? (
                    <div>
                      <dt>Buyer stage</dt>
                      <dd>{funnel}</dd>
                    </div>
                  ) : null}
                </dl>

                {ladder.length > 1 ? (
                  <div className="insights-ladder">
                    <span className="insights-label">{row.competitor}&apos;s offer ladder</span>
                    <ol>
                      {ladder.map((step, n) => (
                        <li key={step.id} className={step.id === row.ladder.id ? "is-current" : ""}>
                          {n > 0 ? <span className="insights-ladder-arrow" aria-hidden="true">→</span> : null}
                          <span className="insights-ladder-step">
                            <small>{tierName(step.ticketTier)}</small>
                            {clip(step.coreOffer, 60)}
                            {step.pricing ? <em>{step.pricing}</em> : null}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}

                {evidence ? <blockquote className="insights-quote">“{clip(evidence, 220)}”</blockquote> : null}

                {row.bestAd ? (
                  <div className="insights-ad">
                    <span className="insights-label">Strongest ad</span>
                    <p>
                      <strong>{clip(row.bestAd.title, 90) || "Untitled ad"}</strong>
                      {row.bestAd.body ? <> — {clip(row.bestAd.body, 180)}</> : null}
                    </p>
                    <p className="muted">
                      {(adDays(row.bestAd) ?? 0) > 0 ? `Running ${days(adDays(row.bestAd))} · ` : ""}
                      {row.bestAd.adLibraryUrl ? (
                        <a href={row.bestAd.adLibraryUrl} target="_blank" rel="noopener noreferrer">
                          View in Ad Library
                        </a>
                      ) : null}
                    </p>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="ghost-btn insights-open"
                  onClick={() => onOpenOffer(row.ladder.id, row.competitor || "")}
                >
                  See this offer in the ladders →
                </button>
              </div>
            </li>
          );
        })}
      </ol>

      <div className="insights-head">
        <h3>Every offer, ranked</h3>
        <button type="button" className="link-btn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Hide" : `Show all ${ranked.length}`}
        </button>
      </div>
      {showAll ? (
        <div className="table-wrap">
          <table className="comp-table insights-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Offer</th>
                <th>Price level</th>
                <th>Run by</th>
                <th>Ads</th>
                <th>Longest running</th>
                <th>Competitors</th>
                <th>Virality</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((row, i) => (
                <tr key={row.ladder.id} onClick={() => onOpenOffer(row.ladder.id, row.competitor || "")} className="insights-row">
                  <td>{i + 1}</td>
                  <td>
                    <strong>{clip(row.ladder.coreOffer, 80)}</strong>
                    {row.ladder.pricing ? <div className="muted">{row.ladder.pricing}</div> : null}
                  </td>
                  <td>{tierName(row.ladder.ticketTier)}</td>
                  <td>
                    {row.competitor || "—"}
                    {row.website ? <div className="muted">{host(row.website)}</div> : null}
                  </td>
                  <td>{row.adCount}</td>
                  <td>{days(row.longestDays)}</td>
                  <td>{row.competitors.length}</td>
                  <td>
                    <strong>{row.score}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
