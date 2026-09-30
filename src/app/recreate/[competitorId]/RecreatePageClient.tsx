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
import { ContentReviewWorkspace } from "./ContentReviewWorkspace";
import { readReturnPath, returnLabel } from "@/lib/returnTo";

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

function downloadText(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
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

type DesignCheckResult =NonNullable<NonNullable<RecreatedLandingPage["qualityReport"]>["designCheck"]>;

/** What the design check (Impeccable + Vercel guidelines) found and fixed. */
function DesignCheckDetails({ check }: { check: DesignCheckResult }) {
  const open = check.remaining.filter((f) => f.action === "repair");
  const brand = check.remaining.filter((f) => f.action === "report");
  const fixedCount = check.autoFixed.length + check.polishedSections.length;
  const where = (id: string | null) => (id ? `section ${id.replace("sec-", "")}` : "header or footer");
  return (
    <details className="recreate-quality">
      <summary>
        Design check:{" "}
        <strong>{open.length ? `${open.length} issue${open.length === 1 ? "" : "s"} to review` : "no open issues"}</strong>
        {fixedCount ? ` · ${fixedCount} fix${fixedCount === 1 ? "" : "es"} applied` : ""}
        {check.engine === "unavailable" ? " · basic checks only" : ""}
      </summary>
      <ul>
        {check.autoFixed.map((line) => (
          <li key={line}>Fixed automatically: {line}.</li>
        ))}
        {check.polishedSections.length ? (
          <li>Polished after the check: section {check.polishedSections.map((id) => id.replace("sec-", "")).join(", ")}.</li>
        ) : null}
        {open.map((f, i) => (
          <li key={`o-${i}`}>
            To review in {where(f.sectionId)}: {f.name}.
          </li>
        ))}
        {brand.map((f, i) => (
          <li key={`b-${i}`} className="muted">
            From the brand or stylesheet (left as is): {f.name}.
          </li>
        ))}
      </ul>
    </details>
  );
}

type VisualReviewResult = NonNullable<NonNullable<RecreatedLandingPage["qualityReport"]>["visualReview"]>;

/** What the side-by-side review against the competitor fixed and what is left. */
function VisualReviewDetails({ review }: { review: VisualReviewResult }) {
  const where = (id: string) => (id === "header" || id === "footer" ? `the ${id}` : `section ${id.replace("sec-", "")}`);
  return (
    <details className="recreate-quality">
      <summary>
        Side-by-side review:{" "}
        <strong>{review.remaining.length ? `${review.remaining.length} part${review.remaining.length === 1 ? "" : "s"} to review` : "every part passed"}</strong>
        {review.fixed.length ? ` · ${review.fixed.length} fixed and re-checked` : ""}
      </summary>
      <ul>
        {review.fixed.length ? <li>Fixed and confirmed: {review.fixed.map(where).join(", ")}.</li> : null}
        {review.remaining.map((r) => (
          <li key={r.id}>
            To review in {where(r.id)}: {r.flaws.join(" ")}
          </li>
        ))}
      </ul>
    </details>
  );
}

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
  const [canEdit, setCanEdit] = useState(true);
  const [confirmRedesignOpen, setConfirmRedesignOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [brand, setBrand] = useState<Brand | null>(null);
  const [analysisReady, setAnalysisReady] = useState(false);
  const [websiteDraft, setWebsiteDraft] = useState("");
  const [savingWebsite, setSavingWebsite] = useState(false);
  const [returnPath, setReturnPath] = useState<string | null>(null);
  const [styleDirection, setStyleDirection] = useState<StyleDirection>("brand");
  const [fillingImages, setFillingImages] = useState(false);

  useEffect(() => {
    setReturnPath(readReturnPath());
  }, []);

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
    if (nextPage?.styleDirection) setStyleDirection(nextPage.styleDirection);
    if (nextPage?.error?.startsWith("SOURCE_INCOMPLETE")) {
      setError(`${nextPage.error.replace(/^SOURCE_INCOMPLETE:\s*/, "")} Retry capture from Recreate content. A replacement draft was not generated.`);
    } else if (nextPage?.status === "failed" && nextPage.error) {
      // Show why the last attempt failed, also after reopening the page.
      setError(nextPage.error);
    }
    if (nextPage?.status === "completed" && nextPage.html) {
      setView("design");
    } else if (nextPage?.pipelineVersion?.startsWith("unified")) {
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

  const generateContent = useCallback(
    async (force = false) => {
      setError(null);
      setGenerating(true);
      setView("design");
      let running = false;
      try {
        const res = await fetch("/api/competitors/recreate-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            competitorId,
            action: force ? "regenerate_page" : "generate_page",
            force,
            styleDirection,
            userFeedback:
              [contentFeedback.trim(), designFeedback.trim()].filter(Boolean).join("\n") ||
              undefined,
          }),
        });
        const data = await readJson(res);
        running = await followBuild(data);
        if (running) return;
        if (!res.ok) throw new Error(data.error || "Page generation failed");
        const next = data.competitor as CompetitorRecord;
        setCompetitor(next);
        syncFromPage(next.recreatedPage ?? null);
        setView("design");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!running) setGenerating(false);
      }
    },
    [competitorId, contentFeedback, designFeedback, followBuild, styleDirection, syncFromPage],
  );

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
      const data = await readJson(res);
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
    let running = false;
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
      const data = await readJson(res);
      running = await followBuild(data);
      if (running) return;
      if (!res.ok) throw new Error(data.error || "Design build failed");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
      setView("design");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!running) setBuilding(false);
    }
  }, [blocks, contentDoc, competitorId, designFeedback, followBuild, syncFromPage]);

  const regenerateDesign = useCallback(async () => {
    setError(null);
    setBuilding(true);
    setView("design");
    setColorRefreshNote(null);
    setConfirmRedesignOpen(false);
    let running = false;
    try {
      const res = await fetch("/api/competitors/recreate-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competitorId,
          action: "regenerate_design",
          styleDirection,
          // Keep latest content edits without re-running content generation
          blocks: blocks.length ? blocks : undefined,
          userFeedback: designFeedback.trim() || undefined,
        }),
      });
      const data = await readJson(res);
      running = await followBuild(data);
      if (running) return;
      if (!res.ok) throw new Error(data.error || "Design regenerate failed");
      const next = data.competitor as CompetitorRecord;
      setCompetitor(next);
      syncFromPage(next.recreatedPage ?? null);
      setView("design");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!running) setBuilding(false);
    }
  }, [blocks, competitorId, designFeedback, followBuild, styleDirection, syncFromPage]);

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
      const data = await readJson(res);
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
        const data = await readJson(res);
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
    if (!image.publicUrl) return;
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
    const images = (page?.generatedImages || []).filter((image) => image.publicUrl);
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
        const hasHtml = Boolean(rp?.html);
        const unifiedDone =
          rp?.pipelineVersion?.startsWith("unified") &&
          rp.status === "completed" &&
          hasHtml;
        const inFlight =
          rp?.status === "pending" ||
          rp?.status === "design_pending" ||
          (rp?.progress?.pct != null && rp.progress.pct > 0 && rp.progress.pct < 100 && rp.status !== "failed" && rp.status !== "completed");

        if (!hasHtml && !unifiedDone) {
          if (data.pageAnalysis?.status !== "completed") {
            setError(
              "Analyze this competitor’s landing page first (Get offer & page details), then come back here.",
            );
          } else if (!inFlight) {
            // Generation is paid: wait for the user to press Create.
          } else {
            setGenerating(true);
            setView("design");
          }
        } else if (hasHtml) {
          setView("design");
          if (inFlight) setGenerating(true);
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
              ? {
                  ...prev,
                  ...next,
                  progress: next.progress,
                  status: next.status,
                  html: next.html ?? prev.html,
                  publishBlockers: next.publishBlockers,
                  generatedImages: next.generatedImages ?? prev.generatedImages,
                }
              : next,
          );
          if (next.status === "completed" || next.status === "failed") {
            setGenerating(false);
            setBuilding(false);
            if (next.html) setView("design");
            // Full refresh: shows the finished page, its images and any error.
            void load().catch(() => undefined);
          }
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
  }, [building, competitorId, generating, load, page?.status]);

  const srcDoc = useMemo(() => (page?.html ? stripDraftBanner(page.html) : ""), [page?.html]);

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
    (building || generating
      ? "Creating content and design together…"
      : loading
        ? "Loading…"
        : null);
  const stages = page?.progress?.stages || [];
  const details = page?.progress?.details;

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

  const colors = page?.brandColors;
  const busy =
    generating ||
    building ||
    saving ||
    loading ||
    refreshingColors ||
    regeneratingImageId !== null;
  const isUnified = Boolean(page?.pipelineVersion?.startsWith("unified"));
  const canRegenerateDesign =
    Boolean(page?.html) ||
    page?.status === "completed" ||
    page?.status === "failed" ||
    page?.status === "content_ready" ||
    page?.status === "design_pending" ||
    Boolean(page?.contentDraft?.status === "ready" || page?.contentDraft?.status === "approved");
  const showContentReview =
    !isUnified &&
    view === "content" &&
    (Boolean(page?.contentPack) || blocks.length > 0) &&
    (page?.status === "content_ready" ||
      page?.status === "completed" ||
      page?.status === "failed" ||
      page?.contentDraft?.status === "ready" ||
      page?.contentDraft?.status === "approved");

  const backHref = returnPath || defaultReturnPath(competitor?.runId);
  const fromLookup = Boolean(competitor?.runId?.startsWith(LOOKUP_RECREATE_PREFIX));
  // Nothing made yet: explain what happens and wait for the user, because
  // creating the page is paid.
  const showStart =
    !loading &&
    !generating &&
    !building &&
    analysisReady &&
    !page?.html &&
    page?.status !== "pending" &&
    page?.status !== "design_pending";
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
                className="search-btn"
                disabled={busy || !page?.html}
                onClick={downloadHtml}
              >
                Download HTML
              </button>
            </>
          ) : null}
          {page?.html && !isUnified ? (
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
          {page?.html ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => void generateContent(true)}
            >
              {generating
                ? "Creating page…"
                : contentFeedback.trim() || designFeedback.trim()
                  ? "Regenerate page with feedback"
                  : "Regenerate page"}
            </button>
          ) : null}
          {/* Only draws the missing images into this page; the page itself is not rebuilt. */}
          {(page?.generatedImages || []).some((image) => image.slotState === "failed") ||
          (page?.publishBlockers || []).some((note) => /image placeholders/i.test(note)) ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              title="Draw only the images that are still placeholders and put them into this page. The copy and layout stay as they are."
              onClick={() => {
                void (async () => {
                  setError(null);
                  setFillingImages(true);
                  setBuilding(true);
                  try {
                    const res = await fetch("/api/competitors/recreate-page", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        competitorId,
                        action: "generate_missing_images",
                      }),
                    });
                    const data = await readJson(res);
                    if (!res.ok) throw new Error(data.error || "Image generation failed");
                    const next = data.competitor as CompetitorRecord;
                    setCompetitor(next);
                    syncFromPage(next.recreatedPage ?? null);
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBuilding(false);
                    setFillingImages(false);
                  }
                })();
              }}
            >
              {fillingImages ? "Generating images…" : "Generate missing images"}
            </button>
          ) : null}
          {canRegenerateDesign && page?.html ? (
            <button
              type="button"
              className="ghost-btn"
              disabled={busy}
              onClick={() => requestRegenerateDesign()}
            >
              {building
                ? "Updating page…"
                : designFeedback.trim()
                  ? "Apply design feedback"
                  : page?.html
                    ? "Request design changes"
                    : "Create page"}
            </button>
          ) : null}
        </div>
      </header>

      <div className="recreate-phases" aria-label="Recreation progress">
        {stages.length ? (
          stages.map((stage) => (
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
              {stage.status === "indeterminate" ? "…" : ""}
            </span>
          ))
        ) : (
          <>
            <span className={page?.html ? "recreate-phase is-active" : "recreate-phase"}>
              Content and design
            </span>
            <span className="recreate-phase-sep" />
            <span
              className={
                page?.status === "completed" && page.html
                  ? "recreate-phase is-active"
                  : "recreate-phase"
              }
            >
              Preview
            </span>
          </>
        )}
      </div>
      {details && (generating || building || page?.status === "design_pending") ? (
        <p className="muted" style={{ margin: "0 0 12px" }}>
          {[
            details.sectionsIdentified != null ? `${details.sectionsIdentified} sections identified` : null,
            details.brandAssetsCollected != null ? `${details.brandAssetsCollected} brand assets collected` : null,
            details.imagesPlanned != null
              ? `${details.imagesCompleted || 0}/${details.imagesPlanned} images`
              : null,
            details.imagesSkippedCredits
              ? `${details.imagesSkippedCredits} skipped (credits)`
              : null,
            details.captureRetry ? "Capture required a retry" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
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
                  <a href={competitor.pageAnalysis.analyzedUrl} target="_blank" rel="noreferrer">
                    {hostOf(competitor.pageAnalysis.analyzedUrl)}
                  </a>
                  )
                </>
              ) : null}
            </li>
            <li>
              <strong>New copy</strong> written for{" "}
              {brand?.businessUrl ? (
                <a href={brand.businessUrl} target="_blank" rel="noreferrer">
                  {brand.businessName || hostOf(brand.businessUrl)}
                </a>
              ) : (
                "your client"
              )}
              , in their brand colours and fonts
            </li>
            <li>
              <strong>Up to 6 images</strong> made to match
            </li>
            <li>
              <strong>A finished page</strong> you can preview, then download as HTML
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
            <>
              <label htmlFor="recreate-start-notes" className="recreate-feedback-label">
                Anything to change? <span className="muted">(optional)</span>
              </label>
              <textarea
                id="recreate-start-notes"
                className="recreate-feedback-input"
                rows={2}
                maxLength={4000}
                disabled={!canEdit}
                placeholder="e.g. Lead with the free consultation, mention Melbourne, softer tone…"
                value={contentFeedback}
                onChange={(e) => setContentFeedback(e.target.value)}
              />
            </>
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
              onClick={() => void generateContent(page?.status === "failed")}
            >
              {page?.status === "failed" ? "Try again" : "Create my page"}
            </button>
            <p className="muted">
              Takes a few minutes and uses credits. Nothing is charged until you press this button.
            </p>
          </div>
          {!canEdit ? <p className="muted">You can view this page but not create it. Ask an editor of this client space.</p> : null}
        </section>
      ) : null}

      {!showStart ? (
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
          {page?.html && styleDirection !== (page.styleDirection || "brand") ? (
            <span className="muted">Press “Regenerate page” to rebuild it in this style.</span>
          ) : (
            <span className="muted">{STYLE_OPTIONS.find((o) => o.id === styleDirection)?.hint}</span>
          )}
        </div>
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
              Combined with design notes when regenerating the full page.
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
              Combined with content notes for a unified regenerate. Layout-only changes keep copy where possible.
              {designFeedback.trim()
                ? ` · ${designFeedback.trim().length}/4000`
                : null}
            </p>
          </div>
        </div>
      </section>
      ) : null}

      {(colors || page?.businessUrl) && !showStart && (
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
            Advanced: the brand style file used for this page
          </summary>
          <p className="muted recreate-feedback-hint">
            The colours, fonts, spacing and components this page was built with, as a DESIGN.md file a developer or
            another design tool can reuse. Competitor pages supply the layout only.{" "}
            <button type="button" className="link-btn" onClick={() => downloadText(page.designMd || "", "DESIGN.md")}>
              Download DESIGN.md
            </button>
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
              {isUnified
                ? "Ready — preview, Copy HTML, and Download HTML use the same packaged artifact."
                : `Ready to publish — Download HTML removes the draft banner.${
                    page.contentDraft?.cidCoverage != null
                      ? ` ${Math.round(page.contentDraft.cidCoverage * 100)}% of the page's text slots were filled.`
                      : ""
                  }`}
            </p>
          ) : isUnified && (page.publishBlockers || []).length > 1 ? (
            <>
              <p>Review before publishing:</p>
              <ul className="recreate-review-list">
                {(page.publishBlockers || []).map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>
              {isUnified ? "Review notes: " : "Publish checklist: "}
              {(page.publishBlockers || ["Review recommended"]).join(" · ")}
              {!isUnified && page.contentDraft?.cidCoverage != null
                ? ` · ${Math.round(page.contentDraft.cidCoverage * 100)}% of text slots filled`
                : ""}
              {!isUnified && page.contentDraft?.unmatchedCidCount
                ? ` · ${page.contentDraft.unmatchedCidCount} slots kept from the original`
                : ""}
            </p>
          )}
        </div>
      ) : null}
      {page?.status === "completed" && page.qualityReport && view === "design" ? (
        <details className="recreate-quality">
          <summary>
            Match with the competitor page: <strong>{Math.round(page.qualityReport.score * 100)}%</strong>
            {" · "}
            {page.qualityReport.sections.filter((s) => !s.problems.length).length} of {page.qualityReport.sections.length} sections
            {page.qualityReport.form
              ? ` · form ${page.qualityReport.form.found}/${page.qualityReport.form.expected} fields${page.qualityReport.form.inPlace ? " in place" : " (moved)"}`
              : ""}
          </summary>
          <ul>
            {page.qualityReport.summary.map((line, index) => (
              <li key={`s-${index}`}>{line}</li>
            ))}
            {page.qualityReport.sections
              .filter((s) => s.problems.length)
              .map((s) => (
                <li key={s.id}>
                  Section {s.id.replace("sec-", "")} ({s.kind}): {s.problems.join(" ")}
                </li>
              ))}
            {page.qualityReport.repairedSections.length ? (
              <li>Rebuilt automatically after the comparison: section {page.qualityReport.repairedSections.map((id) => id.replace("sec-", "")).join(", ")}.</li>
            ) : null}
          </ul>
        </details>
      ) : null}
      {page?.status === "completed" && page.qualityReport?.designCheck && view === "design" ? (
        <DesignCheckDetails check={page.qualityReport.designCheck} />
      ) : null}
      {page?.status === "completed" && page.qualityReport?.visualReview && view === "design" ? (
        <VisualReviewDetails review={page.qualityReport.visualReview} />
      ) : null}
      {page?.sourceArchive && view === "content" ? (
        <p className="muted recreate-palette-note">
          Approved content stays locked. Design measures this competitor’s layout instead of pasting copy into its HTML.
        </p>
      ) : null}

      {(loading ||
        generating ||
        building ||
        page?.status === "pending" ||
        page?.status === "design_pending") && (
        <div
          className="recreate-status panel recreate-progress-panel"
          aria-live="polite"
        >
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              {fillingImages
                ? "Images"
                : building
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
              className={
                page?.progress?.indeterminate
                  ? "progress-bar-fill progress-bar-offers is-indeterminate"
                  : "progress-bar-fill progress-bar-offers"
              }
              style={
                page?.progress?.indeterminate
                  ? undefined
                  : { width: `${progressPct}%` }
              }
            />
          </div>
          {progressMessage ? (
            <p className="muted recreate-progress-msg">{progressMessage}</p>
          ) : null}
          {canEdit && (generating || page?.status === "pending" || page?.status === "design_pending") ? (
            <button
              type="button"
              className="danger-btn"
              disabled={stopping}
              onClick={() => void stopRecreation()}
            >
              {stopping ? "Stopping…" : "Stop"}
            </button>
          ) : null}
        </div>
      )}

      {error && (
        <div className="recreate-status panel" role="alert">
          <p className="error-text">{error}</p>
          {canEdit && !busy && page?.status === "failed" && !showStart ? (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void generateContent(true)}
            >
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

      {showContentReview && page?.contentPack && !page.contentPack.legacy && (
        <ContentReviewWorkspace
          competitorId={competitorId}
          page={page}
          canEdit={canEdit}
          onUpdated={(next) => {
            setCompetitor(next);
            syncFromPage(next.recreatedPage || null);
          }}
        />
      )}

      {showContentReview && !page?.contentPack ? (
        <section className="recreate-content-review">
          <div className="recreate-content-toolbar panel">
            <div>
              <h2>Review content</h2>
              <p className="muted">
                Full page content for your brand — edit in place, then approve to
                fit into the design.
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
      ) : null}

      {view === "design" && srcDoc && (
        <div className="recreate-frame-wrap">
          <iframe
            title="Recreated landing page preview"
            className="recreate-frame"
            sandbox="allow-scripts allow-popups allow-forms"
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
                    {image.publicUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={image.publicUrl} alt={image.label} />
                    ) : (
                      <p className="muted">{image.prompt}</p>
                    )}
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
