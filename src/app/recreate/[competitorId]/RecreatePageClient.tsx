"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CompetitorRecord, RecreatedLandingPage } from "@/lib/types";
import { stripDraftBanner } from "@/lib/pipeline/stripDraftBanner";
import { readReturnPath, returnLabel } from "@/lib/returnTo";
import { externalUrl } from "@/lib/externalUrl";
import { FeedbackComposer, type Screenshot } from "./FeedbackComposer";

type Brand = { businessUrl: string | null; businessName: string | null };

type StyleDirection = "brand" | "minimal" | "soft" | "brutalist";

/** Style directions from Taste Skill (skills/recreate). */
const STYLE_OPTIONS: Array<{ id: StyleDirection; label: string; hint: string }> = [
  { id: "brand", label: "Match the brand", hint: "The client's look, the competitor's layout." },
  { id: "minimal", label: "Minimal", hint: "Flat, airy, hairline borders, colour used sparingly." },
  { id: "soft", label: "High-end soft", hint: "Large rounded cards, soft shadows, lots of space." },
  { id: "brutalist", label: "Bold / brutalist", hint: "Square corners, solid rules, heavy headlines." },
];

const LOOKUP_RECREATE_PREFIX = "lookup-recreate-";

/** Where Back goes when the page was opened without a ?back= (old links, bookmarks). */
function defaultReturnPath(runId: string | undefined): string {
  if (!runId) return "/";
  if (runId.startsWith(LOOKUP_RECREATE_PREFIX)) {
    return `/?mode=lookup&lookup=${encodeURIComponent(runId.slice(LOOKUP_RECREATE_PREFIX.length))}`;
  }
  return `/?mode=search&run=${encodeURIComponent(runId)}&tab=preview`;
}

function hostOf(url: string | null | undefined): string {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
}

/**
 * Read a JSON reply. A proxy or crash page (plain text such as "upstream
 * error", or HTML) becomes a readable error marked transient, because a page
 * build may still be running on the server.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJson(res: Response): Promise<Record<string, any>> {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {
      error: res.ok
        ? "The server sent an unexpected reply. Reload the page and try again."
        : "The server took too long to answer. If a page was being built it keeps going, and this page updates when it finishes.",
      transient: true,
    };
  }
}

export function RecreatePageClient({ competitorId }: { competitorId: string }) {
  const [competitor, setCompetitor] = useState<CompetitorRecord | null>(null);
  const [page, setPage] = useState<RecreatedLandingPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** One box for content and design: everything goes to the design agent. */
  const [feedback, setFeedback] = useState("");
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]);
  /** Before a build: images the page must use (stats, product photos…), each with a note. */
  const [assets, setAssets] = useState<Screenshot[]>([]);
  const [canEdit, setCanEdit] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [analysisReady, setAnalysisReady] = useState(false);
  const [websiteDraft, setWebsiteDraft] = useState("");
  const [savingWebsite, setSavingWebsite] = useState(false);
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const [styleDirection, setStyleDirection] = useState<StyleDirection>("brand");

  useEffect(() => {
    setReturnPath(readReturnPath());
  }, []);

  const syncFromPage = useCallback((nextPage: RecreatedLandingPage | null) => {
    setPage(nextPage);
    if (nextPage?.styleDirection) setStyleDirection(nextPage.styleDirection);
    if (nextPage?.status === "failed" && nextPage.error) {
      // Show why the last attempt failed, also after reopening the page.
      setError(nextPage.error);
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`,
    );
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error || "Failed to load");
    setCompetitor(data.competitor as CompetitorRecord);
    setCanEdit(data.access?.canEdit !== false);
    setBrand((data.brand as Brand | undefined) ?? null);
    setAnalysisReady(data.pageAnalysis?.status === "completed");
    syncFromPage((data.recreatedPage as RecreatedLandingPage | null) ?? null);
    return data as {
      competitor: CompetitorRecord;
      recreatedPage: RecreatedLandingPage | null;
      pageAnalysis: CompetitorRecord["pageAnalysis"];
    };
  }, [competitorId, syncFromPage]);

  /**
   * A build keeps running on the server after the request returns (the
   * reply says inFlight), and a proxy time-out does not stop it either.
   * Returns true while the build is still running, so polling follows it.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const followBuild = useCallback(async (data: Record<string, any>): Promise<boolean> => {
    if (data.inFlight && data.competitor) {
      setCompetitor(data.competitor as CompetitorRecord);
      syncFromPage((data.competitor as CompetitorRecord).recreatedPage ?? null);
      return true;
    }
    if (data.transient) {
      const latest = await load().catch(() => null);
      const rp = latest?.recreatedPage;
      return Boolean(rp && (rp.status === "pending" || rp.status === "design_pending"));
    }
    return false;
  }, [load, syncFromPage]);

  /** Sends a request that starts the design agent; feedback and screenshots are cleared once it is accepted. */
  const send = useCallback(
    async (body: Record<string, unknown>, mode: "generate" | "edit", failMessage: string) => {
      setError(null);
      if (mode === "generate") setGenerating(true);
      else setBuilding(true);
      let running = false;
      try {
        const res = await fetch("/api/competitors/recreate-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            competitorId,
            styleDirection,
            userFeedback: feedback.trim() || undefined,
            screenshots: screenshots.length ? screenshots.map((s) => ({ dataUrl: s.dataUrl })) : undefined,
            assets:
              mode === "generate" && assets.length
                ? assets.map((a) => ({ dataUrl: a.dataUrl, caption: a.caption || "" }))
                : undefined,
            ...body,
          }),
        });
        const data = await readJson(res);
        running = await followBuild(data);
        if (running || res.ok) {
          setFeedback("");
          setScreenshots([]);
          if (mode === "generate") setAssets([]);
        }
        if (running) return;
        if (!res.ok) throw new Error(data.error || failMessage);
        const next = data.competitor as CompetitorRecord;
        setCompetitor(next);
        syncFromPage(next.recreatedPage ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!running) {
          setGenerating(false);
          setBuilding(false);
        }
      }
    },
    [assets, competitorId, feedback, followBuild, screenshots, styleDirection, syncFromPage],
  );

  const generatePage = useCallback(
    (force = false) =>
      send({ action: force ? "regenerate_page" : "generate_page", force }, "generate", "Page generation failed"),
    [send],
  );

  /** The same agent changes only what the feedback (and screenshots) describe. */
  const applyChanges = useCallback(() => {
    if (!feedback.trim() && !screenshots.length) {
      setError("Describe the changes you want (and paste a screenshot of the part you mean), then press Apply changes.");
      return;
    }
    void send({ action: "edit_page" }, "edit", "The changes could not be applied");
  }, [feedback, screenshots.length, send]);

  const saveWebsite = useCallback(async () => {
    setError(null);
    setSavingWebsite(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ competitorId, action: "set_business_url", businessUrl: websiteDraft }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "The website could not be saved. Try again.");
      setBrand((data.brand as Brand | undefined) ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingWebsite(false);
    }
  }, [competitorId, websiteDraft]);

  const stopRecreation = useCallback(async () => {
    setStopping(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ competitorId, action: "stop" }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "The page could not be stopped. Try again.");
      if (data.competitor) {
        setCompetitor(data.competitor as CompetitorRecord);
        syncFromPage((data.competitor as CompetitorRecord).recreatedPage ?? null);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStopping(false);
    }
  }, [competitorId, syncFromPage]);

  const undoEdit = useCallback(async () => {
    setError(null);
    setBuilding(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ competitorId, action: "undo_edit" }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || "The last change could not be undone");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }, [competitorId, syncFromPage]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await load();
        if (cancelled) return;
        const rp = data.recreatedPage;
        const inFlight = rp?.status === "pending" || rp?.status === "design_pending";
        if (!rp?.html && data.pageAnalysis?.status !== "completed") {
          setError(
            "Analyze this competitor’s landing page first (Get offer & page details), then come back here.",
          );
        } else if (inFlight) {
          // Creating the page is paid: only follow a build that is already running.
          setGenerating(true);
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
  }, [load]);

  // Poll live progress while the design agent is working
  useEffect(() => {
    const inFlight =
      generating ||
      building ||
      page?.status === "pending" ||
      page?.status === "design_pending";
    if (!inFlight) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`,
        );
        const data = await readJson(res);
        if (cancelled || !res.ok) return;
        const next = data.recreatedPage as RecreatedLandingPage | null;
        if (next) {
          setPage((prev) =>
            prev
              ? { ...prev, ...next, progress: next.progress, status: next.status, html: next.html ?? prev.html }
              : next,
          );
          if (next.status === "completed" || next.status === "failed") {
            setGenerating(false);
            setBuilding(false);
            // Full refresh: shows the finished page and any error.
            void load().catch(() => undefined);
          }
        }
      } catch {
        // ignore poll errors
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [building, competitorId, generating, load, page?.status]);

  const srcDoc = useMemo(() => (page?.html ? stripDraftBanner(page.html) : ""), [page?.html]);

  const working =
    generating || building || page?.status === "pending" || page?.status === "design_pending";
  const progressPct = Math.min(100, Math.max(working ? 4 : 0, page?.progress?.pct ?? (working ? 4 : 0)));
  const progressMessage =
    page?.progress?.message || (working ? "Starting the design agent…" : loading ? "Loading…" : null);
  const stages = page?.progress?.stages || [];
  const activity = page?.progress?.details?.activity || [];

  async function copyHtml() {
    if (!page?.html) return;
    await navigator.clipboard.writeText(stripDraftBanner(page.html));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  function downloadHtml() {
    if (!page?.html) return;
    const publish = stripDraftBanner(page.html);
    const blob = new Blob([publish], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(page.businessName || "landing-page")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}-recreated.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const busy = working || loading;
  const hasFeedback = Boolean(feedback.trim() || screenshots.length);
  const backHref = returnPath || defaultReturnPath(competitor?.runId);
  const fromLookup = Boolean(competitor?.runId?.startsWith(LOOKUP_RECREATE_PREFIX));
  // Nothing made yet: explain what happens and wait for the user, because
  // creating the page is paid.
  const showStart = !loading && !working && analysisReady && !page?.html;
  const needsWebsite = !brand?.businessUrl;

  return (
    <main className="recreate-page">
      <header className="recreate-topbar">
        <div className="recreate-brand">
          <nav className="crumbs" aria-label="You are here">
            <Link href={backHref}>{returnLabel(backHref)}</Link>
            <span aria-hidden="true">›</span>
            <Link href={backHref}>{fromLookup ? "Ads" : "Competitors"}</Link>
            {competitor ? (
              <>
                <span aria-hidden="true">›</span>
                <span>{competitor.pageName}</span>
              </>
            ) : null}
            <span aria-hidden="true">›</span>
            <span aria-current="page">Recreate for my brand</span>
          </nav>
          <Link href={backHref} className="recreate-back">
            ← Back to {fromLookup ? "the lookup" : "competitors"}
          </Link>
          <div>
            <h1>Recreate for my brand</h1>
            <p className="muted">
              {competitor ? `Inspired by ${competitor.pageName}` : "Loading…"}
              {page?.keyword ? ` · keyword “${page.keyword}”` : ""}
              {page?.businessUrl ? (
                <>
                  {" "}
                  · for{" "}
                  <a href={externalUrl(page.businessUrl)} target="_blank" rel="noreferrer">
                    {page.businessName || page.businessUrl}
                  </a>
                </>
              ) : null}
            </p>
          </div>
        </div>
        <div className="recreate-actions">
          {page?.html ? (
            <>
              <button type="button" className="ghost-btn" disabled={busy} onClick={() => void copyHtml()}>
                {copied ? "Copied" : "Copy HTML"}
              </button>
              <button type="button" className="search-btn" disabled={busy} onClick={downloadHtml}>
                Download HTML
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || !canEdit}
                title="Build the whole page again, with your feedback and screenshots if you added any."
                onClick={() => void generatePage(true)}
              >
                {generating ? "Creating page…" : hasFeedback ? "Regenerate page with feedback" : "Regenerate page"}
              </button>
              <button
                type="button"
                className={hasFeedback ? "search-btn" : "ghost-btn"}
                disabled={busy || !canEdit}
                title="Changes only what your feedback and screenshots describe; the rest of the page stays as it is."
                onClick={applyChanges}
              >
                {building ? "Applying changes…" : "Apply changes"}
              </button>
            </>
          ) : null}
          {page?.canUndo ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !canEdit}
              title="Go back to the page as it was before the last change or rebuild."
              onClick={() => void undoEdit()}
            >
              Undo last change
            </button>
          ) : null}
        </div>
      </header>

      {stages.length ? (
        <div className="recreate-phases" aria-label="Recreation progress">
          {stages.map((stage) => (
            <span
              key={stage.id}
              className={
                stage.status === "done" || stage.status === "active" || stage.status === "indeterminate"
                  ? "recreate-phase is-active"
                  : stage.status === "blocked"
                    ? "recreate-phase is-blocked"
                    : "recreate-phase"
              }
              title={stage.detail || undefined}
            >
              {stage.label}
            </span>
          ))}
        </div>
      ) : null}

      {showStart ? (
        <section className="recreate-start panel" aria-labelledby="recreate-start-title">
          <h2 id="recreate-start-title">
            {page?.status === "failed" ? "The last attempt didn't finish" : "Create your version of this page"}
          </h2>
          <ol className="recreate-start-steps">
            <li>
              <strong>Layout</strong> copied from {competitor?.pageName || "the competitor"}&apos;s page
              {competitor?.pageAnalysis?.analyzedUrl ? (
                <>
                  {" "}
                  (
                  <a href={externalUrl(competitor.pageAnalysis.analyzedUrl)} target="_blank" rel="noreferrer">
                    {hostOf(competitor.pageAnalysis.analyzedUrl)}
                  </a>
                  )
                </>
              ) : null}
            </li>
            <li>
              <strong>New copy</strong> with the same message, written for{" "}
              {brand?.businessUrl ? (
                <a href={externalUrl(brand.businessUrl)} target="_blank" rel="noreferrer">
                  {brand.businessName || hostOf(brand.businessUrl)}
                </a>
              ) : (
                "your client"
              )}
              , in their brand, logo, colours and fonts
            </li>
            <li>
              <strong>Up to 6 images</strong> made to match
            </li>
            <li>
              <strong>A finished page</strong>, checked against the competitor, to preview and download as HTML
            </li>
          </ol>

          {needsWebsite ? (
            <div className="recreate-start-website">
              <label htmlFor="recreate-website">
                Your client&apos;s website <span className="muted">(needed for their brand, colours and logo)</span>
              </label>
              <div className="recreate-start-row">
                <input
                  id="recreate-website"
                  type="url"
                  inputMode="url"
                  placeholder="yourbusiness.com"
                  value={websiteDraft}
                  disabled={!canEdit || savingWebsite}
                  onChange={(e) => setWebsiteDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && websiteDraft.trim()) void saveWebsite();
                  }}
                />
                <button
                  type="button"
                  className="search-btn"
                  disabled={!canEdit || savingWebsite || !websiteDraft.trim()}
                  onClick={() => void saveWebsite()}
                >
                  {savingWebsite ? "Saving…" : "Save website"}
                </button>
              </div>
              <p className="muted">This search was run without a website. It is saved on the search for next time.</p>
            </div>
          ) : (
            <FeedbackComposer
              id="recreate-start-notes"
              kind="assets"
              label={
                <>
                  Instructions and images for the page <span className="muted">(optional)</span>
                </>
              }
              rows={3}
              value={feedback}
              onChange={setFeedback}
              screenshots={assets}
              onScreenshotsChange={setAssets}
              disabled={!canEdit}
              placeholder="e.g. Feature the attached products in the hero, use the stats image in the results section, lead with the free consultation, mention Melbourne…"
            />
          )}

          <fieldset className="recreate-style" disabled={!canEdit}>
            <legend className="recreate-feedback-label">Look of the page</legend>
            <div className="recreate-style-options">
              {STYLE_OPTIONS.map((option) => (
                <label key={option.id} className={`recreate-style-option${styleDirection === option.id ? " is-active" : ""}`}>
                  <input
                    type="radio"
                    name="recreate-style"
                    value={option.id}
                    checked={styleDirection === option.id}
                    onChange={() => setStyleDirection(option.id)}
                  />
                  <strong>
                    {option.label}
                    {option.id === "brand" ? <span className="muted"> (recommended)</span> : null}
                  </strong>
                  <span className="muted">{option.hint}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="recreate-start-actions">
            <button
              type="button"
              className="search-btn"
              disabled={!canEdit || needsWebsite || busy}
              onClick={() => void generatePage(page?.status === "failed")}
            >
              {page?.status === "failed" ? "Try again" : "Create my page"}
            </button>
            <p className="muted">
              Takes a while and uses credits. Nothing is charged until you press this button.
            </p>
          </div>
          {!canEdit ? <p className="muted">You can view this page but not create it. Ask an editor of this client space.</p> : null}
        </section>
      ) : null}

      {!showStart && page?.html ? (
        <section className="recreate-feedback panel">
          <div className="recreate-style-row">
            <label htmlFor="recreate-style-select" className="recreate-feedback-label">
              Look of the page
            </label>
            <select
              id="recreate-style-select"
              value={styleDirection}
              disabled={busy || !canEdit}
              onChange={(e) => setStyleDirection(e.target.value as StyleDirection)}
            >
              {STYLE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {styleDirection !== (page.styleDirection || "brand") ? (
              <span className="muted">Press “Regenerate page” to rebuild it in this style.</span>
            ) : (
              <span className="muted">{STYLE_OPTIONS.find((o) => o.id === styleDirection)?.hint}</span>
            )}
          </div>
          <FeedbackComposer
            id="recreate-feedback"
            label="Feedback"
            value={feedback}
            onChange={setFeedback}
            screenshots={screenshots}
            onScreenshotsChange={setScreenshots}
            disabled={busy || !canEdit}
            placeholder="e.g. Make the hero headline match the competitor's offer, show the full logo, shorter FAQ answers…"
            hint={
              <>
                <p className="muted recreate-feedback-hint">
                  Apply changes edits only what you describe and keeps the rest as built. Regenerate page builds the whole
                  page again with this feedback, and uses the images you added before the first build again.
                </p>
                {page.lastEdit ? (
                  <p className="muted recreate-feedback-hint" role="status">
                    Last change: {page.lastEdit.summary}
                  </p>
                ) : null}
              </>
            }
          />
        </section>
      ) : null}

      {page?.differentiationNotes && page.html ? <p className="recreate-notes">{page.differentiationNotes}</p> : null}
      {page?.status === "completed" && page.html ? (
        <div
          className={page.publishReady ? "recreate-publish-status is-ready" : "recreate-publish-status is-blocked"}
          role="status"
        >
          {page.publishReady ? (
            <p>Ready: the preview, Copy HTML and Download HTML are the same page.</p>
          ) : (page.publishBlockers || []).length > 1 ? (
            <>
              <p>Review before publishing:</p>
              <ul className="recreate-review-list">
                {(page.publishBlockers || []).map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>Review notes: {(page.publishBlockers || ["Review recommended"]).join(" · ")}</p>
          )}
        </div>
      ) : null}

      {working || loading ? (
        <div className="recreate-status panel recreate-progress-panel" aria-live="polite">
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              {building ? "Applying changes" : loading && !working ? "Loading" : "Creating the page"}
            </span>
            <span className="offers-analysis-progress-count">{Math.round(progressPct)}%</span>
          </div>
          <div className="progress-bar-track offers-analysis-bar">
            <div className="progress-bar-fill progress-bar-offers" style={{ width: `${progressPct}%` }} />
          </div>
          {progressMessage ? <p className="muted recreate-progress-msg">{progressMessage}</p> : null}
          {activity.length ? (
            // Live feed from the design agent: what it says and the actions it runs.
            <ol
              aria-label="What the design agent is doing"
              style={{
                listStyle: "none",
                margin: "4px 0 12px",
                padding: "10px 12px",
                maxHeight: 240,
                overflowY: "auto",
                display: "flex",
                flexDirection: "column-reverse",
                gap: 6,
                borderRadius: 8,
                background: "rgba(15, 23, 42, 0.04)",
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              {[...activity].reverse().slice(0, 14).map((item) => (
                <li key={item.id} className={item.kind === "action" ? "muted" : undefined}>
                  {item.kind === "action" ? `› ${item.text}` : item.text}
                </li>
              ))}
            </ol>
          ) : null}
          {canEdit && working ? (
            <button type="button" className="danger-btn" disabled={stopping} onClick={() => void stopRecreation()}>
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : null}
        </div>
      ) : null}

      {error && (
        <div className="recreate-status panel" role="alert">
          <p className="error-text">{error}</p>
          {canEdit && !busy && page?.status === "failed" && !showStart ? (
            <button type="button" className="ghost-btn" onClick={() => void generatePage(true)}>
              Try again
            </button>
          ) : null}
          {/Analyze this competitor|landing page analysis|Analyze the competitor/i.test(error) ? (
            <p className="muted">
              Go back to the competitor list, press “Get offer &amp; page details” on this competitor, then
              come back here.{" "}
              <Link href={backHref}>Back to {fromLookup ? "the lookup" : "competitors"}</Link>
            </p>
          ) : null}
        </div>
      )}

      {srcDoc ? (
        <div className="recreate-frame-wrap">
          <iframe
            title="Recreated landing page preview"
            className="recreate-frame"
            sandbox="allow-scripts allow-popups allow-forms"
            srcDoc={srcDoc}
          />
        </div>
      ) : null}
    </main>
  );
}
