"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CompetitorRecord,
  GeneratedLandingImage,
  LandingContentBlock,
  LandingContentDocument,
  RecreatedLandingPage,
} from "@/lib/types";
import { stripDraftBanner } from "@/lib/pipeline/stripDraftBanner";
import { synthesizeDocumentFromBlocks } from "@/lib/pipeline/synthesizeDocumentFromBlocks";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function RecreatePageClient({ competitorId }: { competitorId: string }) {
  const [competitor, setCompetitor] = useState<CompetitorRecord | null>(null);
  const [page, setPage] = useState<RecreatedLandingPage | null>(null);
  const [blocks, setBlocks] = useState<LandingContentBlock[]>([]);
  const [contentDoc, setContentDoc] = useState<LandingContentDocument | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [contentFeedback, setContentFeedback] = useState("");
  const [designFeedback, setDesignFeedback] = useState("");
  const [view, setView] = useState<"content" | "design">("content");
  const [refreshingColors, setRefreshingColors] = useState(false);
  const [showDesignMd, setShowDesignMd] = useState(false);
  const [colorRefreshNote, setColorRefreshNote] = useState<string | null>(null);
  const [regeneratingImageId, setRegeneratingImageId] = useState<string | null>(
    null,
  );
  const [imageFeedback, setImageFeedback] = useState<Record<string, string>>(
    {},
  );
  const [confirmRedesignOpen, setConfirmRedesignOpen] = useState(false);

  const syncFromPage = useCallback((nextPage: RecreatedLandingPage | null) => {
    setPage(nextPage);
    const nextBlocks = nextPage?.contentDraft?.blocks || [];
    setBlocks(nextBlocks);
    let doc = nextPage?.contentDraft?.document || null;
    if ((!doc?.sections?.length) && nextBlocks.length > 0) {
      doc = synthesizeDocumentFromBlocks(nextBlocks, {
        pageType: nextPage?.contentDraft?.pageType,
        tone: nextPage?.contentDraft?.tone,
        competitorUrl: nextPage?.sourceAnalyzedUrl || null,
      });
    }
    setContentDoc(doc);
    if (nextPage?.contentDraft?.userFeedback) {
      setContentFeedback(nextPage.contentDraft.userFeedback);
    }
    if (nextPage?.userFeedback) setDesignFeedback(nextPage.userFeedback);
    if (nextPage?.status === "completed" && nextPage.html) {
      setView("design");
    } else if (
      nextPage?.status === "content_ready" ||
      nextPage?.contentDraft?.status === "ready"
    ) {
      setView("content");
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`,
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    setCompetitor(data.competitor as CompetitorRecord);
    syncFromPage((data.recreatedPage as RecreatedLandingPage | null) ?? null);
    return data as {
      competitor: CompetitorRecord;
      recreatedPage: RecreatedLandingPage | null;
      pageAnalysis: CompetitorRecord["pageAnalysis"];
    };
  }, [competitorId, syncFromPage]);

  const generateContent = useCallback(
    async (force = false) => {
      setError(null);
      setGenerating(true);
      setView("content");
      try {
        const res = await fetch("/api/competitors/recreate-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            competitorId,
            action: force ? "regenerate_content" : "generate_content",
            force,
            userFeedback: contentFeedback.trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Content generation failed");
        const next = data.competitor as CompetitorRecord;
        setCompetitor(next);
        syncFromPage(next.recreatedPage ?? null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setGenerating(false);
      }
    },
    [competitorId, contentFeedback, syncFromPage],
  );

  const saveEdits = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitorId,
          action: "save_content",
          blocks,
          document: contentDoc || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [blocks, contentDoc, competitorId, syncFromPage]);

  const approveAndBuild = useCallback(async () => {
    setError(null);
    setBuilding(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitorId,
          action: "approve_and_build",
          blocks,
          document: contentDoc || undefined,
          userFeedback: designFeedback.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Design build failed");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
      setView("design");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }, [blocks, contentDoc, competitorId, designFeedback, syncFromPage]);

  const regenerateDesign = useCallback(async () => {
    setError(null);
    setBuilding(true);
    setView("design");
    setColorRefreshNote(null);
    setConfirmRedesignOpen(false);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitorId,
          action: "regenerate_design",
          // Keep latest content edits without re-running content generation
          blocks: blocks.length ? blocks : undefined,
          userFeedback: designFeedback.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Design regenerate failed");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
      setView("design");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBuilding(false);
    }
  }, [blocks, competitorId, designFeedback, syncFromPage]);

  const requestRegenerateDesign = useCallback(() => {
    if (page?.status === "completed" && page.html) {
      setConfirmRedesignOpen(true);
      return;
    }
    void regenerateDesign();
  }, [page?.html, page?.status, regenerateDesign]);

  const requestApproveAndBuild = useCallback(() => {
    if (page?.status === "completed" && page.html) {
      setConfirmRedesignOpen(true);
      return;
    }
    void approveAndBuild();
  }, [approveAndBuild, page?.html, page?.status]);

  const refreshBrandColors = useCallback(async () => {
    setError(null);
    setColorRefreshNote(null);
    setRefreshingColors(true);
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitorId,
          action: "refresh_brand_colors",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Brand color refresh failed");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
      const hex = next.recreatedPage?.brandColors;
      setColorRefreshNote(
        hex
          ? `Updated palette: ${hex.primary} · ${hex.secondary} · ${hex.accent}. Regenerate design to apply.`
          : "Brand colors refreshed. Regenerate design to apply.",
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRefreshingColors(false);
    }
  }, [competitorId, syncFromPage]);

  const regenerateImage = useCallback(
    async (image: GeneratedLandingImage) => {
      setError(null);
      setRegeneratingImageId(image.id);
      try {
        const res = await fetch("/api/competitors/recreate-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            competitorId,
            action: "regenerate_image",
            imageId: image.id,
            feedback: (imageFeedback[image.id] || "").trim() || undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Image regenerate failed");
        const next = data.competitor as CompetitorRecord;
        setCompetitor(next);
        syncFromPage(next.recreatedPage ?? null);
        setView("design");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setRegeneratingImageId(null);
      }
    },
    [competitorId, imageFeedback, syncFromPage],
  );

  const downloadImage = useCallback(async (image: GeneratedLandingImage) => {
    try {
      const res = await fetch(image.publicUrl);
      if (!res.ok) throw new Error("Failed to fetch image");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${image.id}-${image.kind}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const downloadAllImages = useCallback(async () => {
    const images = page?.generatedImages || [];
    for (const image of images) {
      await downloadImage(image);
    }
  }, [downloadImage, page?.generatedImages]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await load();
        if (cancelled) return;
        const rp = data.recreatedPage;
        const hasContent =
          rp?.contentDraft &&
          rp.contentDraft.blocks.length > 0 &&
          (rp.status === "content_ready" ||
            rp.status === "completed" ||
            rp.contentDraft.status === "ready" ||
            rp.contentDraft.status === "approved");
        const hasHtml = rp?.status === "completed" && Boolean(rp.html);

        if (!hasContent && !hasHtml) {
          if (data.pageAnalysis?.status !== "completed") {
            setError(
              "Analyze this competitor’s landing page first (Get offer & page details), then come back here.",
            );
          } else {
            await generateContent(false);
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

  // Poll live progress while content/design work is running
  useEffect(() => {
    if (!generating && !building) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/competitors/recreate-page?competitorId=${encodeURIComponent(competitorId)}`,
        );
        const data = await res.json();
        if (cancelled || !res.ok) return;
        const next = data.recreatedPage as RecreatedLandingPage | null;
        if (next?.progress) {
          setPage((prev) =>
            prev
              ? { ...prev, progress: next.progress, status: next.status }
              : next,
          );
        }
      } catch {
        // ignore poll errors
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [building, competitorId, generating]);

  const srcDoc = useMemo(() => page?.html || "", [page?.html]);

  function updateDocMeta(field: "title" | "description", value: string) {
    setContentDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        meta: {
          title: field === "title" ? value : prev.meta?.title || "",
          description:
            field === "description" ? value : prev.meta?.description || "",
        },
      };
    });
  }

  function updateDocSection(
    sectionId: string,
    patch: Partial<LandingContentDocument["sections"][number]>,
  ) {
    setContentDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) =>
          s.id === sectionId ? { ...s, ...patch } : s,
        ),
      };
    });
  }

  function updateDocFaq(
    sectionId: string,
    index: number,
    field: "question" | "answer",
    value: string,
  ) {
    setContentDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        sections: prev.sections.map((s) => {
          if (s.id !== sectionId || !s.faqs) return s;
          const faqs = s.faqs.map((f, i) =>
            i === index ? { ...f, [field]: value } : f,
          );
          return { ...s, faqs };
        }),
      };
    });
  }

  const hasDocument = Boolean(contentDoc?.sections?.length);
  const progressPct = Math.min(
    100,
    Math.max(
      generating || building || loading ? 4 : 0,
      page?.progress?.pct ?? (generating || building ? 8 : 0),
    ),
  );
  const progressMessage =
    page?.progress?.message ||
    (building
      ? "Fitting approved content into the page design…"
      : generating
        ? "Drafting full-page content for your brand…"
        : loading
          ? "Loading…"
          : null);

  async function copyHtml() {
    if (!page?.html) return;
    await navigator.clipboard.writeText(page.html);
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
    a.click();
    URL.revokeObjectURL(url);
  }

  const colors = page?.brandColors;
  const busy =
    generating ||
    building ||
    saving ||
    loading ||
    refreshingColors ||
    regeneratingImageId !== null;
  const canRegenerateDesign =
    blocks.length > 0 &&
    (page?.status === "content_ready" ||
      page?.status === "completed" ||
      page?.status === "failed" ||
      page?.contentDraft?.status === "ready" ||
      page?.contentDraft?.status === "approved");
  const showContentReview =
    view === "content" &&
    blocks.length > 0 &&
    (page?.status === "content_ready" ||
      page?.status === "completed" ||
      page?.contentDraft?.status === "ready" ||
      page?.contentDraft?.status === "approved");

  return (
    <main className="recreate-page">
      <header className="recreate-topbar">
        <div className="recreate-brand">
          <Link href="/" className="recreate-back">
            ← AdRival
          </Link>
          <div>
            <h1>Recreate for my brand</h1>
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
          {page?.html ? (
            <>
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || !page?.html}
                onClick={() => void copyHtml()}
              >
                {copied ? "Copied" : "Copy HTML"}
              </button>
              <button
                type="button"
                className="ghost-btn"
                disabled={busy || !page?.html}
                onClick={downloadHtml}
              >
                Download HTML
              </button>
            </>
          ) : null}
          {page?.html ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() =>
                setView((v) => (v === "design" ? "content" : "design"))
              }
            >
              {view === "design" ? "Edit content" : "View design"}
            </button>
          ) : null}
          <button
            type="button"
            className="ghost-btn"
            disabled={busy}
            onClick={() => void generateContent(true)}
          >
            {generating
              ? "Writing content…"
              : contentFeedback.trim()
                ? "Regenerate content with feedback"
                : "Regenerate content"}
          </button>
          {canRegenerateDesign ? (
            <button
              type="button"
              className="search-btn"
              disabled={busy}
              onClick={() => requestRegenerateDesign()}
            >
              {building
                ? "Building design + images…"
                : designFeedback.trim()
                  ? "Regenerate design with feedback"
                  : page?.html
                    ? "Regenerate design"
                    : "Build design"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="recreate-phases" aria-label="Recreation phases">
        <span
          className={
            page?.status === "content_ready" ||
            page?.contentDraft?.status === "ready" ||
            blocks.length > 0
              ? "recreate-phase is-active"
              : "recreate-phase"
          }
        >
          1 · Content
        </span>
        <span className="recreate-phase-sep" />
        <span
          className={
            page?.status === "completed" && page.html
              ? "recreate-phase is-active"
              : "recreate-phase"
          }
        >
          2 · Design fit
        </span>
      </div>

      <section className="recreate-feedback panel">
        <div className="recreate-feedback-grid">
          <div className="recreate-feedback-col">
            <label
              htmlFor="recreate-content-feedback"
              className="recreate-feedback-label"
            >
              Feedback for content
            </label>
            <textarea
              id="recreate-content-feedback"
              className="recreate-feedback-input"
              rows={3}
              maxLength={4000}
              disabled={busy}
              placeholder="e.g. Softer tone, lead with first-home buyers, CTA = Book a free call…"
              value={contentFeedback}
              onChange={(e) => setContentFeedback(e.target.value)}
            />
            <p className="muted recreate-feedback-hint">
              Used only when regenerating content.
              {contentFeedback.trim()
                ? ` · ${contentFeedback.trim().length}/4000`
                : null}
            </p>
          </div>
          <div className="recreate-feedback-col">
            <label
              htmlFor="recreate-design-feedback"
              className="recreate-feedback-label"
            >
              Feedback for design
            </label>
            <textarea
              id="recreate-design-feedback"
              className="recreate-feedback-input"
              rows={3}
              maxLength={4000}
              disabled={busy}
              placeholder="e.g. Make hero CTA stronger, FAQ answers shorter, emphasize Melbourne suburbs in headings…"
              value={designFeedback}
              onChange={(e) => setDesignFeedback(e.target.value)}
            />
            <p className="muted recreate-feedback-hint">
              Used when approving or regenerating design — keeps approved content,
              refits the layout.
              {designFeedback.trim()
                ? ` · ${designFeedback.trim().length}/4000`
                : null}
            </p>
          </div>
        </div>
      </section>

      {(colors || page?.businessUrl) && (
        <div className="recreate-palette-row">
          {colors ? (
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
          ) : (
            <p className="muted recreate-palette-empty">No brand colors yet</p>
          )}
          <div className="recreate-palette-actions">
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || !page?.businessUrl}
              onClick={() => void refreshBrandColors()}
              title="Re-scrape brand colors and assets from your business URL"
            >
              {refreshingColors ? "Re-analyzing colors…" : "Re-analyze brand colors"}
            </button>
            {colorRefreshNote && canRegenerateDesign ? (
              <button
                type="button"
                className="search-btn"
                disabled={busy}
                onClick={() => requestRegenerateDesign()}
              >
                Apply colors to design
              </button>
            ) : null}
          </div>
          {colorRefreshNote ? (
            <p className="muted recreate-palette-note">{colorRefreshNote}</p>
          ) : null}
        </div>
      )}

      {page?.designMd ? (
        <details
          className="panel recreate-design-md"
          open={showDesignMd}
          onToggle={(e) =>
            setShowDesignMd((e.target as HTMLDetailsElement).open)
          }
        >
          <summary className="recreate-design-md-summary">
            Brand design.md (SSOT for this run)
          </summary>
          <p className="muted recreate-feedback-hint">
            Generated from your brand website. Competitor pages supply layout
            only — colors, fonts, logos, and button styles come from this file.
          </p>
          <pre className="recreate-design-md-body">{page.designMd}</pre>
        </details>
      ) : null}

      {page?.contentDraft?.differentiationSummary && view === "content" && (
        <p className="recreate-notes">{page.contentDraft.differentiationSummary}</p>
      )}
      {page?.differentiationNotes && view === "design" && (
        <p className="recreate-notes">{page.differentiationNotes}</p>
      )}
      {page?.status === "completed" && page.html ? (
        <div
          className={
            page.publishReady
              ? "recreate-publish-status is-ready"
              : "recreate-publish-status is-blocked"
          }
          role="status"
        >
          {page.publishReady ? (
            <p>
              Publish-ready — Download HTML strips the draft banner. CID coverage{" "}
              {page.contentDraft?.cidCoverage != null
                ? `${Math.round(page.contentDraft.cidCoverage * 100)}%`
                : "n/a"}
              .
            </p>
          ) : (
            <p>
              Publish checklist:{" "}
              {(page.publishBlockers || ["Review recommended"]).join(" · ")}
              {page.contentDraft?.cidCoverage != null
                ? ` · CID ${Math.round(page.contentDraft.cidCoverage * 100)}%`
                : ""}
              {page.contentDraft?.unmatchedCidCount
                ? ` · ${page.contentDraft.unmatchedCidCount} unmatched slots kept`
                : ""}
            </p>
          )}
        </div>
      ) : null}
      {page?.sourceArchive && view === "content" ? (
        <p className="muted recreate-palette-note">
          Design will reuse the locked archive ({page.sourceArchive.source},{" "}
          {page.sourceArchive.nodeCount} CIDs) so content placements match.
        </p>
      ) : null}

      {(loading || generating || building) && (
        <div
          className="recreate-status panel recreate-progress-panel"
          aria-live="polite"
        >
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              {building
                ? "Design"
                : generating || page?.status === "pending"
                  ? "Content creation"
                  : "Working"}
              {page?.progress?.phase ? ` · ${page.progress.phase}` : ""}
            </span>
            <span className="offers-analysis-progress-count">
              {Math.round(progressPct)}%
            </span>
          </div>
          <div className="progress-bar-track offers-analysis-bar">
            <div
              className="progress-bar-fill progress-bar-offers"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          {progressMessage ? (
            <p className="muted recreate-progress-msg">{progressMessage}</p>
          ) : null}
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
          ) : null}
        </div>
      )}

      {showContentReview && (
        <section className="recreate-content-review">
          <div className="recreate-content-toolbar panel">
            <div>
              <h2>Review content</h2>
              <p className="muted">
                Full page content for your brand — edit in place, then approve to
                fit into the design.
                {page?.contentDraft?.model
                  ? ` · model ${page.contentDraft.model}`
                  : null}
              </p>
            </div>
            <div className="recreate-content-actions">
              <button
                type="button"
                className="ghost-btn"
                disabled={busy}
                onClick={() => void saveEdits()}
              >
                {saving ? "Saving…" : "Save edits"}
              </button>
              <button
                type="button"
                className="search-btn"
                disabled={busy}
                onClick={() => requestApproveAndBuild()}
              >
                {building
                  ? "Building design + images…"
                  : page?.html
                    ? designFeedback.trim()
                      ? "Rebuild design with feedback"
                      : "Rebuild design"
                    : "Approve & build design"}
              </button>
            </div>
          </div>

          {hasDocument && contentDoc ? (
            <article className="recreate-full-doc panel">
              {contentDoc.meta ? (
                <header className="recreate-full-doc-meta">
                  <textarea
                    className="recreate-full-doc-title"
                    rows={2}
                    disabled={busy}
                    aria-label="Page title"
                    placeholder="Page title"
                    value={contentDoc.meta.title}
                    onChange={(e) => updateDocMeta("title", e.target.value)}
                  />
                  <textarea
                    className="recreate-full-doc-desc"
                    rows={2}
                    disabled={busy}
                    aria-label="Meta description"
                    placeholder="Meta description"
                    value={contentDoc.meta.description}
                    onChange={(e) =>
                      updateDocMeta("description", e.target.value)
                    }
                  />
                </header>
              ) : null}

              {contentDoc.sections.map((section) => (
                <section
                  key={section.id}
                  className={`recreate-full-doc-section kind-${section.kind}`}
                >
                  {section.kind !== "meta" ? (
                    <textarea
                      className="recreate-full-doc-heading"
                      rows={1}
                      disabled={busy}
                      aria-label="Section heading"
                      value={section.title}
                      onChange={(e) =>
                        updateDocSection(section.id, { title: e.target.value })
                      }
                    />
                  ) : null}

                  {section.kind === "faq" ||
                  (section.faqs && section.faqs.length > 0) ? (
                    <div className="recreate-full-doc-faqs">
                      {(section.faqs || []).map((faq, i) => (
                        <div
                          key={`${section.id}-faq-${i}`}
                          className="recreate-full-doc-faq"
                        >
                          <textarea
                            className="recreate-full-doc-faq-q"
                            rows={2}
                            disabled={busy}
                            aria-label={`FAQ question ${i + 1}`}
                            value={faq.question}
                            onChange={(e) =>
                              updateDocFaq(
                                section.id,
                                i,
                                "question",
                                e.target.value,
                              )
                            }
                          />
                          <textarea
                            className="recreate-full-doc-faq-a"
                            rows={3}
                            disabled={busy}
                            aria-label={`FAQ answer ${i + 1}`}
                            value={faq.answer}
                            onChange={(e) =>
                              updateDocFaq(
                                section.id,
                                i,
                                "answer",
                                e.target.value,
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {section.links && section.links.length > 0 ? (
                    <ul className="recreate-full-doc-links">
                      {section.links.map((link, i) => (
                        <li key={`${section.id}-link-${i}`}>
                          <span>{link.label}</span>
                          {link.href ? (
                            <span className="muted"> — {link.href}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {section.logos && section.logos.length > 0 ? (
                    <ul className="recreate-full-doc-links">
                      {section.logos.map((logo, i) => (
                        <li key={`${section.id}-logo-${i}`}>
                          <span>{logo.label}</span>
                          {logo.note ? (
                            <span className="muted"> — {logo.note}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}

                  {section.kind !== "faq" &&
                  section.kind !== "links" &&
                  section.kind !== "logos" ? (
                    <textarea
                      className="recreate-full-doc-body"
                      rows={Math.min(
                        16,
                        Math.max(3, (section.body || "").split("\n").length + 2),
                      )}
                      disabled={busy}
                      aria-label={`${section.title} copy`}
                      value={section.body}
                      onChange={(e) =>
                        updateDocSection(section.id, { body: e.target.value })
                      }
                    />
                  ) : section.body &&
                    !(section.faqs && section.faqs.length) &&
                    !(section.links && section.links.length) &&
                    !(section.logos && section.logos.length) ? (
                    <textarea
                      className="recreate-full-doc-body"
                      rows={3}
                      disabled={busy}
                      value={section.body}
                      onChange={(e) =>
                        updateDocSection(section.id, { body: e.target.value })
                      }
                    />
                  ) : null}
                </section>
              ))}
            </article>
          ) : (
            <p className="empty-hint panel">
              Content document is still assembling. If this persists, click
              Regenerate content.
            </p>
          )}
        </section>
      )}

      {view === "design" && srcDoc && (
        <div className="recreate-frame-wrap">
          <iframe
            title="Recreated landing page preview"
            className="recreate-frame"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
            srcDoc={srcDoc}
          />
        </div>
      )}

      {view === "design" && (page?.generatedImages?.length ?? 0) > 0 ? (
        <section className="recreate-image-gallery" aria-label="Generated images">
          <div className="recreate-image-gallery-head">
            <div>
              <h2>Generated images</h2>
              <p className="muted">
                Generated photos embedded in the design. Regenerate any slot to
                replace it in the preview automatically.
              </p>
            </div>
            <button
              type="button"
              className="ghost-btn"
              disabled={busy || regeneratingImageId !== null}
              onClick={() => void downloadAllImages()}
            >
              Download all
            </button>
          </div>
          <div className="recreate-image-grid">
            {(page?.generatedImages || []).map((image) => {
              const regenerating = regeneratingImageId === image.id;
              return (
                <article key={image.id} className="recreate-image-card">
                  <div className="recreate-image-thumb">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={image.publicUrl} alt={image.label} />
                  </div>
                  <div className="recreate-image-meta">
                    <strong>{image.label}</strong>
                    <span className="muted">
                      {image.kind} · {image.ratio}
                    </span>
                    <label className="recreate-image-feedback">
                      <span className="muted">Regen notes (optional)</span>
                      <input
                        type="text"
                        value={imageFeedback[image.id] || ""}
                        disabled={busy || regenerating}
                        placeholder="e.g. brighter room, fewer people"
                        onChange={(e) =>
                          setImageFeedback((prev) => ({
                            ...prev,
                            [image.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="recreate-image-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={busy || regeneratingImageId !== null}
                        onClick={() => void downloadImage(image)}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="search-btn"
                        disabled={busy || regeneratingImageId !== null}
                        onClick={() => void regenerateImage(image)}
                      >
                        {regenerating ? "Regenerating…" : "Regenerate"}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <ConfirmDialog
        open={confirmRedesignOpen}
        title="Design already completed"
        description={
          page?.sourceAnalyzedUrl
            ? `A design already exists for this landing page (${page.sourceAnalyzedUrl}). Confirm to redesign — the current HTML preview will be replaced.`
            : "A design already exists for this landing page. Confirm to redesign — the current HTML preview will be replaced."
        }
        confirmLabel="Redesign anyway"
        cancelLabel="Cancel"
        busy={building}
        tone="danger"
        onCancel={() => setConfirmRedesignOpen(false)}
        onConfirm={() => {
          // Prefer regenerate when a design already exists (keeps content edits).
          void regenerateDesign();
        }}
      />
    </main>
  );
}
