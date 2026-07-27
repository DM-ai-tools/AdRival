"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompetitorRecord, RecreatedLandingPage } from "@/lib/types";

export function RecreatePageClient({ competitorId }: { competitorId: string }) {
  const [competitor, setCompetitor] = useState<CompetitorRecord | null>(null);
  const [page, setPage] = useState<RecreatedLandingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    setCompetitor(data.competitor as CompetitorRecord);
    const nextPage = (data.recreatedPage as RecreatedLandingPage | null) ?? null;
    setPage(nextPage);
    if (nextPage?.userFeedback) {
      setFeedback(nextPage.userFeedback);
    }
    return data as {
      competitor: CompetitorRecord;
      recreatedPage: RecreatedLandingPage | null;
      pageAnalysis: CompetitorRecord["pageAnalysis"];
    };
  }, [competitorId]);

  const generate = useCallback(
    async (force = false) => {
      setError(null);
      setGenerating(true);
      try {
        const res = await fetch("/api/competitors/recreate-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            competitorId,
            force,
            userFeedback: feedback.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Recreation failed");
        const next = data.competitor as CompetitorRecord;
        setCompetitor(next);
        setPage(next.recreatedPage ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setGenerating(false);
      }
    },
    [competitorId, feedback],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await load();
        if (cancelled) return;
        const hasHtml =
          data.recreatedPage?.status === "completed" &&
          Boolean(data.recreatedPage.html);
        if (!hasHtml) {
          if (data.pageAnalysis?.status !== "completed") {
            setError(
              "Analyze this competitor’s landing page first (Get offer & page details), then come back here.",
            );
          } else {
            await generate(false);
          }
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only
  }, [load]);

  const srcDoc = useMemo(() => page?.html || "", [page?.html]);

  async function copyHtml() {
    if (!page?.html) return;
    await navigator.clipboard.writeText(page.html);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function downloadHtml() {
    if (!page?.html) return;
    const blob = new Blob([page.html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(page.businessName || "landing-page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-recreated.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const colors = page?.brandColors;

  return (
    <main className="recreate-page">
      <header className="recreate-topbar">
        <div className="recreate-brand">
          <Link href="/" className="recreate-back">
            ← AdRival
          </Link>
          <div>
            <h1>Recreated landing page</h1>
            <p className="muted">
              {competitor
                ? `Inspired by ${competitor.pageName}`
                : "Loading…"}
              {page?.keyword ? ` · keyword “${page.keyword}”` : ""}
              {page?.businessUrl ? (
                <>
                  {" "}
                  · for{" "}
                  <a href={page.businessUrl} target="_blank" rel="noreferrer">
                    {page.businessName || page.businessUrl}
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="recreate-actions">
          <button
            type="button"
            className="ghost-btn"
            disabled={generating || !page?.html}
            onClick={() => void copyHtml()}
          >
            {copied ? "Copied" : "Copy HTML"}
          </button>
          <button
            type="button"
            className="ghost-btn"
            disabled={generating || !page?.html}
            onClick={downloadHtml}
          >
            Download HTML
          </button>
          <button
            type="button"
            className="search-btn"
            disabled={generating || loading}
            onClick={() => void generate(true)}
          >
            {generating
              ? feedback.trim()
                ? "Applying feedback…"
                : "Generating…"
              : feedback.trim()
                ? "Regenerate with feedback"
                : "Regenerate"}
          </button>
        </div>
      </header>

      <section className="recreate-feedback panel">
        <label htmlFor="recreate-feedback" className="recreate-feedback-label">
          Feedback for Claude
        </label>
        <textarea
          id="recreate-feedback"
          className="recreate-feedback-input"
          rows={3}
          maxLength={4000}
          disabled={generating}
          placeholder="e.g. Softer tone, lead with first-home buyers, change CTA to Book a free call, remove deposit percentages, mention Melbourne suburbs…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <p className="muted recreate-feedback-hint">
          Optional. On regenerate, Claude prioritizes these changes across
          headlines, body copy, and CTAs.
          {feedback.trim()
            ? ` · ${feedback.trim().length}/4000`
            : null}
        </p>
      </section>

      {colors && (
        <div className="recreate-palette" aria-label="Brand colors">
          {(
            [
              ["Primary", colors.primary],
              ["Secondary", colors.secondary],
              ["Accent", colors.accent],
              ["Text", colors.text],
            ] as const
          ).map(([label, hex]) => (
            <span key={label} className="recreate-swatch">
              <i style={{ background: hex }} />
              {label} {hex}
            </span>
          ))}
        </div>
      )}

      {page?.differentiationNotes && (
        <p className="recreate-notes">{page.differentiationNotes}</p>
      )}

      {(loading || generating) && !srcDoc && (
        <div className="recreate-status panel">
          <p>
            {generating
              ? feedback.trim()
                ? "Archiving page, applying your brand, rewriting copy with feedback…"
                : "Archiving competitor page (Playwright), applying brand tokens, Claude text-only rewrite…"
              : "Loading…"}
          </p>
        </div>
      )}

      {generating && srcDoc && (
        <div className="recreate-status panel">
          <p>
            {feedback.trim()
              ? "Applying your feedback and regenerating the draft…"
              : "Regenerating draft…"}
          </p>
        </div>
      )}

      {error && (
        <div className="recreate-status panel" role="alert">
          <p className="error-text">{error}</p>
          {/business website URL|Analyze this competitor|landing page analysis|Analyze the competitor/i.test(
            error,
          ) ? (
            <p className="muted">
              Needs: business website URL on the search run + completed landing
              page analysis on this competitor.
            </p>
          ) : /quality validation|too similar|page_hollow|footer_/i.test(
              error,
            ) ? (
            <p className="muted">
              Generation ran with your history data, but the originality check
              failed. Add clearer feedback above and click Regenerate again.
            </p>
          ) : null}
        </div>
      )}

      {srcDoc && (
        <div className="recreate-frame-wrap">
          <iframe
            title="Recreated landing page preview"
            className="recreate-frame"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
          />
        </div>
      )}
    </main>
  );
}
