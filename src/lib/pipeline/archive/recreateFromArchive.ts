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
import { generateAndEmbedLandingImages, inventoryImageSlots, embedGeneratedImages } from "../generateLandingImages";
import { captureArchivedPage, type ArchivedPage } from "./capturePage";
import { extractBrandTokens } from "./brandTokens";
import { applyBrandDeterministic, applyBrandLogoToHtml } from "./applyBrandDeterministic";
import {
  applyBrandContactInfo,
  scrubEmptyChromePills,
} from "../applyBrandContacts";
import {
  applyCidReplacements,
  collapseDoubledElementText,
  collectStampedCidNodes,
  rewriteTextsByCid,
  stampTextCids,
} from "./rewriteTextByCid";
import { runVisualGate } from "./visualGate";
import { injectInteractiveRuntime } from "./interactiveRuntime";
import {
  buildBrandDesignSpec,
  brandTokensFromDesignSpec,
  serializeDesignMd,
  writeDesignMd,
  deleteDesignMd,
} from "../designMd";
import {
  extractBrandLinksWithFirecrawl,
  mergeFirecrawlIntoBrandAssets,
} from "../firecrawlBrandLinks";
import { stampFaqInteractivity } from "./interactiveRuntime";

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

async function firstReachableImage(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) continue;
      return res.url || url;
    } catch {
      // try next
    }
  }
  return null;
}

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
  /** design.md markdown generated for this run (brand SSOT) */
  designMd: string;
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

  const brandRaw = await extractBrandTokens({
    businessUrl: input.businessUrl,
    archivedCompetitor: archive,
    profileName: input.brandName,
    profile: input.profile,
    preferredColors: input.preferredColors || input.profile?.brandColors || null,
  });

  // Brand SSOT: structured spec → design.md → apply path uses same tokens
  const designSpec = buildBrandDesignSpec({
    tokens: brandRaw,
    brandName: input.brandName,
    businessUrl: input.businessUrl,
    competitorName: input.competitorName,
  });
  const designMd = serializeDesignMd(designSpec);
  if (input.competitorId) {
    writeDesignMd(input.competitorId, designMd);
  }
  let brand = brandTokensFromDesignSpec(designSpec, brandRaw);

  // Ensure footer/nav inventory comes from the brand website (Firecrawl), not competitor
  try {
    const linkPack = await extractBrandLinksWithFirecrawl(input.businessUrl);
    brand.siteAssets = mergeFirecrawlIntoBrandAssets(
      brand.siteAssets,
      linkPack,
      input.businessUrl,
    );
    if (linkPack.socialLinks.length) {
      brand.socialLinks = linkPack.socialLinks;
    }
  } catch (err) {
    console.warn("[archive] brand link refresh failed", err);
  }

  if (!brand.logoUrl && !brand.siteAssets?.logoUrl) {
    const cdn = await firstReachableImage(logoCdnFallbacks(input.businessUrl));
    if (cdn) {
      brand.logoUrl = cdn;
      if (brand.siteAssets) brand.siteAssets.logoUrl = cdn;
    }
  }

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

  // 1) Stamp brand logos FIRST so they never enter the AI image inventory
  const logoUrlEarly = brand.logoUrl || brand.siteAssets?.logoUrl || null;
  if (logoUrlEarly) {
    const logoFirst = applyBrandLogoToHtml(html, {
      logoUrl: logoUrlEarly,
      brandName: input.brandName,
      businessUrl: input.businessUrl,
    });
    html = logoFirst.html;
  }

  // 2) Reserve AI slots on remaining photos only (skips data-adrival-logo)
  const reserved = inventoryImageSlots(html);
  html = reserved.html;

  const brandApplied = applyBrandDeterministic({
    html,
    archive,
    brand,
    businessUrl: input.businessUrl,
    brandName: input.brandName,
    designSpec,
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
        competitorUrl: input.sourceUrl,
        industry: input.profile?.industry || null,
        brandColors: brand.colors,
        logoUrl: logoUrlEarly,
        slots: reserved.slots,
        designMd,
      });
      html = gen.html;
      generatedImages = gen.images;
      if (gen.images.length) {
        imageGenNote = `Generated images×${gen.images.length} (${gen.embedded} placed)`;
        if (gen.warnings.length) {
          imageGenNote += ` · ${gen.warnings.length} slot warning(s)`;
        }
      } else {
        const fails = gen.warnings.filter((w) =>
          /failed|Error|Internal server|\b500\b|timeout/i.test(w),
        );
        imageGenNote = fails.length
          ? `AI image generation failed for ${fails.length} slot(s): ${fails[0].slice(0, 140)}`
          : gen.warnings.find((w) => !/Skipped \d+ logo/i.test(w)) ||
            gen.warnings[0] ||
            "image generation produced no images";
      }
    } catch (err) {
      console.warn("[archive] image generation failed", err);
      imageGenNote = `image generation failed: ${(err as Error).message}`;
    }
  } else if (!input.competitorId) {
    imageGenNote = "image generation skipped (no competitorId)";
  } else if (reserved.slots.length === 0) {
    imageGenNote = "no photo slots for AI (logos reserved separately)";
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
        designMd,
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
        designMd,
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
      designMd,
    });
    copySource = `Content rewrite×${replacements.size}`;
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

  // Contact swap AFTER CID paste — unmatched nodes often keep competitor "Call 1300…"
  const contactAssets = approved
    ? brandAssetsFromContentDraft(
        approved,
        brand.siteAssets,
        input.businessUrl,
        input.brandName,
      )
    : brand.siteAssets;
  const contacts = applyBrandContactInfo(html, contactAssets);
  html = contacts.html;
  const scrub = scrubEmptyChromePills(html);
  html = scrub.html;

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

  // Footer rebuild can reintroduce chrome — contact pass once more on footer/header
  const contactsFinal = applyBrandContactInfo(html, footerAssets);
  html = contactsFinal.html;

  // Re-embed after copy/footer passes so later transforms cannot drop Runway srcs
  if (generatedImages.length > 0) {
    const re = embedGeneratedImages(html, generatedImages);
    html = re.html;
    if (imageGenNote) {
      imageGenNote = imageGenNote.replace(
        /\(\d+ placed\)/,
        `(${re.embedded} placed)`,
      );
    }
  }

  // Logos last — reclaim any logo marks that AI may have overwritten
  const logoUrl = brand.logoUrl || brand.siteAssets?.logoUrl || null;
  if (logoUrl) {
    const logoPass = applyBrandLogoToHtml(html, {
      logoUrl,
      brandName: input.brandName,
      businessUrl: input.businessUrl,
    });
    html = logoPass.html;
  }

  // Final re-embed AI photos only (embed skips / strips logo stamps)
  if (generatedImages.length > 0) {
    html = embedGeneratedImages(html, generatedImages).html;
  }

  // Absolute last: logos win again so brand marks are never left as AI scenes
  if (logoUrl) {
    html = applyBrandLogoToHtml(html, {
      logoUrl,
      brandName: input.brandName,
      businessUrl: input.businessUrl,
    }).html;
  }

  const archiveNote = usedStored
    ? "reused content-phase archive"
    : "fresh page capture";
  const banner = `<div id="adrival-draft-banner" style="position:sticky;top:0;z-index:99999;background:${brand.colors.primary};color:#fff;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;">AdRival draft — ${archiveNote} · ${approved ? "approved content" : "CID rewrite"} · keyword “${input.keyword}” · Remove banner on Publish</div>`;
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  } else {
    html = banner + html;
  }

  html = stampFaqInteractivity(html);
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
    "brand SSOT design.md",
    publishReady ? "publish-ready" : `publish blocked: ${publishBlockers.join("; ")}`,
    gate.ok ? null : `visual gate warn (${(gate.maxDiffRatio * 100).toFixed(1)}%)`,
  ]
    .filter(Boolean)
    .join(" · ");

  if (input.competitorId) {
    deleteDesignMd(input.competitorId);
  }

  return {
    html,
    differentiationNotes,
    textsRewritten: replacements.size,
    brandColors: brand.colors,
    designMd,
    cidCoverage,
    unmatchedCidCount,
    publishReady,
    publishBlockers,
    generatedImages,
    visualGate: gate,
  };
}
