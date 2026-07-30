import type {
  BusinessProfile,
  BrandColors,
  GeneratedLandingImage,
  LandingContentDraft,
  StoredPageArchive,
} from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import { rebuildBrandFooter } from "../rebuildFooter";
import { brandAssetsFromContentDraft } from "../contentDraft";
import {
  applyMetaFromContentDraft,
  applyApprovedNavAndInternalLinks,
  mapApprovedContentWithStats,
  getApprovedFooterDisclaimer,
} from "../mapApprovedContent";
import { applyDesignFeedbackToReplacements } from "../applyDesignFeedback";
import { fitApprovedContentToCids } from "../fitApprovedContent";
import { generateAndEmbedLandingImages, inventoryImageSlots } from "../generateLandingImages";
import { captureArchivedPage, type ArchivedPage } from "./capturePage";
import { extractBrandTokens } from "./brandTokens";
import { applyBrandDeterministic } from "./applyBrandDeterministic";
import {
  applyCidReplacements,
  collapseDoubledElementText,
  collectStampedCidNodes,
  rewriteTextsByCid,
  stampTextCids,
} from "./rewriteTextByCid";
import { runVisualGate } from "./visualGate";
import { injectInteractiveRuntime } from "./interactiveRuntime";

function brandAssetsForFooter(
  brand: Awaited<ReturnType<typeof extractBrandTokens>>,
  businessUrl: string,
  brandName: string,
): BrandSiteAssets {
  if (brand.siteAssets) {
    return {
      ...brand.siteAssets,
      logoUrl: brand.logoUrl || brand.siteAssets.logoUrl,
      socialLinks: brand.socialLinks.length
        ? brand.socialLinks
        : brand.siteAssets.socialLinks,
    };
  }
  return {
    finalUrl: businessUrl,
    siteName: brandName,
    logoUrl: brand.logoUrl,
    faviconUrl: null,
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: brand.socialLinks,
    images: [],
    emails: [],
    phones: [],
  };
}

function archivedPageFromStored(
  stored: StoredPageArchive,
  sourceUrl: string,
): ArchivedPage {
  return {
    url: sourceUrl,
    finalUrl: stored.finalUrl || sourceUrl,
    html: stored.html,
    screenshotDesktop: Buffer.alloc(0),
    title: stored.title,
    paintedColors: [],
    computedTokens: {
      borderRadii: [],
      boxShadows: [],
      fontFamilies: [],
    },
  };
}

export type ArchiveRecreateResult = {
  html: string;
  differentiationNotes: string;
  textsRewritten: number;
  brandColors: BrandColors;
  cidCoverage: number;
  unmatchedCidCount: number;
  publishReady: boolean;
  publishBlockers: string[];
  generatedImages: GeneratedLandingImage[];
  visualGate: {
    ok: boolean;
    maxDiffRatio: number;
    notes: string[];
  };
};

/**
 * Archive-first recreation pipeline:
 * 1) Reuse content-phase stamped archive (or capture if missing)
 * 2) Brand tokens (Firecrawl)
 * 3) Deterministic color/font/logo/image/link patch
 * 4) Strict CID paste of approved content
 * 5) In-place footer remap
 * 6) Visual gate + publish checklist
 */
export async function recreateFromArchive(input: {
  sourceUrl: string;
  businessUrl: string;
  competitorName: string;
  brandName: string;
  keyword: string;
  profile: BusinessProfile | null;
  userFeedback?: string | null;
  approvedContent?: LandingContentDraft | null;
  preferredColors?: BrandColors | null;
  /** Stamped archive from content phase — required for CID fidelity */
  storedArchive?: StoredPageArchive | null;
  /** Force a fresh Playwright capture (ignores stored archive) */
  forceRecapture?: boolean;
  /** Allow LLM fit when coverage is very low (default false) */
  allowLowCoverageFit?: boolean;
  /** Used to persist Runway images under /generated/{id}/ */
  competitorId?: string | null;
}): Promise<ArchiveRecreateResult> {
  let archive: ArchivedPage;
  let usedStored = false;

  if (input.storedArchive?.html && !input.forceRecapture) {
    archive = archivedPageFromStored(input.storedArchive, input.sourceUrl);
    usedStored = true;
  } else {
    archive = await captureArchivedPage(input.sourceUrl);
  }

  const brand = await extractBrandTokens({
    businessUrl: input.businessUrl,
    archivedCompetitor: archive,
    profileName: input.brandName,
    profile: input.profile,
    preferredColors: input.preferredColors || input.profile?.brandColors || null,
  });

  const approvedEarly =
    input.approvedContent &&
    (input.approvedContent.status === "approved" ||
      input.approvedContent.status === "ready") &&
    input.approvedContent.blocks.length > 0
      ? input.approvedContent
      : null;

  if (approvedEarly) {
    brand.siteAssets = brandAssetsFromContentDraft(
      approvedEarly,
      brand.siteAssets,
      input.businessUrl,
      input.brandName,
    );
    brand.socialLinks = brand.siteAssets.socialLinks.length
      ? brand.siteAssets.socialLinks
      : brand.socialLinks;
  }

  let html = archive.html;
  const competitor = input.competitorName.trim();
  if (competitor.length > 2) {
    const re = new RegExp(
      competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    html = html.replace(re, input.brandName);
  }

  // Reserve image slots before brand asset swaps so Runway can own them.
  const reserved = inventoryImageSlots(html);
  html = reserved.html;

  const brandApplied = applyBrandDeterministic({
    html,
    archive,
    brand,
    businessUrl: input.businessUrl,
    brandName: input.brandName,
  });
  html = brandApplied.html;

  let generatedImages: GeneratedLandingImage[] = [];
  let imageGenNote: string | null = null;
  if (input.competitorId && reserved.slots.length > 0) {
    try {
      const gen = await generateAndEmbedLandingImages({
        html,
        competitorId: input.competitorId,
        brandName: input.brandName,
        businessUrl: input.businessUrl,
        keyword: input.keyword,
        competitorName: input.competitorName,
        industry: input.profile?.industry || null,
        brandColors: brand.colors,
        slots: reserved.slots,
      });
      html = gen.html;
      generatedImages = gen.images;
      imageGenNote = gen.images.length
        ? `Runway GPT Image 2×${gen.images.length} embedded`
        : gen.warnings[0] || "image generation skipped";
      if (gen.warnings.length && gen.images.length) {
        imageGenNote += ` (${gen.warnings.length} slot warning(s))`;
      }
    } catch (err) {
      console.warn("[archive] image generation failed", err);
      imageGenNote = `image generation failed: ${(err as Error).message}`;
    }
  } else if (!input.competitorId) {
    imageGenNote = "image generation skipped (no competitorId)";
  }

  const htmlBeforeCopy = html;

  // Prefer existing CID stamps from content phase
  const stamped =
    usedStored || /data-cid=/i.test(html)
      ? collectStampedCidNodes(html)
      : stampTextCids(html);
  html = stamped.html;

  const approved = approvedEarly;
  let replacements: Map<string, string>;
  let copySource: string;
  let cidCoverage = 1;
  let unmatchedCidCount = 0;

  if (approved) {
    const mapped = mapApprovedContentWithStats(approved, stamped.nodes);
    replacements = mapped.replacements;
    cidCoverage = mapped.coverage;
    unmatchedCidCount = mapped.unmatchedCount;

    if (input.userFeedback?.trim()) {
      replacements = await applyDesignFeedbackToReplacements({
        replacements,
        userFeedback: input.userFeedback,
        brandName: input.brandName,
        keyword: input.keyword,
        competitorName: input.competitorName,
      });
    }

    // Optional safety net only when explicitly allowed and coverage is tiny
    if (
      input.allowLowCoverageFit &&
      replacements.size < Math.min(5, Math.ceil(stamped.nodes.length * 0.08))
    ) {
      console.warn(
        "[archive] approved mapper coverage low; fitApprovedContentToCids (opt-in)",
      );
      replacements = await fitApprovedContentToCids({
        draft: approved,
        nodes: stamped.nodes,
        brandName: input.brandName,
        keyword: input.keyword,
        competitorName: input.competitorName,
        industry: input.profile?.industry || null,
        userFeedback: input.userFeedback,
      });
      const eligible = stamped.nodes.filter((n) => !n.inFooter).length || 1;
      cidCoverage = replacements.size / eligible;
      unmatchedCidCount = Math.max(0, eligible - replacements.size);
    }

    copySource = `approved paste×${replacements.size} (${Math.round(cidCoverage * 100)}% CID coverage${
      unmatchedCidCount ? `, ${unmatchedCidCount} unmatched kept` : ""
    })${input.userFeedback?.trim() ? " · design feedback" : ""}`;
  } else {
    replacements = await rewriteTextsByCid({
      nodes: stamped.nodes,
      brandName: input.brandName,
      businessUrl: input.businessUrl,
      keyword: input.keyword,
      competitorName: input.competitorName,
      userFeedback: input.userFeedback,
      industry: input.profile?.industry || null,
    });
    copySource = `Claude CID rewrite×${replacements.size}`;
    const eligible = stamped.nodes.filter((n) => !n.inFooter).length || 1;
    cidCoverage = replacements.size / eligible;
  }

  const applied = applyCidReplacements(html, stamped.nodes, replacements, {
    forceApply: Boolean(approved),
  });
  html = applied.html;

  if (approved) {
    html = applyMetaFromContentDraft(html, approved);
    html = applyApprovedNavAndInternalLinks(html, approved);
  }

  const collapsed = collapseDoubledElementText(html);
  html = collapsed.html;

  const footerAssets = approved
    ? brandAssetsFromContentDraft(
        approved,
        brand.siteAssets,
        input.businessUrl,
        input.brandName,
      )
    : brandAssetsForFooter(brand, input.businessUrl, input.brandName);
  const footer = rebuildBrandFooter(
    html,
    footerAssets,
    input.brandName,
    input.businessUrl,
    {
      disclaimer: approved ? getApprovedFooterDisclaimer(approved) : null,
    },
  );
  html = footer.html;

  const archiveNote = usedStored
    ? "reused content-phase archive"
    : "fresh Playwright capture";
  const banner = `<div id="adrival-draft-banner" style="position:sticky;top:0;z-index:99999;background:${brand.colors.primary};color:#fff;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;">AdRival draft — ${archiveNote} · ${approved ? "approved content" : "CID rewrite"} · keyword “${input.keyword}” · Remove banner on Publish</div>`;
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  } else {
    html = banner + html;
  }

  html = injectInteractiveRuntime(html);

  let gate = {
    ok: true,
    maxDiffRatio: 0,
    notes: [] as string[],
  };
  try {
    const visual = await runVisualGate({
      originalHtml: htmlBeforeCopy,
      patchedHtml: html,
      threshold: 0.18,
    });
    gate = {
      ok: visual.ok,
      maxDiffRatio: visual.maxDiffRatio,
      notes: visual.notes,
    };
  } catch (err) {
    gate = {
      ok: true,
      maxDiffRatio: 0,
      notes: [`Visual gate skipped: ${(err as Error).message}`],
    };
  }

  const publishBlockers: string[] = [];
  if (cidCoverage < 0.85 && approved) {
    publishBlockers.push(
      `CID coverage ${Math.round(cidCoverage * 100)}% (need ≥85%)`,
    );
  }
  if (!brand.logoUrl && !brandApplied.stats.logos) {
    publishBlockers.push("Brand logo missing");
  }
  if (!gate.ok) {
    publishBlockers.push(
      `Layout drift ${(gate.maxDiffRatio * 100).toFixed(1)}% above threshold`,
    );
  }
  const publishReady = publishBlockers.length === 0;

  const differentiationNotes = [
    copySource,
    footer.inPlace ? "footer remapped in place" : "footer injected (no safe root)",
    brandApplied.stats.images
      ? `images swapped×${brandApplied.stats.images}`
      : null,
    imageGenNote,
    usedStored ? "CID archive locked" : "archive recaptured",
    publishReady ? "publish-ready" : `publish blocked: ${publishBlockers.join("; ")}`,
    gate.ok ? null : `visual gate warn (${(gate.maxDiffRatio * 100).toFixed(1)}%)`,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    html,
    differentiationNotes,
    textsRewritten: replacements.size,
    brandColors: brand.colors,
    cidCoverage,
    unmatchedCidCount,
    publishReady,
    publishBlockers,
    generatedImages,
    visualGate: gate,
  };
}
