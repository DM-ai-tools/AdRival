import type { LookupCoreOfferLadder, OfferLadderStep, OfferTicketTier } from "@/lib/types";

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
