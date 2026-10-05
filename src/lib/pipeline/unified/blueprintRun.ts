import * as cheerio from "cheerio";
import type { BrandColors, BrandDesignSystem, BusinessProfile, GeneratedLandingImage } from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import type { ClientEvidenceRecord } from "../content/model";
import { embedRemoteImagesInHtml } from "../design/packageHtml";
import { primaryBlueprintForm, type CompetitorBlueprint, type SectionKind } from "./blueprint";
import { placeholderDataUri, retonePlaceholders, type UnifiedImageReport } from "./contract";
import { buildDesignSystem } from "./designSystem";
import { fidelityReport, measureRenderedPage, replaceSection, type FidelityReport } from "./fidelity";
import {
  generateBlueprintPage,
  holdForm,
  polishBlueprintSection,
  regenerateBlueprintSection,
  rewordBlueprintSection,
  swapCtaLabels,
  type BlueprintGenerationInput,
} from "./generateBlueprint";
import type { UnifiedProgressInfo } from "./generatePage";
import { executeImageSlots, placeholderRecords, unplannedPlaceholderSlots } from "./images";
import { LEAD_FORM_ID } from "./leadForm";
import { buildRecreateChromeLinks, scrubOffTopicChromeHtml, type CompetitorFormSpec } from "./recreateChrome";
import { ensurePageChrome, injectIdentityLogo, injectProofLogos, validateAndPackageUnifiedPage } from "./validate";
import { applyDesignFixes, findingsForPrompt, repairableCount, runDesignCheck, type DesignCheck } from "../skills/designAudit";
import { designSystemToDesignMd } from "../skills/designMd";
import { industryBrief, type IndustryGuide } from "../skills/industry";
import { imageContextFromProfile } from "./imagePrompt";
import { styleGuide, type StyleDirection } from "../skills/playbook";
import { reviewAndFixPage, type VisualReviewSummary } from "./visualReview";
import { restoreSlotImages } from "./integrity";

const NAV_LABEL: Partial<Record<SectionKind, string>> = {
  features: "Services",
  steps: "How it works",
  testimonials: "Results",
  stats: "Results",
  pricing: "Pricing",
  faq: "FAQ",
  form: "Contact",
};

const MAX_REPAIRS = 4;
/** Sections polished after the design check (one Claude call each). */
const MAX_DESIGN_POLISH = 3;

/** The competitor's CTA wording, wherever it appears (header, campaign, form, buttons). */
function competitorCtaLabels(
  blueprint: CompetitorBlueprint,
  campaignOffer: Record<string, unknown> | null,
  form: { submitLabel?: string | null } | null,
): string[] {
  return [
    blueprint.header?.cta,
    typeof campaignOffer?.cta === "string" ? (campaignOffer.cta as string) : null,
    form?.submitLabel,
    ...blueprint.sections.flatMap((s) => s.blocks.filter((b) => b.role === "button").map((b) => b.text)),
  ]
    .map((t) => (t || "").replace(/\s+/g, " ").trim())
    .filter((t) => t.split(" ").length >= 3 && t.length <= 60);
}

/**
 * Menu and footer for a landing page: the competitor's number of menu items,
 * pointing at this page's own sections (Services, How it works, FAQ…), then
 * the client's real site links. Competitor menu labels are never reused.
 */
export function blueprintDestinations(input: {
  blueprint: CompetitorBlueprint;
  clientUrl: string;
  assets: BrandSiteAssets | null;
  campaignOffer: { headline?: string | null; primaryOffer?: string | null; cta?: string | null } | null;
  keyword: string;
  hasForm: boolean;
}): BlueprintGenerationInput["destinations"] & { topicHay: string } {
  const client = buildRecreateChromeLinks({
    clientUrl: input.clientUrl,
    sections: [],
    campaignOffer: input.campaignOffer,
    keyword: input.keyword,
    assets: input.assets,
    hasForm: input.hasForm,
    competitorChrome: null,
  });
  const wanted = Math.min(5, input.blueprint.header?.nav.length || 0);
  const anchors: Array<{ label: string; href: string }> = [];
  for (const section of input.blueprint.sections) {
    const label = NAV_LABEL[section.kind];
    if (!label || anchors.some((a) => a.label === label)) continue;
    anchors.push({ label, href: section.kind === "form" ? `#${LEAD_FORM_ID}` : `#${section.id}` });
  }
  const clientNav = client.navLinks.filter((l) => !/^(home|contact)$/i.test(l.label));
  const nav = wanted ? [...anchors, ...clientNav].slice(0, wanted) : [];
  const phones = (input.assets?.phones || []).slice(0, 2);
  const emails = (input.assets?.emails || []).slice(0, 2);
  const contact = [
    ...(input.hasForm ? [{ label: "Get in touch", href: `#${LEAD_FORM_ID}` }] : []),
    ...phones.map((p) => ({ label: p, href: `tel:${p.replace(/\s+/g, "")}` })),
    ...emails.map((e) => ({ label: e, href: `mailto:${e}` })),
  ];
  const company = client.footerLinks.filter((l) => !/^tel:|^mailto:|#adr-lead-form/i.test(l.href)).slice(0, 6);
  const columns = [
    ...(anchors.length >= 2 ? [{ heading: "On this page", links: anchors.slice(0, 6) }] : []),
    ...(company.length >= 2 ? [{ heading: "Company", links: company }] : []),
    ...(contact.length ? [{ heading: "Contact", links: contact }] : []),
  ].slice(0, Math.max(1, input.blueprint.footer?.columns || 3));
  return {
    nav,
    footer: client.footerLinks,
    footerColumns: columns,
    cta: client.ctaLinks,
    social: (input.assets?.socialLinks || []).slice(0, 5),
    phones,
    emails,
    topicHay: client.topicHay,
  };
}

/** Light checks for blueprint pages; buttons are styled by class, so no inline restyling. */
function verifyBlueprintPage(html: string, options: { hasForm: boolean; clientUrl: string }): { html: string; repairs: string[] } {
  const $ = cheerio.load(html);
  const repairs: string[] = [];
  const forms = $("form").toArray();
  const lead = forms.find((f) => $(f).attr("id") === LEAD_FORM_ID);
  for (const f of forms) {
    if (f === lead) continue;
    $(f).remove();
    repairs.push("Removed an extra form.");
  }
  $("section[data-section-id]").each((_, el) => {
    const id = $(el).attr("data-section-id");
    if (id && !$(el).attr("id")) $(el).attr("id", id);
  });
  $("a").each((_, el) => {
    const $el = $(el);
    const href = ($el.attr("href") || "").trim();
    if (!href || href === "#") {
      $el.attr("href", options.hasForm ? `#${LEAD_FORM_ID}` : options.clientUrl);
      repairs.push("Gave a link without a destination somewhere to go.");
    }
  });
  $("a.adr-btn, button.adr-btn").each((_, el) => {
    if (!($(el).text() || "").trim()) {
      $(el).remove();
      repairs.push("Removed an empty button.");
    }
  });
  // Image slots the model added without a planned prompt get a brand panel.
  return { html: $.html(), repairs };
}

function fillEmptySlots(html: string, colors: BrandColors): string {
  const $ = cheerio.load(html);
  $("img[data-adrival-slot]").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    if (!src || /^data:image\/gif/i.test(src)) {
      $(el).attr("src", placeholderDataUri({ id: String($(el).attr("data-adrival-slot")), purpose: "", width: 1200, height: 800 }, colors));
    }
  });
  return $.html();
}

export type BlueprintBuildResult = {
  html: string;
  imageReport: UnifiedImageReport;
  warnings: string[];
  unresolved: string[];
  report: FidelityReport | null;
  repairedSections: string[];
  designCheck: DesignCheckSummary | null;
  /** Side-by-side review with the competitor, after the design check. */
  visualReview: VisualReviewSummary | null;
  /** The page's style file (awesome-design-md format). */
  designMd: string;
};

export type DesignCheckSummary = {
  engine: DesignCheck["engine"];
  /** Issues left: "repair" ones a rewrite could fix, "report" ones set by the brand or stylesheet. */
  remaining: Array<{ rule: string; name: string; sectionId: string | null; action: "repair" | "report" }>;
  foundBefore: number;
  autoFixed: string[];
  polishedSections: string[];
};

export async function buildFromBlueprint(input: {
  blueprint: CompetitorBlueprint;
  competitorId: string;
  competitorName: string;
  sourceUrl: string;
  clientUrl: string;
  clientName: string;
  keyword: string;
  colors: BrandColors;
  brandDesign: BrandDesignSystem | null;
  assets: BrandSiteAssets | null;
  profile: BusinessProfile | null;
  evidence: ClientEvidenceRecord;
  campaignOffer: Record<string, unknown> | null;
  identityLogoDataUri: string | null;
  logoUrl: string | null;
  proofLogos: Array<{ src: string; alt: string }>;
  previousImages: GeneratedLandingImage[];
  userFeedback: string | null;
  style?: StyleDirection | null;
  industry?: IndustryGuide | null;
  signal?: AbortSignal;
  onProgress: (message: string, info?: UnifiedProgressInfo) => void;
}): Promise<BlueprintBuildResult> {
  const { blueprint } = input;
  const form = primaryBlueprintForm(blueprint);
  const style: StyleDirection = input.style || "brand";
  const design = buildDesignSystem({
    shape: blueprint.shape,
    colors: input.colors,
    brandDesign: input.brandDesign,
    formStyle: form?.style || null,
    industryFonts: input.industry?.fonts || null,
    style,
  });
  const offer = input.campaignOffer as { headline?: string | null; primaryOffer?: string | null; cta?: string | null } | null;
  const destinations = blueprintDestinations({
    blueprint,
    clientUrl: input.clientUrl,
    assets: input.assets,
    campaignOffer: offer,
    keyword: input.keyword,
    hasForm: Boolean(form),
  });
  const plannedImages = Math.min(6, blueprint.sections.filter((s) => s.media.position !== "none" && s.media.images - s.media.logos > 0).length || 1);
  const genInput: BlueprintGenerationInput = {
    blueprint,
    design,
    client: {
      name: input.clientName,
      url: input.clientUrl,
      whatTheyDo: (input.profile?.description || input.profile?.positioningSummary || "").slice(0, 400),
      offerings: input.profile?.offerings || [],
      audience: input.profile?.targetAudience || null,
      location: null,
    },
    keyword: input.keyword,
    campaignOffer: input.campaignOffer,
    clientFacts: input.evidence.facts.slice(0, 40).map((f) => ({ id: f.id, category: f.category, value: f.value.slice(0, 400), status: f.status })),
    destinations,
    proofLogos: input.proofLogos,
    form,
    imageBudget: plannedImages,
    userFeedback: input.userFeedback,
    designDirection: {
      style,
      styleRules: styleGuide(style),
      industry: industryBrief(input.industry || null),
    },
    signal: input.signal,
    onProgress: (info) => input.onProgress(info.label, info),
  };

  input.onProgress("Writing the page section by section…");
  const generated = await generateBlueprintPage(genInput);
  const warnings = [...generated.response.warnings, ...generated.formNotes];
  if (generated.ctaLabel) {
    destinations.cta = destinations.cta.map((c) => ({ ...c, label: generated.ctaLabel! }));
    genInput.destinations = destinations;
  }
  const unresolved = [...generated.response.unresolvedRequirements];
  let html = generated.response.html;

  const logos = (h: string) => {
    let next = h;
    if (input.identityLogoDataUri) next = injectIdentityLogo(next, input.identityLogoDataUri, input.clientName, input.clientUrl);
    if (input.proofLogos.length && /data-logo-role="proof"|ADRIVAL_PROOF_LOGO/.test(next)) next = injectProofLogos(next, input.proofLogos);
    // Proof placeholders with no authorised logos are dropped, not left broken.
    next = next.replace(/<img\b[^>]*\{\{ADRIVAL_PROOF_LOGO\}\}[^>]*>/gi, "");
    return next;
  };
  html = logos(html);

  input.onProgress("Generating images…");
  const imageContext = imageContextFromProfile(input.profile, { clientName: input.clientName, colors: input.colors });
  const imageResult = await executeImageSlots({
    html,
    slots: generated.response.imageSlots,
    colors: input.colors,
    competitorId: input.competitorId,
    previous: input.previousImages,
    context: imageContext,
    signal: input.signal,
    onProgress: (done, total) => input.onProgress(`Generating images (${done}/${total})…`),
  });
  html = fillEmptySlots(imageResult.html, input.colors);
  let imageReport = imageResult.report;
  html = (await embedRemoteImagesInHtml(html, { maxImages: 24 })).html;

  // Header/footer: keep the model's (built from the competitor's) unless weak.
  const chromeAssets = {
    clientName: input.clientName,
    clientUrl: input.clientUrl,
    logoUrl: input.identityLogoDataUri || input.logoUrl || null,
    navLinks: destinations.nav,
    footerLinks: destinations.footer,
    footerColumns: destinations.footerColumns,
    ctaLinks: destinations.cta,
    socialLinks: destinations.social,
    phones: destinations.phones,
    emails: destinations.emails,
    tagline: input.profile?.positioningSummary || null,
  };
  const chrome = ensurePageChrome(html, chromeAssets, { forceHeader: false, forceFooter: false });
  html = chrome.html;
  if (chrome.repaired.length) warnings.push(`Rebuilt the ${chrome.repaired.join(" and ")} from your brand links.`);
  html = scrubOffTopicChromeHtml(html, destinations.topicHay, [
    ...destinations.nav.map((l) => l.label),
    ...destinations.footer.map((l) => l.label),
    ...destinations.footerColumns.flatMap((c) => c.links.map((l) => l.label)),
    ...destinations.cta.map((l) => l.label),
  ]);
  html = logos(html);

  const verified = verifyBlueprintPage(html, { hasForm: Boolean(form), clientUrl: input.clientUrl });
  html = verified.html;

  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const packaged = validateAndPackageUnifiedPage({
    html,
    clientHost: hostOf(input.clientUrl),
    competitorHost: hostOf(input.sourceUrl),
    logoRequired: Boolean(input.identityLogoDataUri || input.logoUrl),
    expectedSections: blueprint.sections.length,
    colors: input.colors,
    requireChrome: true,
  });
  html = packaged.html;
  warnings.push(...packaged.warnings);
  if (!packaged.ok) {
    if (!/<\/html>/i.test(html)) throw new Error(packaged.blockers.slice(0, 3).join(" ") || "The page could not be completed.");
    warnings.push(...packaged.blockers);
  }

  // ——— Compare with the competitor and rebuild the worst sections ———
  let report: FidelityReport | null = null;
  const repairedSections: string[] = [];
  const formSpec: CompetitorFormSpec | null = form;
  const expectedFormFields = formSpec ? formSpec.fields.length : 0;
  try {
    input.onProgress("Comparing the page with the competitor…");
    const measure = async (h: string) =>
      fidelityReport({
        blueprint,
        measured: await measureRenderedPage(h),
        html: h,
        competitorName: input.competitorName,
        expectedFormSection: form?.sectionId || null,
        expectedFormFields,
      });
    report = await measure(html);
    const sectionHtml = (h: string, id: string) => {
      const $ = cheerio.load(h);
      return $.html($(`section[data-section-id="${id}"]`).first()) || "";
    };
    // 1) Sections whose layout drifted are rebuilt (the form is kept as built).
    const toFix = report.sections.filter((s) => s.severe).slice(0, MAX_REPAIRS);
    if (toFix.length && !input.signal?.aborted) {
      input.onProgress(`Refining ${toFix.length} section${toFix.length === 1 ? "" : "s"} that drifted from the competitor…`);
      const rebuilt = await Promise.all(
        toFix.map(async (row) => {
          const section = blueprint.sections.find((s) => s.id === row.id)!;
          const held = holdForm(sectionHtml(html, row.id));
          try {
            const next = await regenerateBlueprintSection({ ...genInput, section, problems: row.problems, currentHtml: held.html });
            if (!next) return null;
            const restored = held.restore(next.html);
            // A form section that lost its form is not an improvement.
            if (row.kind === "form" && !/<form\b/i.test(restored)) return null;
            return { id: row.id, ...next, html: restored };
          } catch {
            return null;
          }
        }),
      );
      let next = html;
      const extraCss: string[] = [];
      const newSlots = [];
      for (const row of rebuilt) {
        if (!row) continue;
        const withId = swapCtaLabels(
          row.html.replace(/<section\b(?![^>]*\bid=)/i, `<section id="${row.id}"`),
          competitorCtaLabels(blueprint, input.campaignOffer, form),
          generated.ctaLabel,
        );
        next = replaceSection(next, row.id, withId);
        if (row.css) extraCss.push(`/* ${row.id} (refined) */\n${row.css}`);
        newSlots.push(...row.imageSlots);
        repairedSections.push(row.id);
      }
      if (repairedSections.length) {
        if (extraCss.length) next = next.replace(/<\/style>/i, `${extraCss.join("\n")}\n</style>`);
        next = logos(next);
        if (newSlots.length) {
          const more = await executeImageSlots({
            html: next,
            slots: newSlots,
            colors: input.colors,
            competitorId: input.competitorId,
            previous: imageReport.images,
            context: imageContext,
            signal: input.signal,
          });
          next = more.html;
          imageReport = {
            ...imageReport,
            planned: imageReport.planned + more.report.planned,
            completed: imageReport.completed + more.report.completed,
            failed: imageReport.failed + more.report.failed,
            placeholders: imageReport.placeholders + more.report.placeholders,
            skippedCredits: imageReport.skippedCredits + more.report.skippedCredits,
            images: [...imageReport.images.filter((i) => !more.report.images.some((m) => m.id === i.id)), ...more.report.images],
          };
        }
        next = fillEmptySlots(next, input.colors);
        const after = await measure(next);
        // Keep the refinement only if it did not make the page worse.
        if (after.score >= report.score) {
          html = next;
          report = after;
        } else {
          repairedSections.length = 0;
        }
      }
    }

    // 2) Lines that echo the competitor are reworded in place (layout untouched).
    const toReword = report.sections.filter((s) => s.copied.length).slice(0, 10);
    if (toReword.length && !input.signal?.aborted) {
      input.onProgress(`Rewording ${toReword.length} section${toReword.length === 1 ? "" : "s"} that echo the competitor…`);
      const reworded = await Promise.all(
        toReword.map(async (row) => {
          try {
            const next = await rewordBlueprintSection({
              sectionHtml: sectionHtml(html, row.id),
              copiedLines: row.copied,
              client: genInput.client,
              keyword: input.keyword,
              clientFacts: genInput.clientFacts,
              signal: input.signal,
              label: `Rewording section ${row.id.replace("sec-", "")}`,
            });
            return next ? { id: row.id, html: next } : null;
          } catch {
            return null;
          }
        }),
      );
      let next = html;
      const done: string[] = [];
      for (const row of reworded) {
        if (!row) continue;
        next = replaceSection(next, row.id, row.html);
        done.push(row.id);
      }
      if (done.length) {
        next = logos(next);
        const after = await measure(next);
        const copiedBefore = report.sections.reduce((n, s) => n + s.copied.length, 0);
        const copiedAfter = after.sections.reduce((n, s) => n + s.copied.length, 0);
        if (copiedAfter < copiedBefore && after.score >= report.score - 0.05) {
          html = next;
          report = after;
          for (const id of done) if (!repairedSections.includes(id)) repairedSections.push(id);
        }
      }
    }
  } catch (err) {
    warnings.push(`The comparison with the competitor could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
  }

  // ——— Design check (Impeccable + Vercel guidelines), then polish ———
  let designCheck: DesignCheckSummary | null = null;
  try {
    input.onProgress("Checking the design…");
    html = retonePlaceholders(html, input.colors);
    const fixes = applyDesignFixes(html);
    html = fixes.html;
    let check = await runDesignCheck(html);
    const foundBefore = check.findings.length;
    const polished: string[] = [];
    const worst = Object.entries(check.repairable)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_DESIGN_POLISH);
    if (worst.length && !input.signal?.aborted) {
      input.onProgress(`Polishing ${worst.length} section${worst.length === 1 ? "" : "s"} flagged by the design check…`);
      const sectionOf = (h: string, id: string) => {
        const $ = cheerio.load(h);
        return $.html($(`section[data-section-id="${id}"]`).first()) || "";
      };
      const results = await Promise.all(
        worst.map(async ([id, list]) => {
          const section = blueprint.sections.find((s) => s.id === id);
          const current = sectionOf(html, id);
          if (!section || !current) return null;
          try {
            const next = await polishBlueprintSection({
              section,
              sectionHtml: current,
              findings: findingsForPrompt(list),
              classSystem: design.vocabulary,
              designDirection: genInput.designDirection,
              signal: input.signal,
            });
            return next ? { id, ...next } : null;
          } catch {
            return null;
          }
        }),
      );
      const rows = results.filter((r): r is NonNullable<typeof r> => Boolean(r));
      if (rows.length) {
        const withCss = (h: string, list: typeof rows) => {
          const css = list.filter((r) => r.css).map((r) => `/* ${r.id} (polished) */\n${r.css}`);
          return css.length ? h.replace(/<\/style>/i, `${css.join("\n")}\n</style>`) : h;
        };
        const place = (h: string, list: typeof rows) => {
          let next = h;
          for (const row of list) next = replaceSection(next, row.id, row.html.replace(/<section\b(?![^>]*\bid=)/i, `<section id="${row.id}"`));
          return applyDesignFixes(logos(withCss(next, list))).html;
        };
        const trial = place(html, rows);
        const after = await runDesignCheck(trial);
        // Keep a polished section only if it has fewer findings than before.
        const cleaner = rows.filter((r) => repairableCount(after, r.id) < repairableCount(check, r.id));
        if (cleaner.length) {
          const accepted = cleaner.length === rows.length ? trial : place(html, cleaner);
          // …and only if the page still matches the competitor as well as it did.
          let keep = true;
          if (report) {
            const measured = await fidelityReport({
              blueprint,
              measured: await measureRenderedPage(accepted),
              html: accepted,
              competitorName: input.competitorName,
              expectedFormSection: form?.sectionId || null,
              expectedFormFields,
            });
            keep = measured.score >= report.score - 0.02;
            if (keep) report = measured;
          }
          if (keep) {
            html = accepted;
            check = await runDesignCheck(html);
            polished.push(...cleaner.map((r) => r.id));
          }
        }
      }
    }
    designCheck = {
      engine: check.engine,
      remaining: check.findings.map((f) => ({ rule: f.rule, name: f.name, sectionId: f.sectionId, action: f.action })),
      foundBefore,
      autoFixed: fixes.fixed,
      polishedSections: polished,
    };
  } catch (err) {
    warnings.push(`The design check could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
  }

  // ——— Side-by-side review with the competitor: fix what it flags, keep confirmed fixes ———
  let visualReview: VisualReviewSummary | null = null;
  if (!input.signal?.aborted) {
    try {
      input.onProgress("Reviewing the page side by side with the competitor…");
      const reviewed = await reviewAndFixPage({
        html,
        blueprint,
        classSystem: design.vocabulary,
        designDirection: genInput.designDirection,
        finish: (h) => applyDesignFixes(logos(h)).html,
        signal: input.signal,
        onProgress: (message) => input.onProgress(message),
      });
      html = reviewed.html;
      visualReview = reviewed.summary;
      warnings.push(...reviewed.warnings);
    } catch (err) {
      warnings.push(`The side-by-side review could not run: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
    }
  }

  // Every image slot carries its image (a rewritten section can lose one).
  html = restoreSlotImages(html, imageReport.images, input.colors).html;
  // Sections rebuilt during the checks may carry new light placeholders.
  html = retonePlaceholders(html, input.colors);
  // Images the writer added beyond the plan are listed as missing, so
  // "Generate missing images" can fill them later.
  const extra = unplannedPlaceholderSlots(html, new Set(imageReport.images.map((image) => image.id)));
  if (extra.length) {
    imageReport = {
      ...imageReport,
      planned: imageReport.planned + extra.length,
      placeholders: imageReport.placeholders + extra.length,
      images: [...imageReport.images, ...placeholderRecords(extra)],
    };
  }

  const designMd = designSystemToDesignMd({
    design,
    clientName: input.clientName,
    clientUrl: input.clientUrl,
    competitorName: input.competitorName,
    industry: input.industry?.productType || null,
  });

  return { html, imageReport, warnings, unresolved, report, repairedSections, designCheck, visualReview, designMd };
}
