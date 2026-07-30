import type {
  BrandColors,
  BusinessProfile,
  CompetitorRecord,
  LandingContentBlock,
  LandingContentDraft,
  RecreatedLandingPage,
  SearchJob,
} from "../types";
import { getCompetitor, getJob, updateCompetitor, updateJob } from "../db";
import { recreateFromArchive } from "./archive/recreateFromArchive";
import { cloneAndAdaptLandingPage } from "./cloneLandingPage";
import { resolveBrandBundle } from "./resolveBrandBundle";
import {
  brandAssetsFromContentDraft,
  generateLandingContentDraft,
  normalizeEditedContentDraft,
} from "./contentDraft";
import {
  extractBrandLinksWithFirecrawl,
  mergeFirecrawlIntoBrandAssets,
} from "./firecrawlBrandLinks";
import {
  regenerateLandingImage,
  replaceGeneratedImageInHtml,
} from "./generateLandingImages";

function resolveBusinessUrl(job: SearchJob): string | null {
  const fromJob = (job.businessUrl || "").trim();
  const fromProfile = (job.businessProfile?.url || "").trim();
  const url = fromJob || fromProfile;
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function resolveContext(competitorId: string) {
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");

  if (competitor.pageAnalysis?.status !== "completed") {
    throw new Error(
      "Analyze the competitor landing page first (Get offer & page details).",
    );
  }

  const job = getJob(competitor.runId);
  if (!job) throw new Error("Search job not found for this competitor");

  const businessUrl = resolveBusinessUrl(job);
  if (!businessUrl) {
    throw new Error(
      "This search has no business website URL. Re-run search with a business URL so recreation can use your brand.",
    );
  }

  const keyword =
    job.keywords?.[0] ||
    job.keyword.split(",")[0]?.trim() ||
    job.keyword;

  const sourceUrl = competitor.pageAnalysis.analyzedUrl;
  const brandName =
    job.businessProfile?.businessName ||
    (() => {
      try {
        return new URL(businessUrl).hostname.replace(/^www\./, "");
      } catch {
        return "Your Brand";
      }
    })();

  return { competitor, job, businessUrl, keyword, sourceUrl, brandName };
}

function basePageFields(input: {
  competitor: CompetitorRecord;
  job: SearchJob;
  businessUrl: string;
  keyword: string;
  sourceUrl: string;
}): Omit<RecreatedLandingPage, "status" | "updatedAt" | "error"> {
  return {
    createdAt:
      input.competitor.recreatedPage?.createdAt || new Date().toISOString(),
    businessUrl: input.businessUrl,
    businessName: input.job.businessProfile?.businessName || null,
    keyword: input.keyword,
    sourceCompetitorName: input.competitor.pageName,
    sourceAnalyzedUrl: input.sourceUrl,
    brandColors:
      input.job.businessProfile?.brandColors ||
      input.competitor.recreatedPage?.brandColors || {
        primary: "#0F7A6C",
        secondary: "#134E4A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        source: "pending",
      },
    contentDraft: input.competitor.recreatedPage?.contentDraft || null,
    sourceArchive: input.competitor.recreatedPage?.sourceArchive || null,
    html: input.competitor.recreatedPage?.html || null,
    differentiationNotes:
      input.competitor.recreatedPage?.differentiationNotes || null,
    userFeedback: input.competitor.recreatedPage?.userFeedback || null,
  };
}

/**
 * Phase 1 — analyze structure + generate full content pack (OpenAI).
 * Does not build HTML yet; waits for user approval.
 */
export async function generateRecreationContent(
  competitorId: string,
  options?: { force?: boolean; userFeedback?: string },
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const userFeedback = (options?.userFeedback || "").trim().slice(0, 4000);
  const existing = ctx.competitor.recreatedPage;

  if (
    !options?.force &&
    !userFeedback &&
    existing?.contentDraft?.status === "ready" &&
    existing.contentDraft.blocks.length > 0
  ) {
    return ctx.competitor;
  }

  if (
    !options?.force &&
    !userFeedback &&
    existing?.status === "completed" &&
    existing.html &&
    existing.contentDraft?.status === "approved"
  ) {
    return ctx.competitor;
  }

  const pending: RecreatedLandingPage = {
    ...basePageFields(ctx),
    status: "pending",
    updatedAt: new Date().toISOString(),
    html: options?.force ? null : existing?.html || null,
    contentDraft: {
      status: "pending",
      createdAt: existing?.contentDraft?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      model: "",
      blocks: [],
      userFeedback: userFeedback || null,
      error: null,
    },
    userFeedback: userFeedback || null,
    error: null,
  };
  updateCompetitor(competitorId, { recreatedPage: pending });

  try {
    // Resolve brand colors + link inventory for content pack
    let colors: BrandColors = pending.brandColors;
    let siteAssets = ctx.job.businessProfile?.brandAssets || null;
    const linkNotes: string[] = [];
    try {
      const brand = await resolveBrandBundle({
        businessUrl: ctx.businessUrl,
        profile: ctx.job.businessProfile || null,
      });
      colors = brand.colors;
      siteAssets = brand.assets || siteAssets;
    } catch {
      // keep pending colors / profile assets
    }

    // Firecrawl first: real nav / footer / social / service URLs (not homepage-collapsed)
    let servicePages: Array<{ label: string; href: string }> = [];
    try {
      const pack = await extractBrandLinksWithFirecrawl(ctx.businessUrl);
      linkNotes.push(...pack.warnings);
      siteAssets = mergeFirecrawlIntoBrandAssets(
        siteAssets,
        pack,
        ctx.businessUrl,
      );
      servicePages = pack.servicePages;
      linkNotes.push(
        `Firecrawl links: nav×${pack.navLinks.length}, footer×${pack.footerLinks.length}, social×${pack.socialLinks.length}, services×${pack.servicePages.length}`,
      );
    } catch (err) {
      linkNotes.push(
        `Firecrawl link scrape skipped: ${(err as Error).message || String(err)}`,
      );
    }

    const { draft, sourceArchive } = await generateLandingContentDraft({
      analysis: ctx.competitor.pageAnalysis!,
      brandName: ctx.brandName,
      businessUrl: ctx.businessUrl,
      keyword: ctx.keyword,
      competitorName: ctx.competitor.pageName,
      competitorUrl: ctx.sourceUrl,
      profile: ctx.job.businessProfile || null,
      siteAssets,
      servicePages,
      userFeedback: userFeedback || null,
    });

    const ready: RecreatedLandingPage = {
      ...pending,
      status: "content_ready",
      updatedAt: new Date().toISOString(),
      brandColors: colors,
      contentDraft: draft,
      sourceArchive:
        sourceArchive ||
        (options?.force ? null : existing?.sourceArchive) ||
        null,
      differentiationNotes: [
        draft.differentiationSummary ||
          "Content draft ready for review. Approve to fit into the page design.",
        sourceArchive
          ? `Archive locked for design (${sourceArchive.source}, ${sourceArchive.nodeCount} CIDs)`
          : null,
        ...linkNotes.slice(0, 4),
      ]
        .filter(Boolean)
        .join(" · "),
      userFeedback: userFeedback || null,
      error: null,
    };

    const updated = updateCompetitor(competitorId, { recreatedPage: ready });
    if (!updated) throw new Error("Failed to save content draft");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateCompetitor(competitorId, {
      recreatedPage: {
        ...pending,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message,
        contentDraft: {
          status: "failed",
          createdAt: pending.contentDraft?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          model: pending.contentDraft?.model || "",
          blocks: [],
          error: message,
        },
      },
    });
    throw err;
  }
}

/** Persist in-place edits to the content draft without building HTML. */
export function saveRecreationContentEdits(
  competitorId: string,
  blocks: LandingContentBlock[],
): CompetitorRecord {
  const competitor = getCompetitor(competitorId);
  if (!competitor?.recreatedPage?.contentDraft) {
    throw new Error("No content draft to save. Generate content first.");
  }

  const draft = normalizeEditedContentDraft(
    competitor.recreatedPage.contentDraft,
    blocks,
  );
  draft.status = "ready";

  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...competitor.recreatedPage,
      status: "content_ready",
      updatedAt: new Date().toISOString(),
      contentDraft: draft,
      error: null,
    },
  });
  if (!updated) throw new Error("Failed to save content edits");
  return updated;
}

/**
 * Phase 2 — fit approved content into the archived page design.
 */
export async function buildRecreationDesign(
  competitorId: string,
  options?: {
    blocks?: LandingContentBlock[];
    userFeedback?: string;
  },
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const existing = ctx.competitor.recreatedPage;
  if (!existing?.contentDraft || existing.contentDraft.blocks.length === 0) {
    throw new Error(
      "Generate and review content first, then approve to build the design.",
    );
  }

  let draft: LandingContentDraft = existing.contentDraft;
  if (options?.blocks?.length) {
    draft = normalizeEditedContentDraft(draft, options.blocks);
  }
  draft = {
    ...draft,
    status: "approved",
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const userFeedback = (
    options?.userFeedback ||
    existing.userFeedback ||
    ""
  )
    .trim()
    .slice(0, 4000);

  const pending: RecreatedLandingPage = {
    ...basePageFields({ ...ctx, competitor: { ...ctx.competitor, recreatedPage: existing } }),
    status: "design_pending",
    updatedAt: new Date().toISOString(),
    contentDraft: draft,
    html: null,
    userFeedback: userFeedback || null,
    error: null,
  };
  updateCompetitor(competitorId, { recreatedPage: pending });

  try {
    let html: string;
    let differentiationNotes: string;
    let colors: BrandColors = pending.brandColors;

    try {
      const archived = await recreateFromArchive({
        sourceUrl: ctx.sourceUrl,
        businessUrl: ctx.businessUrl,
        competitorName: ctx.competitor.pageName,
        brandName: ctx.brandName,
        keyword: ctx.keyword,
        profile: ctx.job.businessProfile || null,
        userFeedback: userFeedback || null,
        approvedContent: draft,
        preferredColors:
          ctx.job.businessProfile?.brandColors ||
          existing?.brandColors ||
          pending.brandColors ||
          null,
        storedArchive: existing?.sourceArchive || pending.sourceArchive || null,
        forceRecapture: false,
        allowLowCoverageFit: false,
        competitorId,
      });
      html = archived.html;
      differentiationNotes = `Content approved → ${archived.differentiationNotes}`;
      colors = archived.brandColors;

      draft = {
        ...draft,
        cidCoverage: archived.cidCoverage,
        unmatchedCidCount: archived.unmatchedCidCount,
      };

      if (!archived.visualGate.ok) {
        differentiationNotes +=
          " Review flagged sections before publishing — copy density may have shifted layout.";
      }

      const completed: RecreatedLandingPage = {
        ...pending,
        status: "completed",
        updatedAt: new Date().toISOString(),
        brandColors: colors,
        contentDraft: draft,
        sourceArchive: existing?.sourceArchive || pending.sourceArchive || null,
        html,
        generatedImages: archived.generatedImages,
        differentiationNotes,
        userFeedback: userFeedback || null,
        publishReady: archived.publishReady,
        publishBlockers: archived.publishBlockers,
        error: null,
      };

      const updated = updateCompetitor(competitorId, {
        recreatedPage: completed,
      });
      if (!updated) throw new Error("Failed to save recreated page");
      return updated;
    } catch (archiveErr) {
      console.warn(
        "[recreate] archive pipeline failed, falling back to legacy clone",
        archiveErr,
      );

      const brand = await resolveBrandBundle({
        businessUrl: ctx.businessUrl,
        profile: ctx.job.businessProfile || null,
      });
      colors = brand.colors;
      const profile: BusinessProfile | null = ctx.job.businessProfile
        ? {
            ...ctx.job.businessProfile,
            brandColors: colors,
            brandAssets:
              brand.assets || ctx.job.businessProfile.brandAssets || null,
          }
        : null;

      const legacy = await cloneAndAdaptLandingPage({
        sourceUrl: ctx.sourceUrl,
        keyword: ctx.keyword,
        competitorName: ctx.competitor.pageName,
        businessUrl: brand.finalUrl || ctx.businessUrl,
        profile,
        colors,
        brandAssets: brand.assets,
        userFeedback: userFeedback || null,
        brandWarnings: [
          `Archive capture failed: ${(archiveErr as Error).message}`,
          ...brand.warnings,
        ],
      });
      html = legacy.html;
      differentiationNotes = `Content approved → Legacy clone fallback. ${legacy.differentiationNotes}`;
    }

    const completed: RecreatedLandingPage = {
      ...pending,
      status: "completed",
      updatedAt: new Date().toISOString(),
      brandColors: colors,
      contentDraft: draft,
      sourceArchive: existing?.sourceArchive || pending.sourceArchive || null,
      html,
      generatedImages: [],
      differentiationNotes,
      userFeedback: userFeedback || null,
      publishReady: false,
      publishBlockers: ["Legacy clone fallback — review carefully"],
      error: null,
    };

    const updated = updateCompetitor(competitorId, {
      recreatedPage: completed,
    });
    if (!updated) throw new Error("Failed to save recreated page");
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateCompetitor(competitorId, {
      recreatedPage: {
        ...pending,
        status: "failed",
        updatedAt: new Date().toISOString(),
        error: message,
        html: null,
        contentDraft: draft,
      },
    });
    throw err;
  }
}

/**
 * Regenerate a single Runway image and swap it into the stored HTML in place.
 */
export async function regenerateGeneratedImageForRecreation(
  competitorId: string,
  imageId: string,
  feedback?: string,
): Promise<CompetitorRecord> {
  const ctx = resolveContext(competitorId);
  const page = ctx.competitor.recreatedPage;
  if (!page?.html) {
    throw new Error("No completed design to update");
  }
  const images = page.generatedImages || [];
  const existing = images.find((img) => img.id === imageId);
  if (!existing) {
    throw new Error(`Generated image "${imageId}" not found`);
  }

  const nextImage = await regenerateLandingImage({
    image: existing,
    competitorId,
    feedback: feedback || null,
  });
  const html = replaceGeneratedImageInHtml(page.html, nextImage);
  const nextImages = images.map((img) =>
    img.id === imageId ? nextImage : img,
  );

  const updated = updateCompetitor(competitorId, {
    recreatedPage: {
      ...page,
      html,
      generatedImages: nextImages,
      updatedAt: new Date().toISOString(),
    },
  });
  if (!updated) throw new Error("Failed to save regenerated image");
  return updated;
}

/**
 * Re-run Firecrawl branding for the job's business URL and store the latest
 * colors / assets / design tokens on the job profile + recreated page.
 * Does not rebuild HTML — call buildRecreationDesign afterward to apply.
 */
export async function refreshBrandColorsForRecreation(
  competitorId: string,
): Promise<{
  competitor: CompetitorRecord;
  warnings: string[];
}> {
  const ctx = resolveContext(competitorId);
  const brand = await resolveBrandBundle({
    businessUrl: ctx.businessUrl,
    profile: ctx.job.businessProfile || null,
  });

  const nextProfile: BusinessProfile = {
    ...(ctx.job.businessProfile || {
      url: ctx.businessUrl,
      businessName: ctx.brandName,
      industry: "",
      description: "",
      offerings: [],
      competitorKeywords: [],
      positioningSummary: "",
    }),
    url: ctx.job.businessProfile?.url || ctx.businessUrl,
    brandColors: brand.colors,
    brandAssets: brand.assets || ctx.job.businessProfile?.brandAssets || null,
    brandDesign: brand.design || ctx.job.businessProfile?.brandDesign || null,
    analyzedAt: new Date().toISOString(),
  };

  updateJob(ctx.job.id, {
    businessProfile: nextProfile,
    businessUrl: ctx.job.businessUrl || brand.finalUrl || ctx.businessUrl,
  });

  const existing = ctx.competitor.recreatedPage;
  const nextPage: RecreatedLandingPage = existing
    ? {
        ...existing,
        brandColors: brand.colors,
        businessUrl: brand.finalUrl || existing.businessUrl || ctx.businessUrl,
        businessName:
          nextProfile.businessName || existing.businessName || ctx.brandName,
        updatedAt: new Date().toISOString(),
      }
    : {
        ...basePageFields({
          competitor: ctx.competitor,
          job: { ...ctx.job, businessProfile: nextProfile },
          businessUrl: brand.finalUrl || ctx.businessUrl,
          keyword: ctx.keyword,
          sourceUrl: ctx.sourceUrl,
        }),
        status: "content_ready",
        updatedAt: new Date().toISOString(),
        brandColors: brand.colors,
        error: null,
      };

  const updated = updateCompetitor(competitorId, { recreatedPage: nextPage });
  if (!updated) throw new Error("Failed to save refreshed brand colors");

  return { competitor: updated, warnings: brand.warnings };
}

/**
 * @deprecated Prefer generateRecreationContent + buildRecreationDesign.
 * Kept for callers that still expect a one-shot path — now starts at content phase.
 */
export async function recreateCompetitorLandingPage(
  competitorId: string,
  options?: { force?: boolean; userFeedback?: string },
): Promise<CompetitorRecord> {
  return generateRecreationContent(competitorId, options);
}
