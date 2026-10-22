"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { AbPage } from "@/lib/pipeline/awareness/abPages";
import { icpToText } from "@/lib/pipeline/awareness/icpText";
import type { IcpRecord } from "@/lib/types";
import { STAGE_LABELS } from "./CoverageStrip";

export const NO_BASE_TIP = "Analyse a competitor page first";

const FOCUSABLE = "button:not([disabled]), a[href], [tabindex]:not([tabindex=\"-1\"])";

function Block({ title, items }: { title: string; items: string[] }) {
  const clean = items.filter((s) => s && s.trim());
  return (
    <section className="ab-icp-block">
      <h4>{title}</h4>
      {clean.length ? (
        <ul>
          {clean.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing specific.</p>
      )}
    </section>
  );
}

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
  onRegenerate: () => void;
  onPickBase: (page: AbPage) => void;
  onRecreate: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState<"ok" | "fail" | null>(null);
  const label = STAGE_LABELS[stage] ?? stage;
  const choices = pages.filter((p) => p.status === "completed");

  useEffect(() => {
    ref.current?.focus();
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

  return (
    <div className="ab-drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="ab-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={generating}
        tabIndex={-1}
        ref={ref}
        onKeyDown={onKeyDown}
      >
        <div className="ab-drawer-head">
          <h3 id={titleId}>Ideal customer: {label}</h3>
          <button type="button" className="link-btn" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <div className="notice notice-error" role="alert">
            <p>{error}</p>
          </div>
        ) : null}

        {generating && !icp ? (
          <p className="muted" role="status">
            Writing the ICP for this stage…
          </p>
        ) : null}

        {icp ? (
          <>
            <Block title="Pain points" items={icp.painPoints} />
            <section className="ab-icp-block">
              <h4>Demographics</h4>
              {demographics.length ? (
                <ul>
                  {demographics.map(([k, v]) => (
                    <li key={k}>
                      {k}: {v}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Nothing specific.</p>
              )}
            </section>
            <Block title="Psychographics" items={icp.psychographics} />
            <Block title="What they say out loud" items={icp.saysOutLoud} />
            <Block title="Interests" items={icp.interests} />
            <Block title="Hopes & desires" items={icp.hopesAndDesires} />
            {icp.stageNotes ? (
              <section className="ab-icp-block">
                <h4>What this reader knows</h4>
                <p>{icp.stageNotes}</p>
              </section>
            ) : null}
            {icp.suggestedAngle ? (
              <section className="ab-icp-block">
                <h4>Suggested angle</h4>
                <p>{icp.suggestedAngle}</p>
              </section>
            ) : null}

            <div className="ab-drawer-actions">
              <button type="button" className="ghost-btn" disabled={generating} onClick={onRegenerate}>
                {generating ? "Regenerating…" : "Regenerate (uses credits)"}
              </button>
              <button type="button" className="ghost-btn" onClick={copy}>
                Copy
              </button>
              <span className="muted" role="status">
                {copied === "ok" ? "Copied" : copied === "fail" ? "Copy is not available in this browser" : ""}
              </span>
            </div>

            <div className="ab-drawer-recreate">
              {basePage ? (
                <p>
                  Based on: <strong>{basePage.brand}</strong> page{" "}
                  {choices.length > 1 ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={picking}
                      onClick={() => setPicking((v) => !v)}
                    >
                      Change page
                    </button>
                  ) : null}
                </p>
              ) : (
                <p className="muted">
                  {NO_BASE_TIP}.{" "}
                  {choices.length ? (
                    <button
                      type="button"
                      className="link-btn"
                      aria-expanded={picking}
                      onClick={() => setPicking((v) => !v)}
                    >
                      Change page
                    </button>
                  ) : null}
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
              <button
                type="button"
                className="ghost-btn ab-drawer-primary"
                disabled={!basePage || recreating || generating}
                title={basePage ? undefined : NO_BASE_TIP}
                onClick={onRecreate}
              >
                {recreating ? "Opening…" : "Recreate a page for this ICP"}
              </button>
            </div>
          </>
        ) : !generating ? (
          <div className="ab-drawer-actions">
            <button type="button" className="ghost-btn" onClick={onRegenerate}>
              Try again (uses credits)
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
