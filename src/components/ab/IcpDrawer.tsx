"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AbPage } from "@/lib/pipeline/awareness/abPages";
import { icpToText } from "@/lib/pipeline/awareness/icpText";
import type { IcpRecord } from "@/lib/types";
import { STAGE_LABELS } from "./CoverageStrip";

export const NO_BASE_TIP = "Analyse a competitor page first";

const FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])";

function Card({ title, className = "", children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`ab-icp-card ${className}`}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function ListCard({ title, items, className }: { title: string; items?: string[]; className?: string }) {
  const clean = (items ?? []).filter((s) => s && s.trim());
  if (!clean.length) return null;
  return (
    <Card title={title} className={className}>
      <ul>
        {clean.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </Card>
  );
}

/** Centred dialog showing one stage's ICP (kept under the old name for its callers). */
export function IcpDrawer({
  stage,
  icp,
  generating,
  error,
  basePage,
  pages,
  recreating,
  onRegenerate,
  onPickBase,
  onRecreate,
  onClose,
}: {
  stage: string;
  icp: IcpRecord | null;
  generating: boolean;
  error: string | null;
  basePage: AbPage | null;
  /** Pages of the run; only completed ones are offered under "Change page". */
  pages: AbPage[];
  recreating?: boolean;
  /** Spends credits; only ever called from an explicit click. */
  onRegenerate: (notes: string) => void;
  onPickBase: (page: AbPage) => void;
  onRecreate: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const [picking, setPicking] = useState(false);
  // The user's own details about their customer; sent with every regenerate and saved on the ICP.
  const [notes, setNotes] = useState(icp?.userNotes ?? "");
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const label = STAGE_LABELS[stage] ?? stage;
  const choices = pages.filter((p) => p.status === "completed");

  useEffect(() => {
    ref.current?.focus();
    // Lock the page behind the dialog so it cannot scroll away and leave a blank gap.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !ref.current) return;
    const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function copy() {
    if (!icp) return;
    try {
      await navigator.clipboard.writeText(icpToText(icp, label));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }

  const demographics = icp
    ? (
        [
          ["Age", icp.demographics.ageRange],
          ["Role", icp.demographics.role],
          ["Budget", icp.demographics.budget],
          ["Location", icp.demographics.location],
          ["Other", icp.demographics.other],
        ] as const
      ).filter(([, v]) => v && v.trim())
    : [];

  const pageToggle = choices.length ? (
    <button type="button" className="link-btn" aria-expanded={picking} onClick={() => setPicking((v) => !v)}>
      Change page
    </button>
  ) : null;

  return (
    <div className="ab-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ab-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={generating}
        tabIndex={-1}
        ref={ref}
        onKeyDown={onKeyDown}
      >
        <header className="ab-modal-head">
          <div>
            <span className="ab-modal-kicker">Ideal customer profile</span>
            <h3 id={titleId}>{label}</h3>
            {icp?.persona ? <p className="ab-modal-persona">{icp.persona}</p> : null}
          </div>
          <button type="button" className="ghost-btn" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="ab-modal-body">
          {error ? (
            <div className="notice notice-error" role="alert">
              <p>{error}</p>
            </div>
          ) : null}

          {generating && !icp ? (
            <div className="ab-modal-loading" role="status">
              <span className="ab-modal-spinner" aria-hidden="true" />
              <p>Writing a profile for this stage from your service, market and the closest competitor page…</p>
            </div>
          ) : null}

          {icp ? (
            <>
              {icp.suggestedAngle ? (
                <div className="ab-icp-angle">
                  <span>Suggested angle</span>
                  <p>{icp.suggestedAngle}</p>
                </div>
              ) : null}

              <div className="ab-icp-grid">
                <ListCard title="Pain points" items={icp.painPoints} />
                <Card title="Who they are">
                  {demographics.length ? (
                    <dl className="ab-icp-demo">
                      {demographics.map(([k, v]) => (
                        <div key={k}>
                          <dt>{k}</dt>
                          <dd>{v}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="muted">Nothing specific.</p>
                  )}
                  {icp.stageNotes ? <p className="ab-icp-notes">{icp.stageNotes}</p> : null}
                </Card>
                <ListCard title="What they say out loud" items={icp.saysOutLoud} className="ab-icp-quotes" />
                <ListCard title="What made them look now" items={icp.triggers} />
                <ListCard title="What makes them hesitate" items={icp.objections} />
                <ListCard title="Mindset" items={icp.psychographics} />
                <ListCard title="Hopes & desires" items={icp.hopesAndDesires} />
                <ListCard title="Interests" items={icp.interests} />
              </div>

              <div className="ab-icp-notes-input">
                <label htmlFor={`${titleId}-notes`}>Personalise this profile</label>
                <textarea
                  id={`${titleId}-notes`}
                  className="search-input"
                  rows={3}
                  maxLength={1500}
                  value={notes}
                  disabled={generating}
                  placeholder="Tell us what is wrong or missing: who your real customers are, their typical budget, objections you hear, words they use… Then press Regenerate to apply it."
                  onChange={(e) => setNotes(e.target.value)}
                />
                <p className="muted">Applied the next time you regenerate. Saved with this profile.</p>
              </div>

              <div className="ab-drawer-recreate">
                {basePage ? (
                  <p>
                    Based on: <strong>{basePage.brand}</strong> page {choices.length > 1 ? pageToggle : null}
                  </p>
                ) : (
                  <p className="muted">
                    {NO_BASE_TIP}. {pageToggle}
                  </p>
                )}
                {picking ? (
                  <ul className="ab-drawer-pages">
                    {choices.map((p) => (
                      <li key={`${p.source}:${p.id}`}>
                        <button
                          type="button"
                          className="link-btn"
                          aria-current={basePage?.id === p.id ? "true" : undefined}
                          onClick={() => {
                            onPickBase(p);
                            setPicking(false);
                          }}
                        >
                          {p.brand}
                          {p.headline ? ` - ${p.headline}` : ""}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </>
          ) : null}
        </div>

        <footer className="ab-modal-foot">
          {icp ? (
            <>
              <button type="button" className="ghost-btn" disabled={generating} onClick={() => onRegenerate(notes)}>
                {generating ? "Regenerating…" : notes.trim() ? "Regenerate with my notes (uses credits)" : "Regenerate (uses credits)"}
              </button>
              <button type="button" className="ghost-btn" onClick={copy}>
                Copy
              </button>
              <span className="muted" role="status">
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy is not available in this browser" : ""}
              </span>
              <button
                type="button"
                className="ghost-btn ab-drawer-primary ab-modal-cta"
                disabled={!basePage || recreating || generating}
                title={
                  !basePage
                    ? NO_BASE_TIP
                    : basePage.origin === "offers"
                      ? "Analyses the base page first and uses credits if it has not been analysed for recreation yet"
                      : undefined
                }
                onClick={onRecreate}
              >
                {recreating ? "Opening…" : "Recreate a page for this ICP"}
              </button>
            </>
          ) : !generating ? (
            <button type="button" className="ghost-btn" onClick={() => onRegenerate(notes)}>
              Try again (uses credits)
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
