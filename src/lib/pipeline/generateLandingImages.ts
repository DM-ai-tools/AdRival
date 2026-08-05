import * as cheerio from "cheerio";
import OpenAI from "openai";
import { z } from "zod";
import type { BrandColors, GeneratedLandingImage } from "../types";
import { getOpenAiContentModel } from "./contentDraft";
import {
  generateGptImage2,
  hasRunwayKey,
  logoUrlToReferenceUri,
  pickGptImage2Ratio,
  type GptImage2Ratio,
} from "../runway/client";
import {
  isPartnerLogoContext,
  isSiteLogoCandidate,
} from "./archive/applyBrandDeterministic";

const MAX_SLOTS = 10;
const CONCURRENCY = 2;

export type ImageSlot = {
  id: string;
  kind: "hero" | "content" | "team" | "product" | "background";
  selectorHint: string;
  alt: string;
  className: string;
  sectionContext: string;
  width: number | null;
  height: number | null;
  isBackground: boolean;
  /** Original src (may be data URI) — used as optional Runway reference */
  src: string;
};

const briefSchema = z.object({
  briefs: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().optional().nullable(),
        prompt: z.string(),
        kind: z
          .enum(["hero", "content", "team", "product", "background"])
          .optional()
          .nullable(),
      }),
    )
    .default([]),
});

function looksLikeJunkImage(hay: string): boolean {
  return /icon|sprite|bullet|check|tick|star|badge|payment|flag|social|emoji|avatar|pixel|tracking|logo|wordmark|favicon|spacer|1x1|blank|placeholder/i.test(
    hay,
  );
}

/** Archived pages often inline photos as data: URIs — treat those as photos. */
function looksLikePhotoSrc(src: string): boolean {
  if (!src) return false;
  if (/^data:image\/(jpeg|jpg|png|webp|gif|avif)/i.test(src)) return true;
  if (/^data:image\/svg/i.test(src)) return false;
  return (
    /\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(src) ||
    /unsplash|pexels|cloudinary|imgix|cdn\.|media\./i.test(src)
  );
}

function nearestText($: cheerio.CheerioAPI, el: any): string {
  const $el = $(el);
  const parts: string[] = [];
  const section = $el.closest("section, article, .hero, header, main, div").first();
  section.find("h1, h2, h3, h4, p, figcaption").each((_, node) => {
    const t = $(node).text().replace(/\s+/g, " ").trim();
    if (t.length >= 8 && t.length <= 180) parts.push(t);
  });
  return parts.slice(0, 4).join(" · ").slice(0, 420);
}

/**
 * Inventory large content/hero images (and CSS background photos) to replace.
 * Skips logos, icons, and tiny UI chrome.
 */
export function inventoryImageSlots(html: string): {
  html: string;
  slots: ImageSlot[];
} {
  const $ = cheerio.load(html);
  const slots: ImageSlot[] = [];
  let heroTaken = false;

  // Promote lazy-loaded sources onto src before inventory
  $("img").each((_, el) => {
    const $el = $(el);
    if (($el.attr("src") || "").trim()) return;
    const lazy =
      $el.attr("data-src") ||
      $el.attr("data-lazy-src") ||
      $el.attr("data-original") ||
      $el.attr("data-bg") ||
      "";
    if (lazy.trim()) $el.attr("src", lazy.trim());
  });

  $("img").each((_, el) => {
    if (slots.length >= MAX_SLOTS) return;
    const $el = $(el);
    if ($el.attr("data-adrival-logo") || $el.attr("data-adrival-gen-id")) return;

    const src = ($el.attr("src") || "").trim();
    if (!src) return;
    const alt = ($el.attr("alt") || "").trim();
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    const hay = `${src.slice(0, 160)} ${alt} ${className}`.toLowerCase();

    // Logos / partner marks never become AI slots
    if (isSiteLogoCandidate($el, src, alt, className)) return;
    if (isPartnerLogoContext($el)) return;
    if (looksLikeJunkImage(hay)) return;
    if (/^data:image\/svg/i.test(src) || /\.svg(\?|#|$)/i.test(src)) return;

    // Never inventory header/nav/footer brand chrome (photos in hero still ok)
    const inChrome = $el.closest(
      "header, nav, [role='banner'], .navbar, .site-header, a.logo, .navbar-brand",
    ).length;
    if (inChrome && !/hero|banner|cover|photo|team|people|portrait/i.test(hay)) {
      return;
    }
    if (
      $el.closest("footer, [role='contentinfo'], [class*='Footer']").length &&
      !/hero|banner|cover|photo|team/i.test(hay)
    ) {
      return;
    }
    const looksPhotoFile = looksLikePhotoSrc(src);

    // Allow list items when they look like photo cards OR are real photo data/files
    if (
      $el.closest("li, ul, ol").length &&
      !looksPhotoFile &&
      !/hero|banner|cover|team|staff|doctor|clinic|treatment|before|after|photo|gallery|card/i.test(
        hay,
      )
    ) {
      return;
    }

    const width = Number($el.attr("width") || 0) || null;
    const height = Number($el.attr("height") || 0) || null;
    if ((width && width <= 96) || (height && height <= 96)) return;

    const inHero =
      $el.closest(
        ".hero, .banner, .jumbotron, [class*='hero'], [class*='Hero'], [class*='banner'], [class*='masthead'], section:first-of-type",
      ).length > 0;
    const inMain =
      $el.closest("main, article, section, [class*='section'], [class*='Section']")
        .length > 0;
    // Large inline data-URI photos (common after Playwright archive) count as content
    const dataUriPhoto = /^data:image\/(jpeg|jpg|png|webp|gif|avif)/i.test(src);
    const looksLarge =
      (width != null && width >= 180) ||
      (height != null && height >= 140) ||
      /hero|banner|cover|main-image|featured|team|clinic|office|smile|before|after|gallery|photo|portrait|treatment/i.test(
        hay,
      ) ||
      (inMain && looksPhotoFile && !width && !height) ||
      (dataUriPhoto && src.length > 8_000);

    if (!inHero && !looksLarge) return;

    let kind: ImageSlot["kind"] = "content";
    if (inHero && !heroTaken) {
      kind = "hero";
      heroTaken = true;
    } else if (/team|staff|doctor|dentist|about/i.test(hay)) {
      kind = "team";
    } else if (/product|treatment|service|before|after/i.test(hay)) {
      kind = "product";
    }

    const id = `img${slots.length}`;
    $el.attr("data-adrival-gen-id", id);
    slots.push({
      id,
      kind,
      selectorHint: "img",
      alt,
      className: className.slice(0, 160),
      sectionContext: nearestText($, el),
      width,
      height,
      isBackground: false,
      src: src.length > 5_000_000 ? "" : src,
    });
  });

  if (slots.length < MAX_SLOTS) {
    $(
      ".hero, [class*='hero'], [class*='Hero'], .banner, [class*='banner'], [class*='masthead'], section, [class*='section']",
    ).each((_, el) => {
      if (slots.length >= MAX_SLOTS) return;
      const $el = $(el);
      if ($el.attr("data-adrival-gen-id")) return;
      if ($el.closest("header, nav, footer").length) return;
      if ($el.find("[data-adrival-gen-id]").length) return;
      const style = $el.attr("style") || "";
      const match = style.match(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/i);
      if (!match?.[2]) return;
      const src = match[2].trim();
      if (!src || looksLikeJunkImage(src)) return;
      // Prefer larger background containers
      const className = ($el.attr("class") || "").slice(0, 160);
      if (
        !/hero|banner|masthead|cover|bg|background/i.test(className) &&
        slots.length >= 3
      ) {
        return;
      }

      const id = `img${slots.length}`;
      $el.attr("data-adrival-gen-id", id);
      slots.push({
        id,
        kind: heroTaken ? "background" : "hero",
        selectorHint: "background",
        alt: "",
        className,
        sectionContext: nearestText($, el),
        width: 1600,
        height: 900,
        isBackground: true,
        src: src.length > 5_000_000 ? "" : src,
      });
      if (!heroTaken) heroTaken = true;
    });
  }

  return { html: $.html(), slots };
}

/**
 * Read slots already stamped with data-adrival-gen-id (from a prior inventory).
 */
export function collectStampedImageSlots(html: string): ImageSlot[] {
  const $ = cheerio.load(html);
  const slots: ImageSlot[] = [];
  $("[data-adrival-gen-id]").each((_, el) => {
    const $el = $(el);
    const id = ($el.attr("data-adrival-gen-id") || "").trim();
    if (!id) return;
    const isBackground = !$el.is("img");
    const src = isBackground
      ? (($el.attr("style") || "").match(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/i)?.[2] ||
          "").trim()
      : ($el.attr("src") || "").trim();
    const alt = ($el.attr("alt") || "").trim();
    const className = ($el.attr("class") || "").slice(0, 160);
    const hay = `${alt} ${className}`.toLowerCase();
    let kind: ImageSlot["kind"] = "content";
    if (/hero|banner|masthead/i.test(hay) || id === "img0") kind = "hero";
    else if (/team|staff|doctor/i.test(hay)) kind = "team";
    else if (/product|treatment/i.test(hay)) kind = "product";
    else if (isBackground) kind = "background";
    slots.push({
      id,
      kind,
      selectorHint: isBackground ? "background" : "img",
      alt,
      className,
      sectionContext: nearestText($, el),
      width: Number($el.attr("width") || 0) || (isBackground ? 1600 : null),
      height: Number($el.attr("height") || 0) || (isBackground ? 900 : null),
      isBackground,
      src: src.length > 5_000_000 ? "" : src,
    });
  });
  return slots.slice(0, MAX_SLOTS);
}

async function decideImageBriefs(input: {
  slots: ImageSlot[];
  brandName: string;
  businessUrl: string;
  keyword: string;
  industry?: string | null;
  brandColors: BrandColors;
  competitorName: string;
  hasLogoReference?: boolean;
}): Promise<
  Array<{
    id: string;
    label: string;
    prompt: string;
    kind: ImageSlot["kind"];
  }>
> {
  if (!input.slots.length) return [];
  if (!process.env.OPENAI_API_KEY) {
    return input.slots.map((s) => ({
      id: s.id,
      label: `${s.kind} image`,
      kind: s.kind,
      prompt: fallbackPrompt(s, input),
    }));
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = getOpenAiContentModel();
  const logoRule = input.hasLogoReference
    ? `5) When a logo/signage would appear (office wall, storefront, desk, packaging), instruct placing the brand logo from the @brandlogo reference EXACTLY — same wordmark and colors. Never invent a different logo. Never mention competitor "${input.competitorName}". No watermarks or fake UI chrome.`
    : `5) Never mention competitor "${input.competitorName}". Do not invent company logos or wordmarks. No watermarks, no unreadable text overlays, no UI chrome.`;

  try {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.45,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You write image-generation prompts for a brand landing page recreation.
Return ONLY JSON: { "briefs": [ { "id": "img0", "label": "Hero clinic photo", "kind": "hero", "prompt": "..." } ] }

Rules:
1) One brief per slot id provided — same ids, no extras.
2) prompt must describe a photorealistic marketing photo for brand "${input.brandName}" (${input.businessUrl}).
3) Match the slot's role (hero / team / product / content / background) and page context.
4) Use brand palette hints: primary ${input.brandColors.primary}, accent ${input.brandColors.accent}, secondary ${input.brandColors.secondary}. Prefer clean professional interiors when industry fits.
${logoRule}
6) Keep composition compatible with the slot (wide hero vs portrait team headshot).
7) prompt length 40–120 words, concrete and visual.`,
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              brand: input.brandName,
              keyword: input.keyword,
              industry: input.industry || null,
              hasLogoReference: Boolean(input.hasLogoReference),
              slots: input.slots.map((s) => ({
                id: s.id,
                kind: s.kind,
                alt: s.alt,
                className: s.className,
                sectionContext: s.sectionContext,
                width: s.width,
                height: s.height,
                isBackground: s.isBackground,
              })),
            },
            null,
            2,
          ),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) throw new Error("empty LLM response");
    const parsed = briefSchema.parse(JSON.parse(raw));
    const byId = new Map(parsed.briefs.map((b) => [b.id, b]));

    return input.slots.map((s) => {
      const b = byId.get(s.id);
      const prompt = (b?.prompt || "").trim() || fallbackPrompt(s, input);
      return {
        id: s.id,
        label: (b?.label || `${s.kind} image`).trim().slice(0, 80),
        kind: (b?.kind as ImageSlot["kind"]) || s.kind,
        prompt: prompt.slice(0, 2000),
      };
    });
  } catch (err) {
    console.warn("[generateLandingImages] brief LLM failed, using fallbacks", err);
    return input.slots.map((s) => ({
      id: s.id,
      label: `${s.kind} image`,
      kind: s.kind,
      prompt: fallbackPrompt(s, input),
    }));
  }
}

function fallbackPrompt(
  slot: ImageSlot,
  input: {
    brandName: string;
    keyword: string;
    industry?: string | null;
    brandColors: BrandColors;
    hasLogoReference?: boolean;
  },
): string {
  const industry = input.industry || "professional services";
  const scene =
    slot.kind === "hero"
      ? `wide welcoming ${industry} interior or exterior hero photograph`
      : slot.kind === "team"
        ? `friendly professional team portrait in a modern ${industry} setting`
        : slot.kind === "product"
          ? `clean close-up of ${industry} treatment or service in use`
          : `lifestyle photograph supporting ${input.keyword} for a modern ${industry} brand`;
  const logoBit = input.hasLogoReference
    ? ` If any wall signage or logo appears, use the exact @brandlogo mark for ${input.brandName}.`
    : ` Do not invent logos or wordmarks.`;
  return `Photorealistic ${scene} for ${input.brandName}. Soft natural light, premium marketing photography, brand accents near ${input.brandColors.primary} and ${input.brandColors.accent}, uncluttered composition, no watermarks.${logoBit} Context: ${slot.sectionContext || slot.alt || slot.kind}.`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return out;
}

export function embedGeneratedImages(
  html: string,
  images: GeneratedLandingImage[],
): { html: string; embedded: number } {
  const $ = cheerio.load(html);
  let embedded = 0;
  const byId = new Map(images.map((img) => [img.id, img]));
  const usedIds = new Set<string>();

  const applyToEl = ($el: any, img: GeneratedLandingImage) => {
    // Never put AI images onto logo marks
    if ($el.attr("data-adrival-logo")) return;
    if ($el.is("img")) {
      const src = ($el.attr("src") || "").trim();
      const alt = ($el.attr("alt") || "").trim();
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      if (isSiteLogoCandidate($el, src, alt, className) || isPartnerLogoContext($el)) {
        return;
      }
      $el.attr("src", img.publicUrl);
      $el.removeAttr("srcset");
      $el.removeAttr("sizes");
      $el.removeAttr("data-src");
      $el.removeAttr("data-lazy-src");
      $el.removeAttr("data-original");
      $el.attr("data-adrival-gen-id", img.id);
      $el.attr("data-adrival-image", "1");
      $el.attr("loading", $el.attr("loading") || "lazy");
      // Neutralize <picture><source> which otherwise wins over img[src]
      const $picture = $el.parent("picture");
      if ($picture.length) {
        $picture.find("source").each((_: number, srcEl: any) => {
          const $s = $(srcEl);
          $s.attr("srcset", img.publicUrl);
          $s.removeAttr("data-srcset");
        });
      }
      const style = $el.attr("style") || "";
      if (!/object-fit/i.test(style)) {
        $el.attr(
          "style",
          `${style}${style && !style.trim().endsWith(";") ? ";" : ""}object-fit:cover;`,
        );
      }
      embedded += 1;
      usedIds.add(img.id);
      return;
    }

    const style = $el.attr("style") || "";
    if (/url\(/i.test(style)) {
      $el.attr(
        "style",
        style.replace(
          /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
          `url("${img.publicUrl}")`,
        ),
      );
    } else {
      $el.attr(
        "style",
        `${style}${style && !style.trim().endsWith(";") ? ";" : ""}background-image:url("${img.publicUrl}");background-size:cover;background-position:center;`,
      );
    }
    $el.attr("data-adrival-gen-id", img.id);
    $el.attr("data-adrival-image", "1");
    embedded += 1;
    usedIds.add(img.id);
  };

  // 1) Exact stamp match
  $("[data-adrival-gen-id]").each((_, el) => {
    const $el = $(el);
    const id = $el.attr("data-adrival-gen-id") || "";
    const img = byId.get(id);
    if (!img?.publicUrl) return;
    applyToEl($el, img);
  });

  // 2) Place unused generated images into remaining large CONTENT imgs only
  const unused = images.filter((img) => img.publicUrl && !usedIds.has(img.id));
  if (unused.length) {
    let ui = 0;
    $("img").each((_, el) => {
      if (ui >= unused.length) return;
      const $el = $(el);
      if ($el.attr("data-adrival-logo")) return;
      if (isPartnerLogoContext($el)) return;
      const srcAttr = ($el.attr("src") || "").trim();
      const alt = ($el.attr("alt") || "").trim();
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      if (isSiteLogoCandidate($el, srcAttr, alt, className)) return;
      if (
        $el.attr("data-adrival-gen-id") &&
        usedIds.has($el.attr("data-adrival-gen-id")!)
      ) {
        return;
      }
      if ($el.closest("footer, nav, header").length) return;
      const hay = `${srcAttr} ${alt} ${className}`.toLowerCase();
      if (looksLikeJunkImage(hay)) return;
      if ($el.attr("data-adrival-image") === "1" && /\/generated\//i.test(srcAttr)) {
        return;
      }
      // Only fill clear photo-sized content slots
      const width = Number($el.attr("width") || 0);
      const height = Number($el.attr("height") || 0);
      if ((width && width <= 120) || (height && height <= 120)) return;
      applyToEl($el, unused[ui++]);
    });
  }

  // 3) Never leave AI src on logo stamps (safety if order raced)
  $("img[data-adrival-logo]").each((_, el) => {
    const $el = $(el);
    $el.removeAttr("data-adrival-gen-id");
    $el.removeAttr("data-adrival-image");
  });

  return { html: $.html(), embedded };
}

/**
 * Replace a single generated image src in HTML after regenerate.
 */
export function replaceGeneratedImageInHtml(
  html: string,
  image: GeneratedLandingImage,
): string {
  const $ = cheerio.load(html);
  $(`[data-adrival-gen-id="${image.id}"]`).each((_, el) => {
    const $el = $(el);
    if ($el.is("img")) {
      $el.attr("src", image.publicUrl);
      $el.removeAttr("srcset");
      $el.removeAttr("sizes");
      const $picture = $el.parent("picture");
      if ($picture.length) {
        $picture.find("source").attr("srcset", image.publicUrl);
      }
      return;
    }
    const style = $el.attr("style") || "";
    if (/url\(/i.test(style) || /background-image/i.test(style)) {
      const next = /url\(/i.test(style)
        ? style.replace(
            /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
            `url("${image.publicUrl}")`,
          )
        : `${style};background-image:url("${image.publicUrl}");`;
      $el.attr("style", next);
    }
  });
  return $.html();
}

export type GenerateLandingImagesResult = {
  html: string;
  images: GeneratedLandingImage[];
  warnings: string[];
  embedded: number;
};

/**
 * LLM briefs → Runway GPT Image 2 → embed into stamped slots.
 * Reuses existing `data-adrival-gen-id` stamps when present.
 */
export async function generateAndEmbedLandingImages(input: {
  html: string;
  competitorId: string;
  brandName: string;
  businessUrl: string;
  keyword: string;
  competitorName: string;
  industry?: string | null;
  brandColors: BrandColors;
  /** Brand logo URL — fed to Runway as @brandlogo reference */
  logoUrl?: string | null;
  /** Pre-inventoried slots (avoids re-stamping) */
  slots?: ImageSlot[] | null;
}): Promise<GenerateLandingImagesResult> {
  const warnings: string[] = [];
  if (!hasRunwayKey()) {
    return {
      html: input.html,
      images: [],
      warnings: [
        "RUNWAYML_API_SECRET not set — skipped GPT Image 2 generation",
      ],
      embedded: 0,
    };
  }

  let html = input.html;
  let slots = input.slots?.length
    ? input.slots
    : collectStampedImageSlots(html);

  if (!slots.length) {
    const inventoried = inventoryImageSlots(html);
    html = inventoried.html;
    slots = inventoried.slots;
  }

  if (!slots.length) {
    return {
      html,
      images: [],
      warnings: ["No suitable competitor image slots found to replace"],
      embedded: 0,
    };
  }

  const logoReferenceUri = await logoUrlToReferenceUri(input.logoUrl);
  if (input.logoUrl && !logoReferenceUri) {
    warnings.push("Brand logo could not be loaded as an image reference");
  }

  const briefs = await decideImageBriefs({
    slots,
    brandName: input.brandName,
    businessUrl: input.businessUrl,
    keyword: input.keyword,
    industry: input.industry,
    brandColors: input.brandColors,
    competitorName: input.competitorName,
    hasLogoReference: Boolean(logoReferenceUri),
  });

  const slotById = new Map(slots.map((s) => [s.id, s]));
  const generated = await mapPool(briefs, CONCURRENCY, async (brief) => {
    const slot = slotById.get(brief.id)!;
    const ratio: GptImage2Ratio = pickGptImage2Ratio(slot.width, slot.height);
    try {
      // Raster refs only — SVG / junk URIs are stripped inside usableRefUri
      const compositionRef =
        slot.src.startsWith("data:image/") || slot.src.startsWith("http")
          ? slot.src
          : null;
      const result = await generateGptImage2({
        promptText: brief.prompt,
        ratio,
        quality: "medium",
        referenceImageUri: compositionRef,
        logoReferenceUri: logoReferenceUri || null,
        competitorId: input.competitorId,
        imageId: brief.id,
      });
      const image: GeneratedLandingImage = {
        id: brief.id,
        label: brief.label,
        kind: brief.kind,
        prompt: brief.prompt,
        ratio,
        publicUrl: result.publicUrl,
        runwayTaskId: result.taskId,
        width: slot.width,
        height: slot.height,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return image;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`${brief.id}: ${msg}`);
      console.warn("[generateLandingImages] slot failed", brief.id, err);
      return null;
    }
  });

  const images = generated.filter((g): g is GeneratedLandingImage => Boolean(g));
  const embedded = embedGeneratedImages(html, images);

  return {
    html: embedded.html,
    images,
    warnings,
    embedded: embedded.embedded,
  };
}

/**
 * Regenerate one slot with the same brief (optional extra feedback).
 */
export async function regenerateLandingImage(input: {
  image: GeneratedLandingImage;
  competitorId: string;
  feedback?: string | null;
  logoUrl?: string | null;
}): Promise<GeneratedLandingImage> {
  if (!hasRunwayKey()) {
    throw new Error("RUNWAYML_API_SECRET is not set");
  }
  const feedback = (input.feedback || "").trim().slice(0, 800);
  const prompt = feedback
    ? `${input.image.prompt}\n\nRevision notes: ${feedback}`
    : `${input.image.prompt}\n\nCreate a fresh alternate take with the same subject and composition goals.`;

  const logoReferenceUri = await logoUrlToReferenceUri(input.logoUrl);
  const result = await generateGptImage2({
    promptText: prompt,
    ratio: (input.image.ratio as GptImage2Ratio) || "auto",
    quality: "medium",
    logoReferenceUri,
    competitorId: input.competitorId,
    imageId: input.image.id,
  });

  return {
    ...input.image,
    prompt: feedback ? prompt : input.image.prompt,
    publicUrl: result.publicUrl,
    runwayTaskId: result.taskId,
    updatedAt: new Date().toISOString(),
  };
}
