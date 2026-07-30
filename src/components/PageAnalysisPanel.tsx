"use client";

import type { ReactNode } from "react";
import type { LandingPageOfferAnalysis } from "@/lib/types";

function Field({ label, value }: { label: string; value?: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="lookup-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function PageAnalysisPanel({
  analysis,
}: {
  analysis: LandingPageOfferAnalysis;
}) {
  if (analysis.status === "pending") {
    return (
      <div className="page-analysis-panel">
        <p className="muted">Analyzing landing page…</p>
      </div>
    );
  }

  if (analysis.status === "failed") {
    return (
      <div className="page-analysis-panel page-analysis-failed">
        <h4>Offer & page details</h4>
        <p className="error-text" role="alert">
          {analysis.error || "Analysis failed"}
        </p>
      </div>
    );
  }

  const offer = analysis.offer;
  const sections = analysis.pageArchitecture?.sections || [];
  const sameLp = analysis.sameLandingPageAds;

  return (
    <div className="page-analysis-panel">
      <div className="page-analysis-head">
        <h4>Offer & page details</h4>
        <a href={analysis.analyzedUrl} target="_blank" rel="noreferrer">
          Open page
        </a>
      </div>
      {analysis.error && (
        <p className="error-text" role="alert">
          {analysis.error}
        </p>
      )}
      {analysis.summary && (
        <p className="page-analysis-summary">{analysis.summary}</p>
      )}

      {offer && (
        <div className="page-analysis-block">
          <h5>Offer</h5>
          <dl className="lookup-fields">
            <Field label="Headline" value={offer.headline} />
            <Field label="Primary offer" value={offer.primaryOffer} />
            <Field label="Pricing" value={offer.pricing} />
            <Field label="CTA" value={offer.cta} />
            <Field label="Urgency" value={offer.urgency} />
            {offer.uniqueValueProps && offer.uniqueValueProps.length > 0 && (
              <Field
                label="Value props"
                value={
                  <ul className="page-analysis-list">
                    {offer.uniqueValueProps.map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                }
              />
            )}
            {offer.guarantees && offer.guarantees.length > 0 && (
              <Field
                label="Guarantees"
                value={
                  <ul className="page-analysis-list">
                    {offer.guarantees.map((v) => (
                      <li key={v}>{v}</li>
                    ))}
                  </ul>
                }
              />
            )}
          </dl>
        </div>
      )}

      {sameLp && (
        <div className="page-analysis-block same-lp-ads">
          <h5>
            Ads on this landing page
            {sameLp.matchingAds > 0
              ? ` · ${sameLp.matchingAds} ad${sameLp.matchingAds === 1 ? "" : "s"}`
              : ""}
          </h5>
          <p className="muted same-lp-meta">
            Scanned {sameLp.scannedAds} advertiser ad
            {sameLp.scannedAds === 1 ? "" : "s"}
            {sameLp.ads.length > 0
              ? ` · showing ${sameLp.ads.length} unique creative${
                  sameLp.ads.length === 1 ? "" : "s"
                }`
              : ""}
          </p>
          {sameLp.note && <p className="muted">{sameLp.note}</p>}
          {sameLp.ads.length === 0 ? (
            <p className="muted">
              No other ads found pointing at this landing page.
            </p>
          ) : (
            <ul className="same-lp-ad-list">
              {sameLp.ads.map((ad) => (
                <li key={ad.adArchiveId} className="same-lp-ad">
                  <div className="same-lp-ad-top">
                    <strong className="same-lp-hook">{ad.hook}</strong>
                    <a
                      href={ad.adLibraryUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="same-lp-library-link"
                    >
                      Ad Library
                    </a>
                  </div>
                  <dl className="lookup-fields same-lp-fields">
                    <Field label="Offer" value={ad.offer} />
                    <Field label="CTA" value={ad.ctaText} />
                    {ad.bodySnippet && ad.bodySnippet !== ad.hook && (
                      <Field label="Copy" value={ad.bodySnippet} />
                    )}
                    <Field
                      label="Status"
                      value={
                        [
                          ad.isActive === false ? "Inactive" : "Active",
                          ad.daysRunning != null && ad.daysRunning >= 0
                            ? `${ad.daysRunning}d`
                            : null,
                          ad.country,
                        ]
                          .filter(Boolean)
                          .join(" · ") || null
                      }
                    />
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="page-analysis-block">
        <h5>
          Page architecture
          {analysis.pageArchitecture?.pageType
            ? ` · ${analysis.pageArchitecture.pageType}`
            : ""}
        </h5>
        {sections.length === 0 ? (
          <p className="muted">No sections extracted.</p>
        ) : (
          <ol className="page-section-list">
            {sections.map((s, i) => (
              <li key={`${s.name}-${i}`}>
                <strong>{s.name}</strong>
                <span className="muted"> — {s.purpose}</span>
                <p>{s.summary}</p>
                {s.keyElements && s.keyElements.length > 0 && (
                  <ul className="page-analysis-list">
                    {s.keyElements.map((el) => (
                      <li key={el}>{el}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <dl className="lookup-fields">
        <Field label="Audience" value={analysis.audience} />
        {analysis.trustSignals && analysis.trustSignals.length > 0 && (
          <Field
            label="Trust signals"
            value={analysis.trustSignals.join(" · ")}
          />
        )}
        {analysis.conversionElements &&
          analysis.conversionElements.length > 0 && (
            <Field
              label="Conversion elements"
              value={analysis.conversionElements.join(" · ")}
            />
          )}
        {analysis.techNotes && analysis.techNotes.length > 0 && (
          <Field label="Notes" value={analysis.techNotes.join(" · ")} />
        )}
      </dl>
      <p className="muted page-analysis-meta">
        Analyzed {new Date(analysis.analyzedAt).toLocaleString()}
      </p>
    </div>
  );
}
