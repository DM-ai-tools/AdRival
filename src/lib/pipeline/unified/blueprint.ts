import sharp from "sharp";
import type { Browser, Page } from "playwright";
import { assertPublicHttpUrl } from "../content/safeUrl";
import type { InventoryComponent, InventorySection, PageInventory } from "../content/inventory";
import type { CompetitorFormField, CompetitorFormSpec } from "./recreateChrome";
import { BLUEPRINT_PROBE_SCRIPT, FORM_PROBE_SCRIPT, REVEAL_CSS } from "./blueprintProbe";

/**
 * Competitor blueprint: one rendered browser pass that records what the
 * rebuild needs to look like the competitor — real sections with their text,
 * layout and background, readable screenshots of each section, the design
 * "shape" (type scale, spacing, corners, buttons, cards) and every lead form
 * after scripts have loaded.
 */

export type BlueprintBlock = { role: string; text: string };

export type BlueprintSection = {
  id: string;
  order: number;
  bounds: { x: number; y: number; width: number; height: number };
  heading: string | null;
  blocks: BlueprintBlock[];
  wordCount: number;
  layout: {
    columns: number;
    cards: number;
    card: { radius: number | null; shadow: boolean; border: boolean; background: string | null } | null;
  };
  media: {
    images: number;
    logos: number;
    video: boolean;
    position: "left" | "right" | "above" | "below" | "background" | "none";
    largest: { width: number; height: number } | null;
  };
  background: { kind: "page" | "color" | "dark" | "gradient" | "wash" | "image"; color: string | null; image: string | null };
  align: string;
  paddingTop: number | null;
  containerWidth: number | null;
  hasFormControls: boolean;
  faq: boolean;
  kind: SectionKind;
  formId: string | null;
  /** JPEG base64 crop of this section, readable width. */
  crop: string | null;
};

export type SectionKind =
  | "hero"
  | "logos"
  | "stats"
  | "features"
  | "steps"
  | "testimonials"
  | "faq"
  | "pricing"
  | "form"
  | "cta"
  | "media"
  | "content";

type TypeSample = {
  size: number | null;
  weight: number | null;
  lineHeight: number | null;
  letterSpacing: number | null;
  transform: string;
  family: string;
} | null;

export type DesignShape = {
  h1: TypeSample;
  h2: TypeSample;
  h3: TypeSample;
  body: TypeSample;
  eyebrow: { size: number | null; weight: number; letterSpacing: number | null; pill: boolean } | null;
  button: {
    radius: number | null;
    paddingY: number | null;
    paddingX: number | null;
    weight: number | null;
    size: number | null;
    transform: string;
    letterSpacing: number | null;
    shadow: boolean;
    height: number | null;
  } | null;
  sectionPadding: number | null;
  container: number | null;
  cardRadius: number | null;
  cardShadow: boolean;
  cardBorder: boolean;
  darkBands: number;
  gradientBands: number;
  pageBackground: string;
};

export type BlueprintFormStyle = {
  inputRadius: number | null;
  inputHeight: number | null;
  inputBorder: "underline" | "box" | "none" | null;
  inputFilled: boolean | null;
  buttonRadius: number | null;
  buttonFullWidth: boolean | null;
  perRow: number;
  labels: "above" | "placeholder";
  panel: { radius: number | null; shadow: boolean; dark: boolean } | null;
};

export type BlueprintForm = CompetitorFormSpec & {
  id: string;
  sectionId: string | null;
  hidden: boolean;
  provider: string | null;
  /** Booking widgets (Calendly etc.) have no fields to copy. */
  booking: boolean;
  steps: Array<{ title: string | null; fields: string[] }>;
  /** single form, groups shown together, or one step at a time. */
  mode: "single" | "grouped" | "multi-step";
  /** True when later steps are only known by title (the page renders one step at a time). */
  partialSteps: boolean;
  nextLabel: string | null;
  consent: boolean;
  style: BlueprintFormStyle | null;
};

export type CompetitorBlueprint = {
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  pageHeight: number;
  sections: BlueprintSection[];
  forms: BlueprintForm[];
  shape: DesignShape;
  header: {
    bounds: { x: number; y: number; width: number; height: number };
    nav: string[];
    cta: string | null;
    dark: boolean;
    sticky: boolean;
    logoPosition: string;
    crop: string | null;
  } | null;
  footer: {
    bounds: { x: number; y: number; width: number; height: number };
    columns: number;
    dark: boolean;
    links: string[];
    crop: string | null;
  } | null;
  warnings: string[];
};

type RawForm = {
  index: number;
  hidden: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  provider: string | null;
  heading: string | null;
  intro: string | null;
  submitLabel: string | null;
  nextLabel: string | null;
  steps: Array<{ title: string | null; fields: string[] }>;
  stepTitles?: string[];
  consent: boolean;
  fields: Array<{
    label: string;
    name: string;
    type: string;
    required: boolean;
    options: string[];
    placeholder: string | null;
    autocomplete: string | null;
    visible: boolean;
  }>;
  style: BlueprintFormStyle | null;
};

type RawProbe = {
  title: string;
  url: string;
  viewport: { width: number; height: number };
  pageHeight: number;
  sections: Array<Omit<BlueprintSection, "id" | "kind" | "formId" | "crop">>;
  shape: DesignShape;
  header: (NonNullable<CompetitorBlueprint["header"]>) | null;
  footer: (NonNullable<CompetitorBlueprint["footer"]>) | null;
};

const VIEWPORT = { width: 1280, height: 860 };
/** Anthropic scales images to about 1568px on the long edge; stay under it. */
const MAX_CROP_HEIGHT = 1500;
const MAX_CROP_BYTES = 260_000;

// ——— field labels ———

const FIELD_WORDS =
  /name|email|e-mail|phone|mobile|number|company|business|website|url|message|budget|service|industry|role|title|city|state|country|zip|postcode|address|revenue|spend|size|employees|goal|challenge|date|time|help|interest|how did|referr|comment|question|details|job|position/i;

function humanize(raw: string): string {
  return raw
    .replace(/\[\]$/, "")
    .replace(/^(input|field|your)[_-]?/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The competitor's label, or a sensible one when the page only shows a sample
 * value as placeholder ("John", "john@company.com").
 */
export function resolveFieldLabel(field: {
  label: string;
  name: string;
  type: string;
  placeholder: string | null;
  autocomplete: string | null;
}): string {
  const label = (field.label || "").trim();
  const placeholder = (field.placeholder || "").trim();
  const labelIsSample = label && label === placeholder && !FIELD_WORDS.test(label);
  if (label && !labelIsSample && !/^(input|field)\s*\d*$/i.test(label)) return label;
  const hay = `${field.autocomplete || ""} ${field.name || ""} ${field.type} ${placeholder}`.toLowerCase();
  if (/given-name|first[\s_-]?name|fname/.test(hay)) return "First name";
  if (/family-name|last[\s_-]?name|lname|surname/.test(hay)) return "Last name";
  if (field.type === "email" || /e-?mail|@/.test(hay)) return "Email";
  if (field.type === "tel" || /phone|mobile|tel\b/.test(hay)) return "Phone";
  if (field.type === "url" || /website|url|domain|https?:|www\./.test(hay)) return "Website";
  if (/organi[sz]ation|company|business/.test(hay)) return "Company";
  if (/message|comment|enquiry|inquiry|details/.test(hay) || field.type === "textarea") return "Message";
  if (/name/.test(hay)) return "Full name";
  if (placeholder && FIELD_WORDS.test(placeholder)) return placeholder;
  return humanize(field.name || "") || "Your answer";
}

function fieldType(raw: string, label: string, name: string): CompetitorFormField["type"] {
  const type = raw.toLowerCase();
  if (type === "radio" || type === "checkbox" || type === "select" || type === "textarea") return type;
  if (type === "email" || type === "tel" || type === "url" || type === "number") return type;
  if (type === "date" || type === "time") return "text";
  const hay = `${label} ${name}`.toLowerCase();
  if (/e-?mail/.test(hay)) return "email";
  if (/phone|mobile/.test(hay)) return "tel";
  if (/^website|website url|site url|\burl\b/.test(hay)) return "url";
  return "text";
}

function formFromRaw(raw: RawForm, id: string, frameUrl: string | null): BlueprintForm {
  const fields: CompetitorFormField[] = raw.fields.map((field, index) => {
    const label = resolveFieldLabel(field);
    const type = fieldType(field.type, label, field.name);
    const placeholder =
      field.placeholder && field.placeholder !== label ? field.placeholder : undefined;
    return {
      label,
      name: (field.name || `field_${index + 1}`).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40),
      type,
      required: field.required,
      placeholder,
      options: field.options?.length ? field.options.slice(0, 16) : undefined,
    };
  });
  const perRow = raw.style?.perRow || 1;
  const layout: CompetitorFormSpec["layout"] =
    perRow >= 2 ? "two-column" : fields.some((f) => f.type === "textarea") ? "stacked-wide" : "single-column";
  let steps = raw.steps;
  let partialSteps = false;
  const titles = raw.stepTitles || [];
  // One step at a time only when some fields are out of view or a Next button exists.
  const multiStep =
    Boolean(raw.nextLabel) ||
    (raw.fields.some((f) => f.visible) && raw.fields.some((f) => !f.visible) && steps.length + titles.length >= 2);
  const mode: BlueprintForm["mode"] = multiStep ? "multi-step" : steps.length >= 2 ? "grouped" : "single";
  if (titles.length >= steps.length) {
    steps = steps.map((step, index) => ({ ...step, title: step.title || titles[index] || null }));
  }
  if (multiStep && titles.length >= 2 && titles.length > steps.filter((s) => s.title).length) {
    // The step bar names more steps than the page renders at once. Keep the
    // fields we can see on the steps they belong to; later steps are known
    // by title only.
    const shown = raw.fields.filter((f) => f.visible).map((f) => f.name || f.label);
    steps = titles.map((title, index) => ({
      title,
      fields: steps[index]?.fields?.length ? steps[index].fields : index === 0 ? shown : [],
    }));
    partialSteps = steps.some((s) => !s.fields.length);
  }
  const booking = /calendly|acuityscheduling|youcanbook|savvycal|cal\.com/i.test(frameUrl || "") || raw.provider === "calendly";
  return {
    id,
    sectionId: null,
    hidden: raw.hidden,
    provider: raw.provider || (frameUrl ? hostLabel(frameUrl) : null),
    booking,
    fields: fields.slice(0, 24),
    submitLabel: (raw.submitLabel || "Submit").slice(0, 48),
    nextLabel: raw.nextLabel,
    layout,
    heading: raw.heading,
    intro: raw.intro,
    steps,
    mode,
    partialSteps,
    consent: raw.consent,
    style: raw.style,
  };
}

function hostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// ——— section kinds ———

export function classifySection(section: Pick<BlueprintSection, "order" | "heading" | "blocks" | "layout" | "media" | "faq" | "hasFormControls" | "wordCount">, formInside: boolean): SectionKind {
  const text = `${section.heading || ""} ${section.blocks.slice(0, 6).map((b) => b.text).join(" ")}`.toLowerCase();
  const roles = section.blocks.map((b) => b.role);
  if (section.order === 0) return "hero";
  if (formInside) return "form";
  if (section.faq || /frequently asked|faqs?\b|common questions/.test(text)) return "faq";
  if (section.media.logos >= 4 && section.wordCount < 60) return "logos";
  if (roles.filter((r) => r === "stat").length >= 3) return "stats";
  if (/pricing|packages?|plans?\b|per month|\/mo\b/.test(text)) return "pricing";
  if (/testimonial|review|what (our )?clients|say about|case stud|results|success stor/.test(text) || roles.filter((r) => r === "quote").length >= 2) {
    return "testimonials";
  }
  if (/how (it|we) work|process|steps?\b|\b(1|01)\b.*\b(2|02)\b/.test(text)) return "steps";
  if (section.layout.cards >= 3) return "features";
  if (section.wordCount < 45 && roles.includes("button")) return "cta";
  if (section.media.video || (section.media.position !== "none" && section.wordCount < 30)) return "media";
  return "content";
}

// ——— backgrounds ———

/** Average lightness of a CSS gradient's colour stops, blended over white (0 dark – 1 light). */
export function gradientLightness(image: string | null | undefined): number | null {
  const stops = String(image || "").match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}\b/gi) || [];
  if (!stops.length) return null;
  const lum = (r: number, g: number, b: number) => {
    const t = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * t(r) + 0.7152 * t(g) + 0.0722 * t(b);
  };
  const values = stops.map((stop) => {
    let r = 255, g = 255, b = 255, a = 1;
    if (stop.startsWith("#")) {
      const h = stop.slice(1);
      const full = h.length <= 4 ? h.split("").map((c) => c + c).join("") : h;
      r = parseInt(full.slice(0, 2), 16);
      g = parseInt(full.slice(2, 4), 16);
      b = parseInt(full.slice(4, 6), 16);
      a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
    } else {
      const p = stop.replace(/rgba?\(|\)/g, "").split(/[\s,/]+/).filter(Boolean).map(Number);
      [r, g, b] = p;
      a = p.length > 3 ? p[3] : 1;
    }
    // Over a white page.
    return lum(r * a + 255 * (1 - a), g * a + 255 * (1 - a), b * a + 255 * (1 - a));
  });
  return values.reduce((x, y) => x + y, 0) / values.length;
}

// ——— crops ———

async function cropJpeg(full: Buffer, meta: { width: number; height: number }, bounds: { y: number; height: number }): Promise<string | null> {
  const top = Math.max(0, Math.min(meta.height - 1, Math.round(bounds.y)));
  const height = Math.max(1, Math.min(meta.height - top, Math.round(bounds.height)));
  if (height < 24) return null;
  try {
    let image = sharp(full).extract({ left: 0, top, width: meta.width, height });
    if (height > MAX_CROP_HEIGHT) image = image.resize({ height: MAX_CROP_HEIGHT });
    let quality = 70;
    let out = await image.jpeg({ quality, mozjpeg: true }).toBuffer();
    while (out.length > MAX_CROP_BYTES && quality > 38) {
      quality -= 10;
      out = await sharp(out).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    return out.toString("base64");
  } catch {
    return null;
  }
}

// ——— capture ———

async function settle(page: Page): Promise<void> {
  await page.addStyleTag({ content: REVEAL_CSS }).catch(() => undefined);
  // Scroll through once so lazy images, forms and sections render.
  await page
    .evaluate(async () => {
      const max = Math.min(document.documentElement.scrollHeight, 30_000);
      for (let y = 0; y < max; y += 600) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      window.scrollTo(0, 0);
    })
    .catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

/** Hide cookie bars, chat bubbles and pop-ups so they do not cover crops. */
async function hideOverlays(page: Page): Promise<void> {
  await page
    .evaluate(`(function(){
      var all = document.querySelectorAll('body *');
      for (var i = 0; i < all.length; i++) {
        var el = all[i]; var s = getComputedStyle(el);
        if ((s.position === 'fixed' || s.position === 'sticky') && el.tagName !== 'HEADER' && !el.querySelector('nav')) el.style.setProperty('display', 'none', 'important');
        if (s.position === 'fixed' || s.position === 'sticky') el.style.setProperty('position', 'absolute', 'important');
      }
    })()`)
    .catch(() => undefined);
}

async function formsInFrames(page: Page, warnings: string[]): Promise<Array<{ raw: RawForm; frameUrl: string | null; frameBounds: RawForm["bounds"] | null }>> {
  const out: Array<{ raw: RawForm; frameUrl: string | null; frameBounds: RawForm["bounds"] | null }> = [];
  for (const frame of page.frames()) {
    const isMain = frame === page.mainFrame();
    let frameBounds: RawForm["bounds"] | null = null;
    if (!isMain) {
      try {
        const handle = await frame.frameElement();
        const bb = await handle.boundingBox();
        if (!bb || bb.width < 120 || bb.height < 80) continue;
        const scrollY = await page.evaluate(() => window.scrollY);
        frameBounds = { x: Math.round(bb.x), y: Math.round(bb.y + scrollY), width: Math.round(bb.width), height: Math.round(bb.height) };
      } catch {
        continue;
      }
    }
    try {
      const forms = (await frame.evaluate(FORM_PROBE_SCRIPT)) as RawForm[];
      for (const raw of forms) out.push({ raw, frameUrl: isMain ? null : frame.url(), frameBounds });
      if (!isMain && !forms.length && /calendly|typeform|leadconnector|msgsndr|hubspot|jotform/i.test(frame.url())) {
        out.push({
          raw: {
            index: 0,
            hidden: false,
            bounds: frameBounds!,
            provider: hostLabel(frame.url()),
            heading: null,
            intro: null,
            submitLabel: null,
            nextLabel: null,
            steps: [],
            consent: false,
            fields: [],
            style: null,
          },
          frameUrl: frame.url(),
          frameBounds,
        });
      }
    } catch (err) {
      if (!isMain) warnings.push(`Embedded form in ${hostLabel(frame.url()) || "a frame"} could not be read.`);
      else warnings.push(`Forms could not be read: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
    }
  }
  return out;
}

/** Capture a blueprint from a page that is already open (tests use setContent). */
export async function captureBlueprintFromPage(page: Page, sourceUrl: string): Promise<CompetitorBlueprint> {
  const warnings: string[] = [];
  await settle(page);
  const rawForms = await formsInFrames(page, warnings);
  await hideOverlays(page);
  const probe = (await page.evaluate(BLUEPRINT_PROBE_SCRIPT)) as RawProbe;

  let full: Buffer | null = null;
  let meta: { width: number; height: number } | null = null;
  try {
    full = await page.screenshot({ fullPage: true, type: "png" });
    const m = await sharp(full).metadata();
    meta = { width: m.width || VIEWPORT.width, height: m.height || 0 };
  } catch (err) {
    warnings.push(`Section screenshots failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
  }
  const crop = async (bounds: { y: number; height: number } | null | undefined) =>
    full && meta && bounds ? cropJpeg(full, meta, bounds) : null;

  const sections: BlueprintSection[] = [];
  for (const [index, raw] of probe.sections.entries()) {
    // Dot and grid textures (1–3px stops) are decoration on a light page, not a band.
    const pattern = raw.background.kind === "gradient" && /\b[0-3](\.\d+)?px\b/.test(raw.background.image || "");
    const light = raw.background.kind === "gradient" ? (pattern ? 1 : gradientLightness(raw.background.image)) : null;
    sections.push({
      ...raw,
      // A faint glow on a light page is a wash, not a colour band.
      background: light !== null && light > 0.72 ? { ...raw.background, kind: "wash" } : raw.background,
      id: `sec-${index + 1}`,
      kind: "content",
      formId: null,
      crop: await crop(raw.bounds),
    });
  }

  // Forms: visible ones first; pop-up forms only when nothing is visible.
  const forms: BlueprintForm[] = [];
  rawForms.forEach((entry, index) => {
    const form = formFromRaw(entry.raw, `form-${index + 1}`, entry.frameUrl);
    if (!form.fields.length && !form.booking && !entry.frameUrl) return;
    const bounds = entry.frameBounds || entry.raw.bounds;
    const centre = bounds.y + bounds.height / 2;
    const owner =
      sections.find((s) => centre >= s.bounds.y && centre <= s.bounds.y + s.bounds.height) ||
      (entry.raw.hidden ? null : sections.find((s) => Math.abs(s.bounds.y - bounds.y) < 200) || null);
    form.sectionId = entry.raw.hidden ? null : owner?.id || null;
    forms.push(form);
  });
  const visibleForms = forms.filter((f) => !f.hidden && (f.fields.length >= 1 || f.booking));
  const usable = (visibleForms.length ? visibleForms : forms.filter((f) => f.fields.length >= 2))
    // A footer newsletter box is not the lead form.
    .filter((f) => !(f.fields.length === 1 && f.fields[0].type === "email" && visibleForms.length > 1));
  for (const form of usable) {
    const owner = sections.find((s) => s.id === form.sectionId);
    if (owner && !owner.formId) owner.formId = form.id;
  }
  for (const section of sections) {
    section.kind = classifySection(section, Boolean(section.formId));
  }

  const header = probe.header ? { ...probe.header, crop: await crop(probe.header.bounds) } : null;
  const footer = probe.footer ? { ...probe.footer, crop: await crop(probe.footer.bounds) } : null;

  if (sections.length < 2) warnings.push("Fewer than two page sections were found in the rendered page.");
  return {
    url: sourceUrl,
    finalUrl: probe.url,
    title: probe.title,
    capturedAt: new Date().toISOString(),
    viewport: probe.viewport,
    pageHeight: probe.pageHeight,
    sections,
    forms: usable,
    shape: probe.shape,
    header,
    footer,
    warnings,
  };
}

/** Open the competitor page in Chromium and capture its blueprint. */
export async function captureCompetitorBlueprint(
  sourceUrl: string,
  options: { timeoutMs?: number; browser?: Browser } = {},
): Promise<CompetitorBlueprint> {
  const url = await assertPublicHttpUrl(sourceUrl);
  const { launchChromium } = await import("../content/playwrightRuntime");
  const browser = options.browser || (await launchChromium());
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const run = async () => {
    const page = await context.newPage();
    const response = await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!response || response.status() >= 400) {
      throw new Error(`The competitor page responded ${response?.status() || "without a document"}.`);
    }
    await page.waitForLoadState("load", { timeout: 12_000 }).catch(() => undefined);
    return captureBlueprintFromPage(page, sourceUrl);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Competitor capture timed out.")), options.timeoutMs || 90_000),
      ),
    ]);
  } finally {
    await context.close().catch(() => undefined);
    if (!options.browser) await browser.close().catch(() => undefined);
  }
}

// ——— adapters for the rest of the pipeline ———

function componentsOf(section: BlueprintSection, form: BlueprintForm | null): InventoryComponent[] {
  const components: InventoryComponent[] = [];
  let list: InventoryComponent | null = null;
  section.blocks.forEach((block, index) => {
    const id = `${section.id}-${index + 1}`;
    if (/^h[1-3]$/.test(block.role)) {
      components.push({ id, kind: "headline", text: block.text, items: [] });
      list = null;
    } else if (block.role === "li" || block.role === "h4" || block.role === "h5" || block.role === "h6" || block.role === "stat") {
      if (!list) {
        list = { id, kind: section.kind === "faq" ? "faq" : block.role === "stat" ? "proof" : "list", text: "", items: [] };
        components.push(list);
      }
      list.items.push(block.text);
    } else if (block.role === "button") {
      components.push({ id, kind: "cta", text: block.text, items: [] });
    } else if (block.role === "quote") {
      components.push({ id, kind: "proof", text: block.text, items: [] });
    } else if (block.role !== "link") {
      components.push({ id, kind: "paragraph", text: block.text, items: [] });
    }
  });
  if (form) {
    components.push({
      id: `${section.id}-form`,
      kind: "form",
      text: "Lead form (rebuilt from the competitor's fields)",
      items: form.fields.map((f) => `${f.label}|${f.type}${f.required ? "|required" : ""}`),
    });
  }
  return components;
}

const KIND_PURPOSE: Record<SectionKind, string> = {
  hero: "Hero: headline, offer and primary call to action",
  logos: "Trust strip of client or partner logos",
  stats: "Proof in numbers",
  features: "Services or benefits in repeated cards",
  steps: "How it works, step by step",
  testimonials: "Social proof: reviews, results or case studies",
  faq: "Frequently asked questions",
  pricing: "Packages or pricing",
  form: "Lead form section",
  cta: "Call-to-action band",
  media: "Visual or video band",
  content: "Supporting content",
};

/** The blueprint as the inventory the brief and chrome builders already use. */
export function inventoryFromBlueprint(blueprint: CompetitorBlueprint): PageInventory {
  const sections: InventorySection[] = blueprint.sections.map((section) => {
    const form = blueprint.forms.find((f) => f.id === section.formId) || null;
    return {
      id: section.id,
      order: section.order,
      sourceHeading: section.heading,
      internalLabel: section.heading || KIND_PURPOSE[section.kind],
      purpose: KIND_PURPOSE[section.kind],
      textKind: "rendered",
      components: componentsOf(section, form),
      gaps: [],
      box: { ...section.bounds, viewport: "desktop" },
      cropRef: section.crop ? section.id : null,
    };
  });
  return {
    captureId: `bp-${Date.now()}`,
    sourceUrl: blueprint.url,
    finalUrl: blueprint.finalUrl,
    capturedAt: blueprint.capturedAt,
    viewports: [{ name: "desktop", ...blueprint.viewport }],
    sections,
    gaps: blueprint.warnings,
    coverage: {
      visualRegions: sections.length,
      mapped: sections.filter((s) => s.components.length >= 2).length,
      unresolved: sections.filter((s) => s.components.length < 2).length,
    },
    visionUsed: blueprint.sections.some((s) => Boolean(s.crop)),
  };
}

/** The lead form to rebuild: the competitor's main visible form. */
export function primaryBlueprintForm(blueprint: CompetitorBlueprint | null | undefined): BlueprintForm | null {
  if (!blueprint?.forms.length) return null;
  const placed = blueprint.forms.filter((f) => f.sectionId);
  const pool = placed.length ? placed : blueprint.forms;
  return [...pool].sort((a, b) => b.fields.length - a.fields.length)[0] || null;
}

/** Enough of a capture to build from. */
export function isUsableBlueprint(blueprint: CompetitorBlueprint | null | undefined): blueprint is CompetitorBlueprint {
  return Boolean(blueprint && blueprint.sections.length >= 2 && blueprint.sections.some((s) => s.wordCount >= 20));
}
