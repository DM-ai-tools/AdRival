import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { BusinessProfile, CompetitorRecord, RecreatedLandingPage, SearchJob } from "../../types";
import { getCompetitor, getJob, updateCompetitor, updateJob } from "../../db";
import { resolveBrandBundle } from "../resolveBrandBundle";
import {
  extractBrandLinksWithFirecrawl,
  mergeFirecrawlIntoBrandAssets,
} from "../firecrawlBrandLinks";
import { resolveBrandDisplayName } from "../brandDisplayName";
import { captureRenderedInventory } from "../content/captureInventory";
import {
  enrichInventoryWithCampaignOffer,
  hasUsableCompetitorReference,
  hasUsableRenderedSource,
  inventoryFromLandingOutline,
  limitInventoryToSingleForm,
} from "../content/inventory";
import { extractPageOutline } from "../landingPageAnalysis";
import { fetchRawLandingHtml } from "../htmlFetch";
import { assertCanDraft, researchClientSite } from "../content/research";
import { captureLayoutEvidence } from "../design/captureLayout";
import { alignLayoutEvidence } from "../design/layoutEvidence";
import { logoStatus } from "../design/constructPage";
import { assertPublicHttpUrl } from "../content/safeUrl";
import { extractColorsViaFirecrawl } from "../brandColorSources";
import type { BrandSiteAssets } from "../brandAssets";
import { sanitizeClientFacingText } from "../../clientFacing";
import { buildUnifiedBrief } from "./brief";
import { generateUnifiedPage, repairUnifiedPage, UnifiedRepairIncompleteError } from "./generatePage";
import { executeImageSlots } from "./images";
import { ensurePageChrome, injectIdentityLogo, injectProofLogos, validateAndPackageUnifiedPage } from "./validate";
import { buildRecreateChromeLinks, scrubOffTopicChromeHtml, extractCompetitorChromeFromHtml, type CompetitorChrome } from "./recreateChrome";
import { verifyAndRepairUnifiedPage } from "./verifyPage";
import { embedRemoteImagesInHtml } from "../design/packageHtml";
import { captureCompetitorScreenshotTiles } from "../competitorScreenshots";
import {
  beginUnifiedAbort,
  endUnifiedAbort,
  abortUnifiedRun,
  isUnifiedAbortError,
} from "./abort";
import {
  UNIFIED_PIPELINE_VERSION,
  initialStages,
  markStage,
  pctFromStages,
  type UnifiedStage,
  type UnifiedStageId,
} from "./stages";

function resolveBusinessUrl(job: SearchJob): string | null {
  const fromJob = (job.businessUrl || "").trim();
  const fromProfile = (job.businessProfile?.url || "").trim();
  const url = fromJob || fromProfile;
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function sniffImageMime(bytes: Buffer, headerMime: string): string | null {
  const mime = headerMime.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("image/")) return mime;
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 6 && bytes.slice(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (bytes.length >= 6 && bytes.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (bytes.length >= 12 && bytes.slice(0, 4).toString("ascii") === "RIFF") return "image/webp";
  const head = bytes.slice(0, Math.min(bytes.length, 256)).toString("utf8");
  if (/<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (/octet-stream/i.test(mime) && bytes.length > 32) return "image/png";
  return null;
}

async function embedRemoteAsset(url: string): Promise<string | null> {
  try {
    const parsed = await assertPublicHttpUrl(url);
    const response = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 32 || bytes.length > 2_000_000) return null;
    const mime = sniffImageMime(bytes, response.headers.get("content-type") || "");
    if (!mime) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function logoCdnFallbacks(businessUrl: string): string[] {
  try {
    const host = new URL(
      businessUrl.startsWith("http") ? businessUrl : `https://${businessUrl}`,
    ).hostname.replace(/^www\./i, "");
    return [
      `https://logo.clearbit.com/${host}`,
      `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
    ];
  } catch {
    return [];
  }
}

function withLogoUrl(assets: BrandSiteAssets | null, logoUrl: string, businessUrl: string): BrandSiteAssets {
  const base: BrandSiteAssets = assets || {
    finalUrl: businessUrl,
    siteName: null,
    logoUrl: null,
    faviconUrl: null,
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: [],
    images: [],
    emails: [],
    phones: [],
  };
  return {
    ...base,
    logoUrl,
    images: [
      { src: logoUrl, alt: base.siteName || "Logo", kind: "logo" as const },
      ...base.images.filter((image) => image.src !== logoUrl),
    ],
  };
}

/**
 * Resolve an embeddable identity logo data URI.
 * Prefers Firecrawl Branding Format v2 logo when cached/remote URLs fail to download.
 * @see https://www.firecrawl.dev/blog/branding-format-v2
 */
async function ensureEmbeddableIdentityLogo(
  businessUrl: string,
  assets: BrandSiteAssets | null,
): Promise<{ assets: BrandSiteAssets | null; identityLogoDataUri: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const candidates: string[] = [];
  const push = (url: string | null | undefined) => {
    const value = (url || "").trim();
    if (!value || candidates.includes(value)) return;
    candidates.push(value);
  };
  push(logoStatus(assets).url);
  push(assets?.logoUrl);
  for (const image of assets?.images || []) {
    if (image.kind === "logo") push(image.src);
  }

  for (const url of candidates) {
    if (url.startsWith("data:image/")) {
      return { assets, identityLogoDataUri: url, warnings };
    }
    const embedded = await embedRemoteAsset(url);
    if (embedded) return { assets, identityLogoDataUri: embedded, warnings };
  }

  // Refresh via Firecrawl branding (v2 logo extraction) even when a cached brand bundle exists.
  try {
    const fc = await extractColorsViaFirecrawl(businessUrl);
    warnings.push(...fc.warnings.map((w) => sanitizeClientFacingText(w)));
    const firecrawlLogo = fc.logoUrl || fc.assets?.logoUrl || null;
    if (firecrawlLogo) {
      const nextAssets = withLogoUrl(fc.assets || assets, firecrawlLogo, businessUrl);
      if (assets) {
        nextAssets.navLinks = assets.navLinks.length ? assets.navLinks : nextAssets.navLinks;
        nextAssets.footerLinks = assets.footerLinks.length ? assets.footerLinks : nextAssets.footerLinks;
        nextAssets.ctaLinks = assets.ctaLinks?.length ? assets.ctaLinks : nextAssets.ctaLinks;
        nextAssets.socialLinks = assets.socialLinks.length ? assets.socialLinks : nextAssets.socialLinks;
        nextAssets.emails = assets.emails.length ? assets.emails : nextAssets.emails;
        nextAssets.phones = assets.phones.length ? assets.phones : nextAssets.phones;
        // Keep page logos from HTML so proof strips can use Firecrawl/site image links.
        const seen = new Set(nextAssets.images.map((i) => i.src));
        for (const image of assets.images || []) {
          if (!image.src || seen.has(image.src)) continue;
          seen.add(image.src);
          nextAssets.images.push(image);
        }
      }
      const embedded = firecrawlLogo.startsWith("data:")
        ? firecrawlLogo
        : await embedRemoteAsset(firecrawlLogo);
      if (embedded) {
        warnings.push("Identity logo embedded from site branding.");
        return { assets: nextAssets, identityLogoDataUri: embedded, warnings };
      }
      // Embed failed — keep trying CDN fallbacks instead of shipping a hotlink that browsers often break.
      warnings.push("Branding logo URL found but bytes could not be inlined; trying CDN fallbacks.");
      assets = nextAssets;
      push(firecrawlLogo);
    } else {
      warnings.push("Site branding returned no logo URL.");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Site branding logo refresh failed: ${message.slice(0, 160)}`);
  }

  for (const url of logoCdnFallbacks(businessUrl)) {
    const embedded = await embedRemoteAsset(url);
    if (embedded) {
      warnings.push("Used CDN logo fallback because the site logo could not be embedded.");
      return {
        assets: withLogoUrl(assets, url, businessUrl),
        identityLogoDataUri: embedded,
        warnings,
      };
    }
  }

  // Last resort: keep a remote https logo link so the page still shows branding.
  const remoteFallback = candidates.find((url) => /^https?:\/\//i.test(url)) || assets?.logoUrl || null;
  if (remoteFallback && /^https?:\/\//i.test(remoteFallback)) {
    warnings.push("Using remote logo URL because inlining failed.");
    return { assets, identityLogoDataUri: remoteFallback, warnings };
  }

  return { assets, identityLogoDataUri: null, warnings };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function persist(
  competitorId: string,
  page: RecreatedLandingPage,
  stages: UnifiedStage[],
  phase: UnifiedStageId | "failed",
  message: string,
  extra: Partial<RecreatedLandingPage> = {},
): RecreatedLandingPage {
  const pct = phase === "failed" ? page.progress?.pct || 0 : phase === "ready" ? 100 : pctFromStages(stages);
  const details = {
    ...(page.progress?.details || {}),
    ...(extra.progress?.details || {}),
  };
  const { progress: _ignored, ...rest } = extra;
  const next: RecreatedLandingPage = {
    ...page,
    ...rest,
    progress: {
      phase,
      message,
      pct,
      stages,
      indeterminate: stages.some((stage) => stage.status === "indeterminate"),
      details,
    },
    updatedAt: new Date().toISOString(),
  };
  updateCompetitor(competitorId, { recreatedPage: next });
  return next;
}

function basePage(input: {
  competitor: CompetitorRecord;
  job: SearchJob;
  businessUrl: string;
  keyword: string;
  sourceUrl: string;
}): RecreatedLandingPage {
  const existing = input.competitor.recreatedPage;
  return {
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "pending",
    businessUrl: input.businessUrl,
    businessName: resolveBrandDisplayName({
      businessUrl: input.businessUrl,
      siteName: input.job.businessProfile?.brandAssets?.siteName,
      profileName: input.job.businessProfile?.businessName,
      competitorName: input.competitor.pageName,
    }),
    keyword: input.keyword,
    sourceCompetitorName: input.competitor.pageName,
    sourceAnalyzedUrl: input.sourceUrl,
    brandColors:
      input.job.businessProfile?.brandColors ||
      existing?.brandColors || {
        primary: "#0F7A6C",
        secondary: "#134E4A",
        accent: "#F59E0B",
        background: "#FFFFFF",
        text: "#0F172A",
      },
    html: existing?.html || null,
    generatedImages: existing?.generatedImages || [],
    contentDraft: existing?.contentDraft || null,
    contentPack: existing?.contentPack || null,
    sourceArchive: existing?.sourceArchive || null,
    pipelineVersion: UNIFIED_PIPELINE_VERSION,
    designBuildId: randomUUID(),
    designRendererVersion: UNIFIED_PIPELINE_VERSION,
    publishReady: false,
    publishBlockers: [],
    error: null,
    progress: {
      phase: "preparing",
      message: "Preparing project…",
      pct: 0,
      stages: initialStages(),
    },
  };
}

export function isUnifiedRunActive(page: RecreatedLandingPage | null | undefined): boolean {
  if (!page) return false;
  if (page.status !== "pending" && page.status !== "design_pending") return false;
  const updated = Date.parse(page.updatedAt || "");
  if (!Number.isFinite(updated)) return false;
  // Allow long Claude streams; heartbeats refresh updatedAt about every 8s.
  return Date.now() - updated < 30 * 60 * 1000;
}

/** Abort an in-flight unified recreate and mark the page stopped. */
export function stopUnifiedRecreation(
  competitorId: string,
  reason = "Recreation stopped",
): CompetitorRecord {
  abortUnifiedRun(competitorId);
  const competitor = getCompetitor(competitorId);
  if (!competitor?.recreatedPage) {
    throw new Error("Competitor not found");
  }
  const page = competitor.recreatedPage;
  const stages = (page.progress?.stages || initialStages()).map((stage) =>
    stage.status === "active" || stage.status === "indeterminate"
      ? { ...stage, status: "blocked" as const, detail: reason }
      : stage,
  );
  const next: RecreatedLandingPage = {
    ...page,
    status: page.html ? "completed" : "failed",
    error: reason,
    progress: {
      phase: "failed",
      message: reason,
      pct: page.progress?.pct || 0,
      stages,
      indeterminate: false,
      details: page.progress?.details,
    },
    updatedAt: new Date().toISOString(),
  };
  updateCompetitor(competitorId, { recreatedPage: next });
  const latest = getCompetitor(competitorId);
  if (!latest) throw new Error("Failed to stop recreation");
  return latest;
}

/** Unified recreate: capture → brief → Anthropic content+HTML → images → validate. */
export async function runUnifiedRecreation(
  competitorId: string,
  options: { force?: boolean; userFeedback?: string | null } = {},
): Promise<CompetitorRecord> {
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");
  if (competitor.pageAnalysis?.status !== "completed") {
    throw new Error("Analyze the competitor landing page first (Get offer & page details).");
  }
  const job = getJob(competitor.runId);
  if (!job) throw new Error("Search job not found for this competitor");
  const businessUrl = resolveBusinessUrl(job);
  if (!businessUrl) {
    throw new Error("This search has no business website URL. Re-run search with a business URL so recreation can use your brand.");
  }
  if (!options.force && isUnifiedRunActive(competitor.recreatedPage) && competitor.recreatedPage?.pipelineVersion === UNIFIED_PIPELINE_VERSION) {
    return competitor;
  }

  const abortSignal = beginUnifiedAbort(competitorId);
  /** Last complete HTML from this run, kept if a later validation step fails. */
  let salvageHtml = "";
  const keyword = job.keywords?.[0] || job.keyword.split(",")[0]?.trim() || job.keyword;
  const sourceUrl = competitor.pageAnalysis.analyzedUrl;
  let page = basePage({ competitor, job, businessUrl, keyword, sourceUrl });
  let stages = initialStages();
  page = persist(competitorId, page, markStage(stages, "preparing", "active"), "preparing", "Preparing project…");
  stages = markStage(stages, "preparing", "done");

  try {
    // Competitor capture and client brand/facts run concurrently.
    stages = markStage(stages, "analyzing_competitor", "active", "Capturing rendered competitor page…");
    stages = markStage(stages, "analyzing_client", "active");
    page = persist(competitorId, page, stages, "analyzing_competitor", "Analysing competitor page and your brand…");

    let captureRetry = false;
    const campaignOffer = competitor.pageAnalysis?.offer
      ? {
          headline: competitor.pageAnalysis.offer.headline || null,
          primaryOffer: competitor.pageAnalysis.offer.primaryOffer || null,
          cta: competitor.pageAnalysis.offer.cta || null,
          pricing: competitor.pageAnalysis.offer.pricing || null,
          uniqueValueProps: competitor.pageAnalysis.offer.uniqueValueProps || [],
          guarantees: competitor.pageAnalysis.offer.guarantees || [],
          urgency: competitor.pageAnalysis.offer.urgency || null,
        }
      : null;

    const competitorPrep = (async () => {
      let inventory = page.contentPack?.inventory || null;
      const savedArchitecture = competitor.pageAnalysis?.pageArchitecture?.sections || [];
      const hasOfferArchitecture = competitor.pageAnalysis?.status === "completed" && savedArchitecture.length >= 2;

      // Fast path: reuse completed offer & page architecture instead of Playwright.
      if (hasOfferArchitecture && (!inventory || !hasUsableCompetitorReference(inventory))) {
        page = persist(competitorId, page, stages, "analyzing_competitor", "Reusing completed offer & page architecture…");
        try {
          const fetched = await fetchRawLandingHtml(sourceUrl);
          const outline = extractPageOutline(fetched.html, fetched.title);
          inventory = inventoryFromLandingOutline({
            sourceUrl,
            finalUrl: fetched.finalUrl,
            heroCandidates: outline.heroCandidates,
            headings: outline.headingOutline,
            ctas: outline.ctas,
            architecture: savedArchitecture,
            campaignOffer,
            hasForm: outline.hasForm,
            formFields: outline.formFields,
          });
        } catch {
          inventory = inventoryFromLandingOutline({
            sourceUrl,
            finalUrl: competitor.pageAnalysis?.analyzedUrl || sourceUrl,
            heroCandidates: competitor.pageAnalysis?.offer?.headline
              ? [competitor.pageAnalysis.offer.headline]
              : [],
            architecture: savedArchitecture,
            campaignOffer,
          });
        }
      }

      // Slow path only when offer analysis is missing or unusable.
      if (!hasUsableCompetitorReference(inventory)) {
        try {
          inventory = await captureRenderedInventory(sourceUrl);
        } catch {
          captureRetry = true;
          page = persist(competitorId, page, stages, "analyzing_competitor", "Competitor capture failed once. Retrying…", {
            progress: {
              ...page.progress!,
              details: { ...page.progress?.details, captureRetry: true },
            },
          });
          try {
            inventory = await captureRenderedInventory(sourceUrl);
          } catch {
            inventory = null;
          }
        }
      }

      if (!hasUsableCompetitorReference(inventory) && savedArchitecture.length) {
        inventory = inventoryFromLandingOutline({
          sourceUrl,
          finalUrl: competitor.pageAnalysis?.analyzedUrl || sourceUrl,
          heroCandidates: competitor.pageAnalysis?.offer?.headline
            ? [competitor.pageAnalysis.offer.headline]
            : [],
          architecture: savedArchitecture,
          campaignOffer,
        });
      }

      if (!hasUsableCompetitorReference(inventory)) {
        throw new Error("SOURCE_INCOMPLETE: The competitor page could not be captured, and the saved offer analysis has no usable sections. Refresh offer & page details, then retry.");
      }

      inventory = limitInventoryToSingleForm(enrichInventoryWithCampaignOffer(inventory!, campaignOffer));

      // Always harvest competitor header/footer chrome + form signals from live HTML.
      let competitorChrome: CompetitorChrome | null = null;
      try {
        const fetched = await fetchRawLandingHtml(sourceUrl);
        competitorChrome = extractCompetitorChromeFromHtml(fetched.html);
        if (competitorChrome.hasForm) {
          const hasFormComponent = inventory!.sections.some((s) =>
            s.components.some((c) => c.kind === "form"),
          );
          if (!hasFormComponent && inventory!.sections.length) {
            const target =
              inventory!.sections.find((s) =>
                /form|contact|book|sign|apply|lead|cta/i.test(
                  `${s.sourceHeading || ""} ${s.internalLabel || ""} ${s.purpose || ""}`,
                ),
              ) || inventory!.sections[0];
            target.components.push({
              id: `${target.id}-form`,
              kind: "form",
              text: "Lead capture form matching the competitor page (use exactly once)",
              items: (competitorChrome.formSpec?.fields.map(
                (f) => `${f.label}|${f.type}${f.required ? "|required" : ""}`,
              ) || competitorChrome.formFields).slice(0, 16),
            });
            inventory = limitInventoryToSingleForm(inventory!);
          }
        }
      } catch {
        /* chrome harvest optional — screenshots still guide layout */
      }

      // Skip layout measurement on the offer-analysis fast path — it is another full browser pass.
      let layout = inventory!.layout || null;
      const needsLayout =
        hasUsableRenderedSource(inventory!) &&
        Boolean(inventory!.tiles?.length) &&
        (!layout || layout.incomplete);
      if (needsLayout) {
        try {
          const measured = await Promise.race([
            captureLayoutEvidence(sourceUrl),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error("Layout measurement timed out")), 20000);
            }),
          ]);
          const ids = inventory!.sections.map((section) => section.id);
          layout = alignLayoutEvidence(
            measured,
            ids,
            inventory!.sections.map((section) => ({ id: section.id, heading: section.sourceHeading })),
          );
          inventory = { ...inventory!, layout };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          inventory = {
            ...inventory!,
            gaps: [
              ...(inventory!.gaps || []),
              `Layout measurement skipped (${message}). Section order comes from offer analysis.`,
            ],
          };
          layout = inventory.layout || null;
        }
      } else if (!layout) {
        inventory = {
          ...inventory!,
          gaps: [
            ...(inventory!.gaps || []),
            "Layout measurement skipped on fast path; using offer analysis section order.",
          ],
        };
      }
      return { inventory: inventory!, layout, competitorChrome };
    })();

    const clientPrep = (async () => {
      const cached = job.businessProfile;
      const hasCachedBrand = Boolean(
        cached?.brandColors?.primary &&
          (cached.brandAssets?.logoUrl || (cached.brandAssets?.images || []).length),
      );

      const brand = hasCachedBrand
        ? {
            businessUrl,
            finalUrl: cached!.brandAssets?.finalUrl || businessUrl,
            colors: cached!.brandColors!,
            assets: cached!.brandAssets || null,
            design: cached!.brandDesign || null,
            warnings: ["Reused cached brand bundle from the search profile."],
          }
        : await resolveBrandBundle({
            businessUrl,
            profile: cached || null,
          });

      let assets = brand.assets;
      if (!hasCachedBrand) {
        try {
          const links = await extractBrandLinksWithFirecrawl(businessUrl);
          assets = mergeFirecrawlIntoBrandAssets(assets, links, businessUrl);
        } catch {
          /* optional */
        }
      }

      const evidence = await researchClientSite({
        enteredUrl: businessUrl,
        ownerUserId: job.ownerUserId || "system",
        spaceId: job.spaceId || null,
        focusTerms: [keyword, ...(competitor.pageAnalysis?.offer?.headline ? [competitor.pageAnalysis.offer.headline] : [])],
        knownBusinessName:
          job.businessProfile?.businessName ||
          page.businessName ||
          assets?.siteName ||
          null,
        knownProfile: job.businessProfile
          ? {
              description: job.businessProfile.description,
              offerings: job.businessProfile.offerings,
              positioningSummary: job.businessProfile.positioningSummary,
            }
          : null,
      });
      assertCanDraft(evidence);
      return { brand, assets, evidence };
    })();

    const [{ inventory, layout, competitorChrome }, client] = await Promise.all([
      competitorPrep,
      clientPrep,
    ]);
    const { brand, evidence } = client;
    let { assets } = client;

    stages = markStage(stages, "analyzing_competitor", "done", `${inventory.sections.length} sections identified`);
    page = persist(competitorId, page, stages, "analyzing_competitor", "Competitor page analysed", {
      progress: {
        ...page.progress!,
        details: {
          ...page.progress?.details,
          sectionsIdentified: inventory.sections.length,
          captureRetry,
        },
      },
    });

    const logoResolved = await ensureEmbeddableIdentityLogo(businessUrl, assets);
    assets = logoResolved.assets;
    const identityLogoDataUri = logoResolved.identityLogoDataUri;
    if (logoResolved.warnings.length) {
      page = persist(competitorId, page, stages, "analyzing_client", logoResolved.warnings[logoResolved.warnings.length - 1], {
        progress: {
          ...page.progress!,
          details: {
            ...page.progress?.details,
            logoWarnings: logoResolved.warnings.slice(-4),
          },
        },
      });
    }

    const profile: BusinessProfile = {
      ...(job.businessProfile || {
        url: businessUrl,
        businessName: page.businessName || hostOf(businessUrl),
        industry: "",
        description: "",
        offerings: [],
        competitorKeywords: [],
        positioningSummary: "",
      }),
      url: job.businessProfile?.url || businessUrl,
      businessName: job.businessProfile?.businessName || page.businessName || hostOf(businessUrl),
      brandColors: brand.colors,
      brandAssets: assets,
      brandDesign: brand.design || job.businessProfile?.brandDesign || null,
    };
    updateJob(job.id, { businessProfile: profile });

    const logo = logoStatus(assets);
    if (logo.issue && !logo.url) {
      page = persist(competitorId, page, stages, "analyzing_client", logo.issue, {
        publishBlockers: [logo.issue],
      });
    } else if (logo.issue) {
      page = persist(competitorId, page, stages, "analyzing_client", logo.issue);
    }
    if (!identityLogoDataUri && logo.url) {
      page = persist(competitorId, page, stages, "analyzing_client", "Logo URL found but could not be embedded yet.", {
        publishBlockers: ["Company logo could not be embedded into the page HTML."],
      });
    }
    stages = markStage(stages, "analyzing_client", "done", "Brand assets collected");
    page = persist(competitorId, page, stages, "analyzing_client", "Brand and facts collected", {
      brandColors: brand.colors,
      progress: {
        ...page.progress!,
        details: {
          ...page.progress?.details,
          brandAssetsCollected:
            (assets?.images?.length || 0) + (assets?.navLinks?.length || 0) + (evidence.facts.length || 0),
          logoEmbedded: Boolean(identityLogoDataUri),
        },
      },
    });

    stages = markStage(stages, "preparing_brief", "active");
    page = persist(competitorId, page, stages, "preparing_brief", "Preparing page brief…");

    const identityUrl = (logo.url || assets?.logoUrl || "").trim();
    const proofCandidates = (assets?.images || [])
      .filter((image) => {
        const src = (image.src || "").trim();
        if (!src) return false;
        if (identityUrl && src === identityUrl) return false;
        if (/favicon|apple-touch|sprite|pixel|1x1/i.test(src)) return false;
        // Prefer logo marks; include non-favicon icons that often appear in trust strips.
        if (image.kind === "logo") return true;
        if (image.kind === "icon" && /^https?:\/\//i.test(src) && !/favicon/i.test(src)) {
          return true;
        }
        return false;
      })
      .slice(0, 12);
    const proofLogos: Array<{ src: string; alt: string }> = [];
    const seenProof = new Set<string>();
    for (const image of proofCandidates) {
      const remote = image.src.trim();
      if (seenProof.has(remote)) continue;
      const embedded =
        remote.startsWith("data:") ? remote : await embedRemoteAsset(remote);
      // Keep Firecrawl/HTML https logo links when bytes cannot be inlined.
      const src =
        embedded ||
        (/^https?:\/\//i.test(remote) ? remote : null);
      if (!src) continue;
      seenProof.add(remote);
      proofLogos.push({ src, alt: image.alt || "Partner logo" });
      if (proofLogos.length >= 8) break;
    }

    // Fold + full-page screenshots for accurate section replication (quality over speed).
    page = persist(competitorId, page, stages, "preparing_brief", "Capturing competitor screenshots…");
    const shotResult = await captureCompetitorScreenshotTiles(sourceUrl, { foldOnly: false });
    const tileBase64: Array<{
      id: string;
      data: string;
      mediaType?: "image/jpeg" | "image/png" | "image/webp";
    }> = shotResult.tiles.map((tile) => ({
      id: tile.id,
      data: tile.data,
      mediaType: tile.mediaType,
    }));
    if (!tileBase64.length) {
      for (const tile of (inventory.tiles || []).slice(0, 2)) {
        try {
          const bytes = await readFile(tile.path);
          tileBase64.push({ id: tile.id, data: bytes.toString("base64"), mediaType: "image/jpeg" });
        } catch {
          /* skip missing tile */
        }
      }
    }
    if (shotResult.warnings.length) {
      page = persist(competitorId, page, stages, "preparing_brief", shotResult.warnings[shotResult.warnings.length - 1], {
        progress: {
          ...page.progress!,
          details: {
            ...page.progress?.details,
            screenshotWarnings: shotResult.warnings.slice(-4),
          },
        },
      });
    }
    if (!tileBase64.length && layout?.incomplete && !hasUsableCompetitorReference(inventory)) {
      throw new Error("Essential visual capture is missing. Retry competitor capture before generating.");
    }

    const briefInput = {
      competitorUrl: sourceUrl,
      competitorName: competitor.pageName,
      clientUrl: businessUrl,
      clientName: page.businessName || hostOf(businessUrl),
      keyword,
      inventory,
      layout,
      evidence,
      colors: brand.colors,
      assets,
      design: brand.design || job.businessProfile?.brandDesign || null,
      profile,
      userFeedback: options.userFeedback || null,
      imageBudget: 2,
      tileBase64,
      identityLogoDataUri,
      proofLogos,
      campaignOffer,
      hasCompetitorScreenshots: tileBase64.length > 0,
      competitorChrome,
    };
    const brief = buildUnifiedBrief({ ...briefInput, compact: false });
    const compactBrief = buildUnifiedBrief({
      ...briefInput,
      tileBase64: [],
      compact: true,
      hasCompetitorScreenshots: false,
      imageBudget: 1,
    });
    stages = markStage(stages, "preparing_brief", "done", `Brief ready (${brief.sectionCount} sections)`);
    page = persist(competitorId, page, stages, "preparing_brief", "Page brief ready");

    stages = markStage(stages, "creating_page", "indeterminate", "Creating content and design (sectioned clone)…");
    page = persist(competitorId, { ...page, status: "design_pending" }, stages, "creating_page", "Creating content and design…");

    const generated = await generateUnifiedPage(brief, {
      compactBrief,
      signal: abortSignal,
      onProgress: ({ chars, pass, label }) => {
        if (abortSignal.aborted) return;
        const message =
          label ||
          `Creating content and design… (${pass})${
            chars > 0 ? ` · ${Math.max(1, Math.round(chars / 1000))}k chars` : ""
          }`;
        stages = markStage(stages, "creating_page", "indeterminate", message);
        page = persist(competitorId, page, stages, "creating_page", message);
      },
    });
    let html = generated.response.html;
    salvageHtml = html;
    if (identityLogoDataUri) {
      html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
    }
    if (proofLogos.length) {
      html = injectProofLogos(html, proofLogos);
    }
    stages = markStage(stages, "creating_page", "done", "Content and design draft received");
    page = persist(competitorId, page, stages, "creating_page", "Content and design draft received");

    stages = markStage(stages, "generating_images", "active");
    page = persist(competitorId, page, stages, "generating_images", "Generating images…", {
      progress: {
        ...page.progress!,
        details: {
          ...page.progress?.details,
          imagesPlanned: generated.response.imageSlots.length,
          imagesCompleted: 0,
        },
      },
    });
    const imageResult = await executeImageSlots({
      html,
      slots: generated.response.imageSlots,
      colors: brand.colors,
      competitorId,
      previous: page.generatedImages || [],
      onProgress: (done, total, note) => {
        persist(competitorId, page, stages, "generating_images", note, {
          progress: {
            ...page.progress!,
            details: {
              ...page.progress?.details,
              imagesPlanned: total,
              imagesCompleted: done,
            },
          },
        });
      },
    });
    html = imageResult.html;
    let imageReport = imageResult.report;
    stages = markStage(
      stages,
      "generating_images",
      "done",
      imageReport.placeholders
        ? `${imageReport.completed}/${imageReport.planned} images · placeholders used`
        : `${imageReport.completed}/${imageReport.planned} images`,
    );
    page = persist(competitorId, page, stages, "generating_images", "Image step finished", {
      generatedImages: imageReport.images,
      progress: {
        ...page.progress!,
        details: {
          ...page.progress?.details,
          imagesPlanned: imageReport.planned,
          imagesCompleted: imageReport.completed,
          imagesSkippedCredits: imageReport.skippedCredits,
        },
      },
    });

    stages = markStage(stages, "checking", "active");
    page = persist(competitorId, page, stages, "checking", "Checking and packaging page…");
    // Embed any remaining remote http(s) images so preview/download stay portable.
    const remoteEmbedded = await embedRemoteImagesInHtml(html, { maxImages: 24 });
    html = remoteEmbedded.html;
    if (identityLogoDataUri) {
      html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
    }
    if (proofLogos.length) {
      html = injectProofLogos(html, proofLogos);
    }

    // Verify/repair header + footer chrome (logo, nav, multi-column footer) before packaging.
    // Use campaign-aligned chrome — never the client's full SEO/service sitemap.
    const hasForm =
      Boolean(competitorChrome?.hasForm) ||
      inventory.sections.some((section) =>
        section.components.some((component) => component.kind === "form"),
      );
    const recreateChrome = buildRecreateChromeLinks({
      clientUrl: businessUrl,
      sections: inventory.sections.map((section) => ({
        id: section.id,
        heading: section.sourceHeading || section.internalLabel,
        purpose: section.purpose,
      })),
      campaignOffer,
      keyword,
      assets,
      hasForm,
      competitorChrome,
    });
    const chromeAssets = {
      clientName: page.businessName || hostOf(businessUrl) || "Brand",
      clientUrl: businessUrl,
      logoUrl: identityLogoDataUri || logo.url || assets?.logoUrl || null,
      navLinks: recreateChrome.navLinks,
      footerLinks: recreateChrome.footerLinks,
      footerColumns: recreateChrome.footerColumns,
      ctaLinks: recreateChrome.ctaLinks,
      socialLinks: assets?.socialLinks || [],
      phones: assets?.phones || [],
      emails: assets?.emails || [],
      tagline:
        job.businessProfile?.positioningSummary ||
        job.businessProfile?.description ||
        page.businessName ||
        null,
    };
    let chromeFix = ensurePageChrome(html, chromeAssets, { forceHeader: true, forceFooter: true });
    html = chromeFix.html;
    html = scrubOffTopicChromeHtml(html, recreateChrome.topicHay, [
      ...recreateChrome.navLinks.map((l) => l.label),
      ...recreateChrome.footerLinks.map((l) => l.label),
      ...recreateChrome.ctaLinks.map((l) => l.label),
    ]);
    if (identityLogoDataUri) {
      html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
    }
    if (chromeFix.repaired.length) {
      page = persist(
        competitorId,
        page,
        stages,
        "checking",
        `Repaired ${chromeFix.repaired.join(" + ")} chrome before delivery`,
      );
    }

    let validated = validateAndPackageUnifiedPage({
      html,
      clientHost: hostOf(businessUrl),
      competitorHost: hostOf(sourceUrl),
      logoRequired: Boolean(identityLogoDataUri || logo.url),
      expectedSections: inventory.sections.length,
      colors: brand.colors,
      requireChrome: true,
    });
    // Force-rebuild chrome if validation still flags header/footer/logo issues.
    if (!validated.ok && validated.blockers.some((b) => /header|footer|logo|navigation/i.test(b))) {
      chromeFix = ensurePageChrome(html, chromeAssets, { forceHeader: true, forceFooter: true });
      html = chromeFix.html;
      html = scrubOffTopicChromeHtml(html, recreateChrome.topicHay, [
        ...recreateChrome.navLinks.map((l) => l.label),
        ...recreateChrome.footerLinks.map((l) => l.label),
        ...recreateChrome.ctaLinks.map((l) => l.label),
      ]);
      if (identityLogoDataUri) {
        html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
      }
      validated = validateAndPackageUnifiedPage({
        html,
        clientHost: hostOf(businessUrl),
        competitorHost: hostOf(sourceUrl),
        logoRequired: Boolean(identityLogoDataUri || logo.url),
        expectedSections: inventory.sections.length,
        colors: brand.colors,
        requireChrome: true,
      });
    }
    if (!validated.ok) {
      page = persist(competitorId, page, stages, "checking", "Repairing validation defects…");
      let repaired: Awaited<ReturnType<typeof repairUnifiedPage>> | null = null;
      try {
        repaired = await repairUnifiedPage({
          html,
          defects: validated.blockers,
          briefText: brief.text,
        });
      } catch (err) {
        if (!(err instanceof UnifiedRepairIncompleteError)) throw err;
        page = persist(
          competitorId,
          page,
          stages,
          "checking",
          "Repair was truncated — keeping the assembled page.",
        );
      }
      if (!repaired) {
        // Assembled HTML is already complete. Deterministic chrome/QA still runs below.
      } else {
      html = repaired.response.html;
      if (logo.url || identityLogoDataUri) {
        const embedded =
          identityLogoDataUri ||
          (logo.url?.startsWith("data:") ? logo.url : await embedRemoteAsset(logo.url!));
        if (embedded) html = injectIdentityLogo(html, embedded, page.businessName || "Brand", businessUrl);
      }
      const imageRepair = await executeImageSlots({
        html,
        slots: repaired.response.imageSlots.length ? repaired.response.imageSlots : generated.response.imageSlots,
        colors: brand.colors,
        competitorId,
        previous: imageReport.images,
      });
      html = imageRepair.html;
      imageReport = imageRepair.report.images.length ? imageRepair.report : imageReport;
      html = ensurePageChrome(html, chromeAssets, { forceHeader: true, forceFooter: true }).html;
      html = scrubOffTopicChromeHtml(html, recreateChrome.topicHay, [
        ...recreateChrome.navLinks.map((l) => l.label),
        ...recreateChrome.footerLinks.map((l) => l.label),
        ...recreateChrome.ctaLinks.map((l) => l.label),
      ]);
      if (identityLogoDataUri) {
        html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
      }
      validated = validateAndPackageUnifiedPage({
        html,
        clientHost: hostOf(businessUrl),
        competitorHost: hostOf(sourceUrl),
        logoRequired: Boolean(identityLogoDataUri || logo.url),
        expectedSections: inventory.sections.length,
        colors: brand.colors,
        requireChrome: true,
      });
      if (!validated.ok) {
        salvageHtml = html;
        throw new Error(validated.blockers.slice(0, 4).join(" "));
      }
      }
    }

    // Final QA gate — collapse duplicate forms/CTAs, finish incomplete buttons, check logo.
    page = persist(competitorId, page, stages, "checking", "Verifying page for glitches…");
    const qa = verifyAndRepairUnifiedPage(validated.html, {
      expectForm: hasForm,
      maxBodyCtas: 3,
      maxHeaderCtas: 1,
      clientName: page.businessName || hostOf(businessUrl) || "Brand",
      logoRequired: Boolean(identityLogoDataUri || logo.url),
      formSpec: competitorChrome?.formSpec || null,
      formCtaLabel: recreateChrome.ctaLinks[0]?.label || campaignOffer?.cta || null,
    });
    html = qa.html;
    if (identityLogoDataUri) {
      html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
    }
    if (qa.repairs.length) {
      page = persist(
        competitorId,
        page,
        stages,
        "checking",
        `QA repaired: ${qa.repairs.slice(0, 3).join("; ")}`,
      );
    }
    validated = {
      ...validated,
      html,
      ok: validated.ok && qa.ok,
      blockers: [...validated.blockers, ...qa.blockers],
      warnings: [...validated.warnings, ...qa.warnings],
    };
    if (!validated.ok) {
      // One repair pass focused on QA defects, then re-verify.
      page = persist(competitorId, page, stages, "checking", "Repairing QA defects…");
      let repaired: Awaited<ReturnType<typeof repairUnifiedPage>> | null = null;
      try {
        repaired = await repairUnifiedPage({
          html,
          defects: validated.blockers,
          briefText: brief.text,
        });
      } catch (err) {
        if (!(err instanceof UnifiedRepairIncompleteError)) throw err;
        page = persist(
          competitorId,
          page,
          stages,
          "checking",
          "Repair was truncated — delivering the assembled page.",
        );
      }
      if (!repaired) {
        validated = {
          ...validated,
          ok: /<\/html>/i.test(html),
          warnings: [
            ...validated.warnings,
            ...validated.blockers,
            "Full-page repair was truncated; the assembled page was kept.",
          ],
          blockers: /<\/html>/i.test(html) ? [] : validated.blockers,
          html,
        };
        if (!validated.ok) {
          salvageHtml = html;
          throw new Error(validated.blockers.slice(0, 4).join(" ") || "The page could not be completed.");
        }
      } else {
      html = repaired.response.html;
      if (identityLogoDataUri) {
        html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
      }
      html = ensurePageChrome(html, chromeAssets, { forceHeader: true, forceFooter: true }).html;
      html = scrubOffTopicChromeHtml(html, recreateChrome.topicHay, [
        ...recreateChrome.navLinks.map((l) => l.label),
        ...recreateChrome.footerLinks.map((l) => l.label),
        ...recreateChrome.ctaLinks.map((l) => l.label),
      ]);
      if (identityLogoDataUri) {
        html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
      }
      const qa2 = verifyAndRepairUnifiedPage(html, {
        expectForm: hasForm,
        maxBodyCtas: 3,
        maxHeaderCtas: 1,
        clientName: page.businessName || hostOf(businessUrl) || "Brand",
        logoRequired: Boolean(identityLogoDataUri || logo.url),
        formSpec: competitorChrome?.formSpec || null,
        formCtaLabel: recreateChrome.ctaLinks[0]?.label || campaignOffer?.cta || null,
      });
      html = qa2.html;
      if (identityLogoDataUri) {
        html = injectIdentityLogo(html, identityLogoDataUri, page.businessName || "Brand", businessUrl);
      }
      validated = validateAndPackageUnifiedPage({
        html,
        clientHost: hostOf(businessUrl),
        competitorHost: hostOf(sourceUrl),
        logoRequired: Boolean(identityLogoDataUri || logo.url),
        expectedSections: inventory.sections.length,
        colors: brand.colors,
        requireChrome: true,
      });
      const qa3 = verifyAndRepairUnifiedPage(validated.html, {
        expectForm: hasForm,
        maxBodyCtas: 3,
        maxHeaderCtas: 1,
        clientName: page.businessName || hostOf(businessUrl) || "Brand",
        logoRequired: Boolean(identityLogoDataUri || logo.url),
        formSpec: competitorChrome?.formSpec || null,
        formCtaLabel: recreateChrome.ctaLinks[0]?.label || campaignOffer?.cta || null,
      });
      validated = {
        ...validated,
        html: qa3.html,
        ok: validated.ok && qa3.ok,
        blockers: [...validated.blockers, ...qa3.blockers],
        warnings: [...validated.warnings, ...qa3.warnings, ...qa2.warnings],
      };
      if (!validated.ok) {
        salvageHtml = html;
        throw new Error(validated.blockers.slice(0, 4).join(" "));
      }
      }
    }

    salvageHtml = validated.html || html;
    const placeholders = imageReport.placeholders > 0;
    const publishBlockers = [
      ...generated.response.unresolvedRequirements,
      ...(placeholders ? ["Page ready with image placeholders. Generate missing images when credits allow."] : []),
      ...validated.warnings,
    ];
    stages = markStage(stages, "checking", "done");
    stages = markStage(stages, "ready", "done");
    page = persist(
      competitorId,
      {
        ...page,
        status: "completed",
        html: validated.html,
        generatedImages: imageReport.images,
        brandColors: brand.colors,
        differentiationNotes: [
          `Unified pipeline ${UNIFIED_PIPELINE_VERSION}.`,
          ...generated.response.warnings,
          ...validated.warnings,
        ].join(" "),
        publishReady: !placeholders && publishBlockers.length === 0,
        publishBlockers,
        pipelineVersion: UNIFIED_PIPELINE_VERSION,
        error: null,
        userFeedback: options.userFeedback || page.userFeedback || null,
      },
      stages,
      "ready",
      placeholders ? "Page ready with image placeholders" : "Ready",
    );

    const latest = getCompetitor(competitorId);
    if (!latest) throw new Error("Failed to save recreated page");
    endUnifiedAbort(competitorId, abortSignal);
    return latest;
  } catch (err) {
    endUnifiedAbort(competitorId, abortSignal);
    const aborted = isUnifiedAbortError(err) || abortSignal.aborted;
    const message = aborted
      ? "Recreation stopped"
      : err instanceof Error
        ? err.message
        : String(err);
    stages = markStage(stages, (page.progress?.phase as UnifiedStageId) || "preparing", "blocked", message);
    const keepGenerated =
      !aborted &&
      (/<\/html>/i.test(salvageHtml) || /<body[\s>]/i.test(salvageHtml) || salvageHtml.length > 800);
    const saved = persist(
      competitorId,
      {
        ...page,
        status: keepGenerated || page.html ? "completed" : "failed",
        html: keepGenerated ? salvageHtml : page.html,
        error: keepGenerated ? null : message,
        publishReady: false,
        publishBlockers: keepGenerated
          ? [message, ...(page.publishBlockers || [])].slice(0, 6)
          : page.publishBlockers,
      },
      stages,
      keepGenerated ? "ready" : "failed",
      keepGenerated ? "Page kept after a validation issue" : message,
    );
    if (aborted || keepGenerated) {
      const latest = getCompetitor(competitorId);
      if (!latest) throw new Error(keepGenerated ? "Failed to save the generated page" : "Failed to stop recreation");
      return latest;
    }
    void saved;
    throw err;
  }
}

export async function generateMissingUnifiedImages(competitorId: string): Promise<CompetitorRecord> {
  const competitor = getCompetitor(competitorId);
  if (!competitor?.recreatedPage?.html) throw new Error("No page is available to fill images for.");
  const page = competitor.recreatedPage;
  const pending = (page.generatedImages || []).filter((image) => image.slotState === "failed" && image.prompt);
  if (!pending.length) return competitor;
  const slots = pending.map((image, index) => ({
    id: image.id,
    sectionId: image.id,
    purpose: image.label,
    prompt: image.prompt,
    aspectRatio: image.ratio,
    width: image.width,
    height: image.height,
    alt: image.label,
    kind: "illustrative" as const,
    priority: index + 1,
  }));
  const result = await executeImageSlots({
    html: page.html || "",
    slots,
    colors: page.brandColors,
    competitorId,
    previous: [],
  });
  const merged = (page.generatedImages || []).map((image) => {
    const next = result.report.images.find((item) => item.id === image.id);
    return next || image;
  });
  const placeholders = result.report.placeholders > 0;
  updateCompetitor(competitorId, {
    recreatedPage: {
      ...page,
      html: result.html,
      generatedImages: merged,
      publishReady: !placeholders,
      publishBlockers: placeholders
        ? ["Page ready with image placeholders. Generate missing images when credits allow."]
        : [],
      updatedAt: new Date().toISOString(),
      progress: {
        phase: "ready",
        message: placeholders ? "Page ready with image placeholders" : "Ready",
        pct: 100,
        stages: page.progress?.stages || initialStages(),
        details: {
          ...page.progress?.details,
          imagesCompleted: result.report.completed,
          imagesPlanned: result.report.planned,
          imagesSkippedCredits: result.report.skippedCredits,
        },
      },
    },
  });
  const latest = getCompetitor(competitorId);
  if (!latest) throw new Error("Failed to save images");
  return latest;
}
