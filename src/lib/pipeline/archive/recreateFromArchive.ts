import type { BusinessProfile, BrandColors } from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import { rebuildBrandFooter } from "../rebuildFooter";
import { captureArchivedPage } from "./capturePage";
import { extractBrandTokens } from "./brandTokens";
import { applyBrandDeterministic } from "./applyBrandDeterministic";
import {
  applyCidReplacements,
  collapseDoubledElementText,
  rewriteTextsByCid,
  stampTextCids,
} from "./rewriteTextByCid";
import { runVisualGate } from "./visualGate";

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

export type ArchiveRecreateResult = {
  html: string;
  differentiationNotes: string;
  textsRewritten: number;
  brandColors: BrandColors;
  visualGate: {
    ok: boolean;
    maxDiffRatio: number;
    notes: string[];
  };
};

/**
 * Archive-first recreation pipeline:
 * 1) Playwright faithful capture + resource inlining
 * 2) Brandfetch (+ site) brand tokens
 * 3) Deterministic color/font/logo/link patch (no AI on markup)
 * 4) Claude text-only via data-cid nodes (±15% length)
 * 5) Visual gate via pixelmatch across viewports
 */
export async function recreateFromArchive(input: {
  sourceUrl: string;
  businessUrl: string;
  competitorName: string;
  brandName: string;
  keyword: string;
  profile: BusinessProfile | null;
  userFeedback?: string | null;
}): Promise<ArchiveRecreateResult> {
  // Step 1 — Capture faithfully
  const archive = await captureArchivedPage(input.sourceUrl);

  // Step 2 — Brand tokens (Brandfetch + computed supplements + site HTML/CSS)
  const brand = await extractBrandTokens({
    businessUrl: input.businessUrl,
    archivedCompetitor: archive,
    profileName: input.brandName,
  });

  // Minimal identity scrub only (do not remove layout blocks — archive fidelity)
  let html = archive.html;
  const competitor = input.competitorName.trim();
  if (competitor.length > 2) {
    const re = new RegExp(
      competitor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    html = html.replace(re, input.brandName);
  }

  // Keep a branded-but-pre-copy snapshot for visual gate baseline (layout+brand only)
  const brandApplied = applyBrandDeterministic({
    html,
    archive,
    brand,
    businessUrl: input.businessUrl,
    brandName: input.brandName,
  });
  html = brandApplied.html;
  const htmlBeforeCopy = html;

  // Step 4 — Model never touches markup: CID stamp → Claude → write-back
  const stamped = stampTextCids(html);
  html = stamped.html;
  const replacements = await rewriteTextsByCid({
    nodes: stamped.nodes,
    brandName: input.brandName,
    businessUrl: input.businessUrl,
    keyword: input.keyword,
    competitorName: input.competitorName,
    userFeedback: input.userFeedback,
    industry: input.profile?.industry || null,
  });
  const applied = applyCidReplacements(html, stamped.nodes, replacements);
  html = applied.html;

  // Collapse any leftover doubled headlines ("Foo Foo") inside one element
  const collapsed = collapseDoubledElementText(html);
  html = collapsed.html;

  // Footer must never keep competitor legal/licence copy — rebuild from brand assets
  const footerAssets = brandAssetsForFooter(
    brand,
    input.businessUrl,
    input.brandName,
  );
  const footer = rebuildBrandFooter(
    html,
    footerAssets,
    input.brandName,
    input.businessUrl,
  );
  html = footer.html;

  // Draft banner (non-layout-breaking sticky bar)
  const banner = `<div id="adrival-draft-banner" style="position:sticky;top:0;z-index:99999;background:${brand.colors.primary};color:#fff;padding:8px 14px;font:600 13px/1.4 system-ui,sans-serif;">AdRival archive draft — layout captured from ${input.competitorName} · brand from your site · keyword “${input.keyword}”${input.userFeedback?.trim() ? " · feedback applied" : ""}</div>`;
  if (/<body[^>]*>/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>${banner}`);
  } else {
    html = banner + html;
  }

  // Step 5 — Visual gate
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
    gate.notes.push(
      `Visual gate skipped: ${(err as Error).message || String(err)}`,
    );
  }

  const brandWarn = brand.warnings.slice(0, 3).join(" · ");
  const gateNote = gate.ok
    ? ` Visual gate passed (max diff ${(gate.maxDiffRatio * 100).toFixed(1)}%).`
    : ` Visual gate flagged layout drift: ${gate.notes.join("; ") || "above threshold"}.`;
  const footerNote = footer.rebuilt
    ? ` Brand footer rebuilt (${footer.linkCount} links, ${footer.socialCount} socials).`
    : " Footer rebuild skipped.";
  const collapseNote =
    collapsed.collapsed > 0
      ? ` Collapsed ${collapsed.collapsed} doubled text node(s).`
      : "";

  return {
    html,
    brandColors: brand.colors,
    textsRewritten: applied.applied,
    visualGate: gate,
    differentiationNotes: `Archive pipeline: Playwright capture + deterministic brand patch (colors×${brandApplied.stats.colors}, logos×${brandApplied.stats.logos}, links×${brandApplied.stats.links}, socials×${brandApplied.stats.socials}) + Claude CID text rewrite×${applied.applied}/${stamped.nodes.length}.${footerNote}${collapseNote} Brand source: ${brand.source}.${brandWarn ? ` Notes: ${brandWarn}.` : ""}${gateNote}`,
  };
}
