import * as fs from "node:fs";
import * as path from "node:path";
import type { BrandColors, GeneratedLandingImage } from "../../types";
import type { BrandSiteAssets } from "../brandAssets";
import type { CanonicalContent, CompetitorReference } from "../content/model";
import type { PageInventory } from "../content/inventory";
import { generateGptImage2, hasRunwayKey, type GptImage2Ratio } from "../../runway/client";
import { assertPublicHttpUrl } from "../content/safeUrl";
import type { PageLayoutEvidence } from "./layoutEvidence";
import { buildLayoutSpec } from "./layoutSpec";
import { renderConstructedPage } from "./renderPage";
import { designTokens, luminance } from "./tokens";
import { contentPlacementErrors, layoutStructureErrors, measureConstructedPage } from "./validateRender";

export const IMAGE_PROMPT_VERSION = "construct-image-2";
export const CONSTRUCT_RENDERER_VERSION = "construct-2";

export type ConstructedPage = {
  html: string;
  images: GeneratedLandingImage[];
  blockers: string[];
  notes: string[];
  rendererVersion: string;
  layoutEvidence: PageLayoutEvidence | null;
};

type ImageGenerator = (input: {
  promptText: string;
  ratio: GptImage2Ratio;
  competitorId: string;
  imageId: string;
}) => Promise<{ buffer: Buffer; taskId: string }>;

const SOCIAL_HOST = /(^|\.)((facebook|instagram|linkedin|x|twitter|youtube|tiktok|youtu)\.com)$/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function logoScore(src: string, alt = ""): number {
  const hay = `${src} ${alt}`.toLowerCase();
  if (/favicon|clearbit|duckduckgo|s2\/favicons|apple-touch-icon/.test(hay)) return -10;
  let score = 0;
  if (/\/logo[-_.]|logo[-_.]?(light|white|dark)?\.(svg|png|webp|jpe?g)/.test(hay)) score += 8;
  if (/\blogo\b/.test(hay)) score += 3;
  if (/preview|testimonial|hero|banner|screenshot|magento|handshake|people|photo/.test(hay)) score -= 10;
  if (alt.trim().length > 48) score -= 5;
  return score;
}

function isLightLogo(src: string): boolean {
  return /logo-light|logo-white|white-logo|logo_light/i.test(src);
}

export function rankedLogos(assets: BrandSiteAssets | null | undefined): Array<{ src: string; alt: string; score: number }> {
  const seen = new Set<string>();
  const items = [
    ...(assets?.images || []).filter((image) => image.kind === "logo" && image.src),
    ...(assets?.logoUrl ? [{ src: assets.logoUrl, alt: "" }] : []),
  ];
  return items.flatMap((image) => {
    if (seen.has(image.src) || image.src === assets?.faviconUrl) return [];
    seen.add(image.src);
    const embedded = image.src.startsWith("data:image/") ? 20 : 0;
    return [{ src: image.src, alt: image.alt || "", score: logoScore(image.src, image.alt || "") + embedded }];
  }).filter((image) => image.score > 0).sort((a, b) => b.score - a.score);
}

export function verifiedCompanyLogo(assets: BrandSiteAssets | null | undefined): string | null {
  return logoStatus(assets).url;
}

export function logoStatus(assets: BrandSiteAssets | null | undefined, preferLight = false): { url: string | null; issue: string | null } {
  const ranked = rankedLogos(assets);
  const rawLogos = (assets?.images || []).filter((image) => image.kind === "logo" && image.src && !/favicon/i.test(image.src));
  const preferred = (assets?.logoUrl || "").trim() || null;

  if (!ranked.length) {
    if (preferred) return { url: preferred, issue: null };
    if (rawLogos.length > 1) {
      // Prefer the first logo mark over blocking recreate — export can still swap later.
      return {
        url: rawLogos[0].src,
        issue: "Multiple logo candidates found; using the first. Confirm the primary logo before export if needed.",
      };
    }
    return { url: rawLogos[0]?.src || null, issue: null };
  }
  const top = ranked.filter((image) => image.score === ranked[0].score);
  if (top.length > 1) {
    const light = top.find((image) => isLightLogo(image.src));
    const paired = top.some((image) => isLightLogo(image.src)) || top.some((image) => /logo-dark|logo-black|dark-logo/i.test(image.src));
    if (preferLight && light) return { url: light.src, issue: null };
    if (paired && !preferLight) {
      const plain = top.find((image) => !isLightLogo(image.src));
      if (plain) return { url: plain.src, issue: null };
    }
    if (preferred && top.some((image) => image.src === preferred)) {
      return { url: preferred, issue: null };
    }
    if (!paired) {
      return {
        url: top[0].src,
        issue: "Multiple similar logos ranked equally; using the top candidate. Confirm before export if needed.",
      };
    }
  }
  if (preferLight) {
    const light = ranked.find((image) => isLightLogo(image.src));
    if (light) return { url: light.src, issue: null };
  }
  return { url: ranked[0].src, issue: null };
}

export function isStaleDesignWrite(storedToken: string | null | undefined, ourToken: string): boolean {
  return Boolean(storedToken) && storedToken !== ourToken;
}

export function isImageCreditFailure(message: string): boolean {
  return /not enough credits|not have enough credits|insufficient credits|no remaining credits/i.test(message);
}

function safeHref(href: string | null | undefined, clientHost: string, allowSocial = false): string | null {
  const value = (href || "").trim();
  if (!value || value === "#") return null;
  if (/^(mailto:|tel:)/i.test(value)) return value;
  if (value.startsWith("#") && /^#[a-z0-9_-]+$/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (clientHost && host === clientHost) return url.toString();
    if (allowSocial && SOCIAL_HOST.test(host)) return url.toString();
    return null;
  } catch {
    return null;
  }
}

function uniqueLinks(links: Array<{ label: string; href: string }>): Array<{ label: string; href: string }> {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.label}|${link.href}`;
    if (seen.has(key) || !link.label.trim()) return false;
    seen.add(key);
    return true;
  });
}

function ratioFor(aspect: number | null): GptImage2Ratio {
  if (!aspect) return "1920:1440";
  if (aspect > 1.6) return "1920:1088";
  if (aspect > 1.2) return "1920:1440";
  if (aspect < 0.8) return "1088:1920";
  return "1920:1920";
}

function imagePrompt(purpose: string, brandName: string, service: string, colors: BrandColors): string {
  return [
    `Original illustrative photograph for a ${service || "service"} page section.`,
    `Section purpose, for subject only: ${purpose}.`,
    `Colour accents near ${colors.primary}, ${colors.accent}, and ${colors.background}.`,
    "No readable words, logos, watermarks, awards, fake dashboards, or named people.",
    `Do not depict ${brandName} staff, premises, or proof. Leave open space for HTML text.`,
  ].join(" ");
}

async function embedRemoteAsset(url: string): Promise<string | null> {
  try {
    const parsed = await assertPublicHttpUrl(url);
    const response = await fetch(parsed, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const mime = (response.headers.get("content-type") || "image/png").split(";")[0].trim();
    if (!mime.startsWith("image/")) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 32 || bytes.length > 2_000_000) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

function cachedImage(slotId: string, prompt: string, previous: GeneratedLandingImage[] | undefined, competitorId: string): string | null {
  const stored = previous?.find((image) => image.id === slotId && image.slotState !== "failed" && image.prompt === prompt);
  if (stored?.publicUrl.startsWith("data:image/")) return stored.publicUrl;
  const file = path.join(process.cwd(), "public", "generated", competitorId, `${slotId}.png`);
  if (stored && fs.existsSync(file)) return `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
  return null;
}

function evidenceForJob(input: { layoutEvidence?: PageLayoutEvidence | null; inventory?: PageInventory | null }): PageLayoutEvidence | null {
  if (input.layoutEvidence && !input.layoutEvidence.incomplete) return input.layoutEvidence;
  const stored = input.inventory?.layout;
  if (stored && !stored.incomplete) return stored;
  return input.layoutEvidence || stored || null;
}

export async function constructLandingPage(input: {
  snapshot: CanonicalContent;
  competitor: CompetitorReference;
  inventory?: PageInventory | null;
  layoutEvidence?: PageLayoutEvidence | null;
  colors: BrandColors;
  assets?: BrandSiteAssets | null;
  competitorId: string;
  keyword: string;
  previousImages?: GeneratedLandingImage[];
  generateImage?: ImageGenerator;
  hasImageKey?: () => boolean;
  embedAsset?: (url: string) => Promise<string | null>;
  fontFamily?: string | null;
  bodyFont?: string | null;
  radius?: string | null;
  browserValidate?: boolean;
  measurePage?: (html: string) => Promise<string[]>;
}): Promise<ConstructedPage> {
  const evidence = evidenceForJob(input);
  const clientHost = hostOf(input.snapshot.clientUrl);
  const spec = buildLayoutSpec(
    input.snapshot,
    evidence,
    (href) => safeHref(href, clientHost),
    input.competitor.sections.map((section) => ({ id: section.id, heading: section.heading })),
  );
  const tokens = designTokens(input.colors, input.fontFamily, { bodyFont: input.bodyFont, radius: input.radius });
  const notes = [
    `Renderer ${CONSTRUCT_RENDERER_VERSION}. Image prompts ${IMAGE_PROMPT_VERSION}. Fresh HTML was built from measured architecture. Competitor markup was not the shell.`,
    tokens.fontNote || "",
    tokens.fontHref ? `Online dependency: ${tokens.fontHref}` : "",
    ...spec.notes,
  ].filter(Boolean);
  const blockers = [...spec.blockers];
  if (!evidence) {
    return empty(blockers, notes);
  }
  const colors = input.colors;
  const images = new Map<string, string>();
  const generated: GeneratedLandingImage[] = [];
  const hasKey = input.hasImageKey || hasRunwayKey;
  const generate = input.generateImage || (async (slot) => {
    const result = await generateGptImage2({
      promptText: slot.promptText,
      ratio: slot.ratio,
      quality: "medium",
      competitorId: slot.competitorId,
      imageId: slot.imageId,
    });
    return { buffer: result.buffer, taskId: result.taskId };
  });

  if (!blockers.length) {
    let creditsExhausted = false;
    for (const slot of spec.imageSlots) {
      const ratio = ratioFor(slot.aspect);
      const prompt = imagePrompt(slot.purpose, input.snapshot.clientName, input.keyword, colors);
      generated.push(imageRecord(slot.id, slot.sectionId, prompt, ratio, "planned"));
      if (creditsExhausted) {
        blockers.push(`Required image ${slot.id} was not generated because the image account has no remaining credits. Export stays blocked.`);
        mark(generated, slot.id, "failed", "credits");
        continue;
      }
      const cached = cachedImage(slot.id, prompt, input.previousImages, input.competitorId);
      if (cached) {
        images.set(slot.id, cached);
        mark(generated, slot.id, "reused", "cached", cached);
        notes.push(`Reused cached image ${slot.id}.`);
        continue;
      }
      if (!hasKey()) {
        blockers.push(`Image generation is not configured. Required slot ${slot.id} was not filled with scraped imagery.`);
        mark(generated, slot.id, "failed", "unconfigured");
        continue;
      }
      mark(generated, slot.id, "generating", "runway");
      try {
        const result = await generate({
          promptText: prompt,
          ratio,
          competitorId: input.competitorId,
          imageId: slot.id,
        });
        const src = `data:image/png;base64,${result.buffer.toString("base64")}`;
        images.set(slot.id, src);
        mark(generated, slot.id, "ready", "embedded", src, result.taskId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        mark(generated, slot.id, "failed", isImageCreditFailure(message) ? "credits" : "provider");
        if (isImageCreditFailure(message)) {
          creditsExhausted = true;
          blockers.push(`Required image ${slot.id} failed because the image account has no remaining credits. A prompt was not exported as an image.`);
          continue;
        }
        blockers.push(`Image ${slot.id} failed: ${message}`);
      }
    }
  }

  const logoDecision = logoStatus(input.assets, luminance(tokens.surface) < 0.42);
  if (logoDecision.issue) blockers.push(logoDecision.issue);
  let logo: string | null = null;
  if (!logoDecision.url) {
    notes.push("No verified company logo. Header and footer use the client name as a wordmark.");
  } else {
    const embed = input.embedAsset || embedRemoteAsset;
    logo = logoDecision.url.startsWith("data:image/") ? logoDecision.url : await embed(logoDecision.url);
    if (!logo) blockers.push("The verified company logo could not be embedded. Another site image was not substituted.");
  }
  const nav = uniqueLinks((input.assets?.navLinks || []).flatMap((link) => {
    const href = safeHref(link.href, clientHost);
    return href && !/^(tel:|mailto:)/i.test(href) ? [{ label: link.label, href }] : [];
  })).slice(0, 6);
  const phone = [...(input.assets?.phones || [])].map((value) => ({ label: value, href: `tel:${value.replace(/\s+/g, "")}` }))[0]
    || (input.assets?.navLinks || []).flatMap((link) => {
      const href = safeHref(link.href, clientHost);
      return href && href.startsWith("tel:") ? [{ label: link.label, href }] : [];
    })[0];
  const cta = (input.assets?.ctaLinks || []).flatMap((link) => {
    const href = safeHref(link.href, clientHost);
    return href ? [{ label: link.label, href }] : [];
  })[0] || nav.find((link) => /contact|proposal|start|book|quote/i.test(`${link.label} ${link.href}`));
  const actions = [
    cta ? { ...cta, variant: "primary" as const } : null,
    phone ? { ...phone, variant: "outline" as const } : null,
  ].filter((item): item is { label: string; href: string; variant: "primary" | "outline" } => Boolean(item));
  const headerNav = nav.filter((link) => link.href !== cta?.href);
  const footer = uniqueLinks([
    ...(input.assets?.footerLinks || []),
    ...(input.assets?.socialLinks || []).map((link) => ({ ...link, href: safeHref(link.href, clientHost, true) || "" })),
  ].flatMap((link) => (link.href ? [{ label: link.label, href: link.href }] : [])));
  for (const email of input.assets?.emails || []) {
    footer.push({ label: email, href: `mailto:${email}` });
  }
  for (const phone of input.assets?.phones || []) {
    footer.push({ label: phone, href: `tel:${phone.replace(/\s+/g, "")}` });
  }

  let html = evidence.incomplete
    ? ""
    : renderConstructedPage({
        snapshot: input.snapshot,
        spec,
        evidence,
        tokens,
        logoUrl: logo,
        nav: headerNav,
        actions,
        footer: uniqueLinks(footer),
        images,
      });
  if (html) {
    blockers.push(...layoutStructureErrors(html));
    blockers.push(...contentPlacementErrors(html, spec, hostOf(input.competitor.sourceUrl)));
    if (input.browserValidate && blockers.length === 0) {
      try {
        const measure = input.measurePage || measureConstructedPage;
        const measured = await measure(html);
        if (measured.length) {
          notes.push(`Browser measurement found: ${measured.slice(0, 4).join(" ")}`);
          blockers.push(...measured.map((item) => `Layout measurement: ${item}`));
        } else {
          notes.push("Browser measurement at desktop, tablet, and phone found no overflow or broken column nesting.");
        }
      } catch (err) {
        blockers.push(`Browser layout measurement did not run: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return {
    html,
    images: generated,
    blockers: [...new Set(blockers)],
    notes,
    rendererVersion: CONSTRUCT_RENDERER_VERSION,
    layoutEvidence: evidence,
  };
}

function empty(blockers: string[], notes: string[]): ConstructedPage {
  return {
    html: "",
    images: [],
    blockers,
    notes,
    rendererVersion: CONSTRUCT_RENDERER_VERSION,
    layoutEvidence: null,
  };
}

function imageRecord(id: string, label: string, prompt: string, ratio: string, slotState: GeneratedLandingImage["slotState"]): GeneratedLandingImage {
  const now = new Date().toISOString();
  return {
    id,
    label,
    kind: ratio === "1920:1088" ? "hero" : "content",
    prompt,
    ratio,
    publicUrl: "",
    createdAt: now,
    updatedAt: now,
    slotState,
    reused: false,
    provider: "runway",
    model: "gpt_image_2",
    validation: slotState,
  };
}

function mark(
  images: GeneratedLandingImage[],
  id: string,
  slotState: GeneratedLandingImage["slotState"],
  validation: string,
  publicUrl = "",
  taskId?: string,
): void {
  const image = images.find((item) => item.id === id);
  if (!image) return;
  image.slotState = slotState;
  image.validation = validation;
  image.updatedAt = new Date().toISOString();
  image.reused = slotState === "reused";
  if (publicUrl) image.publicUrl = publicUrl;
  if (taskId) image.runwayTaskId = taskId;
}
