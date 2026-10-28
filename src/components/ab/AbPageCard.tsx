"use client";

import { useState } from "react";
import type { AbPage } from "@/lib/pipeline/awareness/abPages";
import { STAGE_LABELS } from "./CoverageStrip";
import { formatRunDate } from "@/lib/pipeline/awareness/runLabels";
import type { RecreateDetails } from "@/lib/recreateClient";
import { AddToRecreateButton, type RecreateSource } from "@/components/recreate/AddToRecreateButton";

const ORIGIN_LABELS: Record<AbPage["origin"], string> = {
  competitor: "Competitor",
  offers: "Offers dashboard",
  lookup: "Lookup",
};

const AUDIENCE_LABELS: Record<string, string> = {
  newbie: "Newbie",
  intermediate: "Intermediate",
  advanced: "Advanced",
  unclear: "Unclear",
};

export function AbPageCard({
  page,
  recreateSource,
  recreateDefaults,
  onLabel,
  labelAllCount,
}: {
  page: AbPage;
  /** What "Add to Recreate" queues for this page; null hides it. */
  recreateSource: RecreateSource | null;
  recreateDefaults?: RecreateDetails;
  /** Starts the label flow (count, then confirm) for this source. */
  onLabel?: () => void;
  /** Labelling covers every unlabelled page of the run, not just this card. */
  labelAllCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const lv = page.levels;
  const focusNote =
    lv?.awarenessFocus === "only_problem"
      ? "only problem"
      : lv?.awarenessFocus === "only_solution"
        ? "only solution"
        : null;
  return (
    <li className="ab-card">
      <div className="ab-card-head">
        <strong>{page.brand}</strong>
        <span className="ab-origin">{ORIGIN_LABELS[page.origin] ?? page.origin}</span>
        {page.url ? (
          <a href={page.url} target="_blank" rel="noreferrer" className="ab-card-url">
            {page.url}
          </a>
        ) : null}
      </div>
      {page.headline ? <p className="ab-card-headline">{page.headline}</p> : null}
      <p className="muted ab-card-meta">
        {page.primaryOffer ? <span>Offer: {page.primaryOffer}</span> : null}
        {page.cta ? <span className="cta-badge">{page.cta}</span> : null}
      </p>

      {formatRunDate(page.analyzedAt).label ? (
        <p className="muted ab-card-analysed">Analysed {formatRunDate(page.analyzedAt).label}</p>
      ) : null}

      {page.status === "pending" ? (
        <p className="muted">Analysing…</p>
      ) : page.status === "failed" ? (
        <p className="error-text" role="alert">
          Analysis failed for this page.
        </p>
      ) : !lv ? (
        <p className="ab-card-unlabelled">
          <span className="location-badge is-unknown">Not labelled</span>{" "}
          {page.status === "completed" && onLabel ? (
            <button type="button" className="link-btn" onClick={onLabel}>
              {labelAllCount && labelAllCount > 1 ? `Label now (labels all ${labelAllCount})` : "Label now"}
            </button>
          ) : null}
        </p>
      ) : (
        <>
          <p className="ab-card-badges">
            <span className="location-badge is-matched">
              Audience: {AUDIENCE_LABELS[lv.audienceLevel] ?? lv.audienceLevel}
            </span>{" "}
            <span className="location-badge is-matched">
              {STAGE_LABELS[lv.awarenessStage] ?? lv.awarenessStage}
            </span>
            {focusNote ? <span className="muted"> ({focusNote})</span> : null}
          </p>
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide reasons" : "Why these levels"}
          </button>
          {open ? (
            <div className="ab-card-reasons muted">
              <p>{lv.audienceReason}</p>
              <p>{lv.awarenessReason}</p>
            </div>
          ) : null}
        </>
      )}

      {recreateSource ? (
        <div className="ab-card-actions">
          <AddToRecreateButton
            source={recreateSource}
            signals={{ daysRunning: null, activeAds: page.activeAds }}
            defaults={recreateDefaults}
            className="ghost-btn"
          />
          {page.origin === "offers" ? (
            <span className="muted ab-card-credit"> Analyses the page first; uses credits if not yet analysed.</span>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
