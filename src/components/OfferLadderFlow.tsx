import type {
  LookupCoreOfferLadder,
  OfferLadderStep,
  OfferTicketTier,
  SearchCompetitorAdRecord,
} from "@/lib/types";
import { offerFitsSearchedService, type ServiceFocus } from "@/lib/pipeline/offerServiceFocus";

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

function tierLabel(tier: OfferTicketTier): string {
  if (tier === "low") return "Low ticket";
  if (tier === "mid") return "Mid ticket";
  if (tier === "high") return "High ticket";
  return "Offer";
}

export function ladderSteps(ladder: LookupCoreOfferLadder): OfferLadderStep[] {
  if (ladder.steps?.length) {
    return [...ladder.steps].sort((a, b) => a.order - b.order);
  }
  return [
    {
      id: ladder.id,
      order: 1,
      ticketTier: ladder.ticketTier,
      offer: ladder.coreOffer,
      cta: ladder.cta,
      pricing: ladder.pricing,
      funnelStage: ladder.funnelStage,
      landingPageUrl: ladder.landingPageUrl,
      competitors: ladder.sourceCompetitors,
    },
  ];
}

/** One ladder per distinct offer. A stored service flow is split into its steps. */
export function splitLaddersByOffer(
  ladders: LookupCoreOfferLadder[],
): LookupCoreOfferLadder[] {
  const out: LookupCoreOfferLadder[] = [];
  for (const ladder of ladders) {
    const steps = ladderSteps(ladder);
    if (steps.length <= 1) {
      const only = steps[0];
      out.push(
        only?.offer && only.offer !== ladder.coreOffer
          ? { ...ladder, coreOffer: only.offer, steps: [{ ...only, order: 1 }] }
          : ladder,
      );
      continue;
    }
    for (const step of steps) {
      out.push({
        ...ladder,
        id: `${ladder.id}::${step.id}`,
        coreOffer: step.offer,
        details: step.pricing ? `${step.offer}. Pricing: ${step.pricing}.` : step.offer,
        cta: step.cta ?? null,
        ticketTier: step.ticketTier,
        pricing: step.pricing ?? null,
        funnelStage: step.funnelStage ?? ladder.funnelStage,
        landingPageUrl: step.landingPageUrl ?? null,
        steps: [{ ...step, order: 1 }],
        adOffers: (ladder.adOffers || []).filter(
          (ad) => ad.creativeId === step.id || ad.offer === step.offer,
        ),
        sourceCompetitors: step.competitors?.length
          ? step.competitors
          : ladder.sourceCompetitors,
      });
    }
  }
  return out.map((ladder, index) => ({ ...ladder, rank: index + 1 }));
}

/**
 * The offers a report shows for the searched service, one per offer. The
 * dashboard and the offer detail page both use this, so an offer has the same
 * id and number in both.
 */
export function visibleOfferLadders(
  ladders: LookupCoreOfferLadder[],
  focus: ServiceFocus,
): LookupCoreOfferLadder[] {
  const filtered = ladders
    .map((ladder) => {
      const originalSteps = ladder.steps || [];
      const steps = originalSteps.filter((step) =>
        offerFitsSearchedService(
          `${step.offer} ${step.pricing || ""} ${step.cta || ""}`,
          focus,
          { requireMatch: true },
        ),
      );
      const coreFits = offerFitsSearchedService(ladder.coreOffer, focus, {
        requireMatch: true,
      });
      if (originalSteps.length > 0 && steps.length === 0) return null;
      if (!coreFits && steps.length === 0) return null;
      if (!steps.length) return coreFits ? ladder : null;
      return {
        ...ladder,
        steps,
        coreOffer: coreFits ? ladder.coreOffer : steps[0].offer,
      };
    })
    .filter((ladder): ladder is LookupCoreOfferLadder => Boolean(ladder));
  return splitLaddersByOffer(filtered);
}

/** Cheapest first: free/entry, then unknown, mid, premium. */
export function tierOrder(tier: OfferTicketTier | undefined): number {
  if (tier === "low") return 0;
  if (tier === "mid") return 2;
  if (tier === "high") return 3;
  return 1;
}

export function tierName(tier: OfferTicketTier | undefined): string {
  if (tier === "low") return "Entry";
  if (tier === "mid") return "Core";
  if (tier === "high") return "Premium";
  return "Price level unknown";
}

/** First number in a price ("$1,490/mo" → 1490), or null; "free" is 0. */
export function priceValue(pricing?: string | null, offer?: string | null): number | null {
  const text = `${pricing || ""}`;
  const m = text.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
  if (m) return Number(m[1].replace(/,/g, ""));
  if (/\bfree\b/i.test(`${pricing || ""} ${offer || ""}`)) return 0;
  return null;
}

export function compareOffersLowToHigh(a: LookupCoreOfferLadder, b: LookupCoreOfferLadder): number {
  const byTier = tierOrder(a.ticketTier) - tierOrder(b.ticketTier);
  if (byTier) return byTier;
  const pa = priceValue(a.pricing, a.coreOffer);
  const pb = priceValue(b.pricing, b.coreOffer);
  if (pa != null && pb != null && pa !== pb) return pa - pb;
  if (pa != null && pb == null) return -1;
  if (pa == null && pb != null) return 1;
  return (b.adCount || 0) - (a.adCount || 0);
}

function urlKey(url?: string | null): string {
  return (url || "").replace(/^https?:\/\//i, "").replace(/\/$/, "").toLowerCase();
}

/**
 * The ads behind one offer: the report's references first, then ads that
 * point at the offer's landing page. When a competitor is given, only its
 * ads. Unlike before, it never falls back to every ad a competitor runs.
 */
export function adsForOffer(
  offer: LookupCoreOfferLadder,
  ads: SearchCompetitorAdRecord[],
  competitorName?: string | null,
): Array<SearchCompetitorAdRecord & { offerMatch: boolean }> {
  const byId = new Map(ads.map((a) => [a.id, a]));
  const byArchive = new Map(ads.map((a) => [a.adArchiveId, a]));
  const name = competitorName?.toLowerCase() || null;
  const seen = new Set<string>();
  const out: SearchCompetitorAdRecord[] = [];
  const push = (ad?: SearchCompetitorAdRecord | null) => {
    if (!ad || seen.has(ad.id)) return;
    if (name && ad.pageName.toLowerCase() !== name) return;
    seen.add(ad.id);
    out.push(ad);
  };
  for (const ref of offer.sourceAdRefs || []) {
    push(byId.get(ref.adId) || (ref.adArchiveId ? byArchive.get(ref.adArchiveId) : undefined));
  }
  const target = urlKey(offer.landingPageUrl);
  if (target) {
    for (const ad of ads) if (urlKey(ad.landingPageUrl) === target) push(ad);
  }
  // The same creative is often stored several times: show it once.
  const copies = new Set<string>();
  const unique = out.filter((ad) => {
    // Per advertiser: two competitors running the same wording are two ads.
    const key = `${ad.pageName}|${ad.title || ""}|${ad.body || ""}`.toLowerCase().replace(/\s+/g, " ").trim();
    if (copies.has(key)) return false;
    copies.add(key);
    return true;
  });
  // A homepage collects every ad that points at it; list the ads whose
  // wording matches this offer first.
  const words = offerWords(offer.coreOffer);
  const score = (ad: SearchCompetitorAdRecord) => {
    const hay = `${ad.title || ""} ${ad.body || ""} ${ad.ctaText || ""}`.toLowerCase();
    return words.filter((w) => hay.includes(w)).length;
  };
  return unique
    .map((ad) => ({ ad, s: score(ad) }))
    .sort((a, b) => b.s - a.s)
    .map(({ ad, s }) => ({ ...ad, offerMatch: s > 0 }));
}

const OFFER_STOP = new Set(["your", "with", "from", "that", "this", "for", "the", "and", "get", "our", "you", "only", "just", "free"]);

function offerWords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9$]+/)
        .filter((w) => w.length >= 4 && !OFFER_STOP.has(w)),
    ),
  );
}

export function OfferLadderFlow({ ladder }: { ladder: LookupCoreOfferLadder }) {
  const steps = ladderSteps(ladder);
  return (
    <ol className="offer-flow">
      {steps.map((step, index) => (
        <li key={step.id} className="offer-flow-item">
          <article className={`offer-flow-step is-${step.ticketTier}`}>
            <div className="offer-flow-step-top">
              <span className="offer-flow-tier">{tierLabel(step.ticketTier)}</span>
              <span className="offer-flow-index">{index + 1}</span>
            </div>
            <h4>{step.offer}</h4>
            {step.pricing ? <p>Pricing: {step.pricing}</p> : null}
            {step.cta ? <p>CTA: {step.cta}</p> : null}
            {step.competitors?.length ? (
              <p className="muted">{step.competitors.join(", ")}</p>
            ) : null}
            {step.landingPageUrl ? (
              <a href={step.landingPageUrl} target="_blank" rel="noreferrer">
                {shortUrl(step.landingPageUrl)}
              </a>
            ) : null}
          </article>
          {index < steps.length - 1 ? (
            <div className="offer-flow-arrow" aria-hidden="true">
              ↓
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
