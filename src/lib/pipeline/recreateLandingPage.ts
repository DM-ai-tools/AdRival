import type {
  BrandColors,
  BusinessProfile,
  CompetitorRecord,
  RecreatedLandingPage,
  SearchJob,
} from "../types";
import { getCompetitor, getJob, updateCompetitor } from "../db";
import { recreateFromArchive } from "./archive/recreateFromArchive";
import { cloneAndAdaptLandingPage } from "./cloneLandingPage";
import { resolveBrandBundle } from "./resolveBrandBundle";

function resolveBusinessUrl(job: SearchJob): string | null {
  const fromJob = (job.businessUrl || "").trim();
  const fromProfile = (job.businessProfile?.url || "").trim();
  const url = fromJob || fromProfile;
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/**
 * Recreate a competitor landing page.
 * Prefers archive pipeline (Playwright capture + deterministic brand + CID text).
 * Falls back to the legacy cheerio clone path if Playwright capture fails.
 */
export async function recreateCompetitorLandingPage(
  competitorId: string,
  options?: { force?: boolean; userFeedback?: string },
): Promise<CompetitorRecord> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");

  const userFeedback = (options?.userFeedback || "").trim().slice(0, 4000);

  if (
    !options?.force &&
    !userFeedback &&
    competitor.recreatedPage?.status === "completed" &&
    competitor.recreatedPage.html
  ) {
    return competitor;
  }

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

  const pending: RecreatedLandingPage = {
    status: "pending",
    createdAt: competitor.recreatedPage?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    businessUrl,
    businessName: job.businessProfile?.businessName || null,
    keyword,
    sourceCompetitorName: competitor.pageName,
    sourceAnalyzedUrl: sourceUrl,
    brandColors:
      job.businessProfile?.brandColors ||
      competitor.recreatedPage?.brandColors || {
        primary: "#0F7A6C",
        secondary: "#134E4A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#0F172A",
        muted: "#64748B",
        source: "pending",
      },
    html: null,
    userFeedback: userFeedback || null,
    error: null,
  };
  updateCompetitor(competitorId, { recreatedPage: pending });

  try {
    let html: string;
    let differentiationNotes: string;
    let colors: BrandColors;

    try {
      const archived = await recreateFromArchive({
        sourceUrl,
        businessUrl,
        competitorName: competitor.pageName,
        brandName,
        keyword,
        profile: job.businessProfile || null,
        userFeedback: userFeedback || null,
      });
      html = archived.html;
      differentiationNotes = archived.differentiationNotes;
      colors = archived.brandColors;

      if (!archived.visualGate.ok) {
        differentiationNotes +=
          " Review flagged sections before publishing — copy rewrite may have shifted density.";
      }
    } catch (archiveErr) {
      console.warn(
        "[recreate] archive pipeline failed, falling back to legacy clone",
        archiveErr,
      );

      const brand = await resolveBrandBundle({
        businessUrl,
        profile: job.businessProfile || null,
      });
      colors = brand.colors;
      const profile: BusinessProfile | null = job.businessProfile
        ? {
            ...job.businessProfile,
            brandColors: colors,
            brandAssets: brand.assets || job.businessProfile.brandAssets || null,
          }
        : null;

      const legacy = await cloneAndAdaptLandingPage({
        sourceUrl,
        keyword,
        competitorName: competitor.pageName,
        businessUrl: brand.finalUrl || businessUrl,
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
      differentiationNotes = `Legacy clone fallback. ${legacy.differentiationNotes}`;
    }

    const completed: RecreatedLandingPage = {
      ...pending,
      status: "completed",
      updatedAt: new Date().toISOString(),
      brandColors: colors,
      html,
      differentiationNotes,
      userFeedback: userFeedback || null,
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
      },
    });
    throw err;
  }
}
