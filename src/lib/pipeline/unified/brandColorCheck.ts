import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import { captureCompetitorScreenshotTiles, prepareVisionImage } from "../competitorScreenshots";
import type { BrandColors } from "../../types";

/**
 * Before a page is built, look at the client's own website and confirm the
 * brand palette. Firecrawl's extracted colours are sometimes wrong: a colour
 * from a photo, a partner logo or a cookie banner, or primary and accent
 * swapped. The site is opened in a browser, screenshotted, and the colours it
 * really uses on buttons, headings and bands are measured; Claude compares
 * those with the extracted palette and corrects it.
 */

const HEX = /^#[0-9A-F]{6}$/i;
/** A palette checked this recently on the same site is not checked again. */
const RECHECK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const VISUAL_TAG = "visual-check";

export type ColorSwatch = { role: string; hex: string; weight: number };

export type BrandColorCheck = {
  colors: BrandColors;
  /** Roles whose colour changed. */
  changed: string[];
  notes: string | null;
  /** True when the check ran (screenshots and a review); false when it was skipped or failed. */
  checked: boolean;
};

// Runs in the page: the colours the site actually paints, by role and weight.
const SWATCH_SCRIPT = String.raw`(function(){
  var out = {};
  function hexOf(c){ var m = String(c || '').match(/rgba?\(([^)]+)\)/); if (!m) return null; var p = m[1].split(/[ ,\/]+/).filter(Boolean).map(parseFloat); if (p.length > 3 && p[3] < 0.5) return null; return '#' + p.slice(0, 3).map(function(v){ return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('').toUpperCase(); }
  function add(role, c, w){ var h = hexOf(c); if (!h) return; var k = role + '|' + h; out[k] = (out[k] || 0) + (w || 1); }
  function gradient(role, img, w){ (String(img || '').match(/rgba?\([^)]+\)/g) || []).forEach(function(c){ add(role, c, w); }); }
  function vis(el){ var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.1; }
  add('page-background', getComputedStyle(document.body).backgroundColor || getComputedStyle(document.documentElement).backgroundColor, 6);
  add('body-text', getComputedStyle(document.body).color, 4);
  document.querySelectorAll('p').forEach(function(el, i){ if (i < 60 && vis(el)) add('body-text', getComputedStyle(el).color, 0.2); });
  document.querySelectorAll('h1,h2,h3').forEach(function(el){ if (vis(el)) add('heading-text', getComputedStyle(el).color, 1.5); });
  document.querySelectorAll('a,button,[role=button],input[type=submit]').forEach(function(el){
    if (!vis(el)) return;
    var s = getComputedStyle(el); var r = el.getBoundingClientRect();
    var filled = hexOf(s.backgroundColor) && r.width * r.height > 1200;
    if (filled) add('button-background', s.backgroundColor, 3);
    else if (s.backgroundImage && s.backgroundImage !== 'none' && r.width * r.height > 1200) gradient('button-gradient', s.backgroundImage, 3);
    else add('link-text', s.color, 0.5);
    if (filled || (s.backgroundImage && s.backgroundImage !== 'none')) add('button-text', s.color, 1);
  });
  document.querySelectorAll('header, nav, footer, section, main > div').forEach(function(el){
    if (!vis(el)) return;
    var s = getComputedStyle(el); var r = el.getBoundingClientRect();
    var role = el.tagName === 'HEADER' || el.tagName === 'NAV' ? 'header-background' : el.tagName === 'FOOTER' ? 'footer-background' : 'band-background';
    var w = Math.min(5, (r.width * r.height) / 250000);
    add(role, s.backgroundColor, w);
    if (s.backgroundImage && /gradient/.test(s.backgroundImage)) gradient(role + '-gradient', s.backgroundImage, w);
  });
  return Object.keys(out).map(function(k){ var parts = k.split('|'); return { role: parts[0], hex: parts[1], weight: Math.round(out[k] * 10) / 10 }; })
    .sort(function(a, b){ return b.weight - a.weight; }).slice(0, 40);
})()`;

/** Screenshots of the client's site (top of the page and further down) and the colours it paints. */
export async function captureSite(url: string): Promise<{ images: Array<{ data: string; label: string }>; swatches: ColorSwatch[]; warnings: string[] }> {
  const warnings: string[] = [];
  const images: Array<{ data: string; label: string }> = [];
  let swatches: ColorSwatch[] = [];
  try {
    const { launchChromium } = await import("../content/playwrightRuntime");
    const browser = await launchChromium();
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      swatches = ((await page.evaluate(SWATCH_SCRIPT).catch(() => [])) as ColorSwatch[]) || [];
      const fold = await page.screenshot({ type: "png", timeout: 20_000 });
      const foldImage = await prepareVisionImage(fold);
      if (foldImage) images.push({ data: foldImage.data, label: "Top of the client's website (header, hero, main button)" });
      // Further down the page: bands, cards and the footer often show the second colour.
      const height = Number(await page.evaluate("document.documentElement.scrollHeight").catch(() => 0)) || 0;
      if (height > 1400) {
        const full = await page.screenshot({ type: "png", fullPage: true, timeout: 30_000 }).catch(() => null);
        const fullImage = full ? await prepareVisionImage(full) : null;
        if (fullImage) images.push({ data: fullImage.data, label: "The whole page, scaled down (bands, cards, footer)" });
      }
      await page.close().catch(() => undefined);
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    warnings.push(`Browser capture failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 140)}`);
  }
  // Without a browser, a Firecrawl screenshot still lets the colours be seen.
  if (!images.length) {
    const shots = await captureCompetitorScreenshotTiles(url, { foldOnly: false }).catch(() => null);
    for (const tile of shots?.tiles || []) images.push({ data: tile.data, label: tile.label.replace(/competitor/gi, "client") });
    if (shots?.warnings.length) warnings.push(...shots.warnings.slice(0, 2));
  }
  return { images, swatches, warnings };
}

function luminance(hex: string): number {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

const SYSTEM = `You verify a business's brand colour palette by looking at its own website.

You get screenshots of the site, the colours measured in the page (by role, with how much of the page uses them), and a palette extracted automatically. The automatic palette is often wrong: it may take a colour from a photo, a client or partner logo, a cookie banner or an off-brand link, or swap the roles.

Decide each role from what the site really shows:
- primary: the main brand colour, used on the logo, the main buttons/calls to action and key highlights.
- secondary: the second brand colour, often dark bands, the header or footer, or secondary buttons. If the brand has one colour, use the darker neutral the site pairs it with.
- accent: the colour for small highlights (badges, icons, underlines). It may equal primary.
- background: the main page background.
- text: the main body text colour.

Use exact hex values from the measured colours whenever one matches what you see; only estimate a hex from the screenshot when nothing measured matches. Never pick colours from photographs or other companies' logos.

Return ONLY JSON: { "primary": "#RRGGBB", "secondary": "#RRGGBB", "accent": "#RRGGBB", "background": "#RRGGBB", "text": "#RRGGBB", "confidence": 0-1, "notes": "one or two sentences on what you changed and why" }`;

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Whether this palette was already checked on this site recently. */
export function recentlyChecked(colors: BrandColors | null | undefined, siteUrl: string): boolean {
  if (!colors?.source?.includes(VISUAL_TAG) || !colors.checkedAt) return false;
  if (Date.now() - Date.parse(colors.checkedAt) > RECHECK_AFTER_MS) return false;
  const host = (u: string | null | undefined) => {
    try {
      return new URL(String(u)).hostname.replace(/^www\./i, "").toLowerCase();
    } catch {
      return "";
    }
  };
  return !colors.checkedUrl || host(colors.checkedUrl) === host(siteUrl);
}

/**
 * Check the extracted palette against the client's website and return the
 * corrected one. On any failure the extracted palette is returned unchanged.
 */
export async function verifyBrandColors(input: {
  siteUrl: string;
  businessName: string;
  colors: BrandColors;
  force?: boolean;
}): Promise<BrandColorCheck> {
  const unchanged = (notes: string | null): BrandColorCheck => ({ colors: input.colors, changed: [], notes, checked: false });
  if (!input.force && recentlyChecked(input.colors, input.siteUrl)) return unchanged("Checked on the website recently.");
  if (!process.env.ANTHROPIC_API_KEY) return unchanged(null);

  const site = await captureSite(input.siteUrl);
  if (!site.images.length) return unchanged(`The website could not be screenshotted (${site.warnings[0] || "no image"}).`);

  const content: Array<Record<string, unknown>> = [];
  site.images.forEach((image, i) => {
    content.push({ type: "text", text: `Image ${i + 1}: ${image.label}.` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image.data } });
  });
  content.push({
    type: "text",
    text: JSON.stringify({
      business: input.businessName,
      website: input.siteUrl,
      measuredColours: site.swatches,
      extractedPalette: {
        primary: input.colors.primary,
        secondary: input.colors.secondary,
        accent: input.colors.accent,
        background: input.colors.background,
        text: input.colors.text,
      },
    }),
  });

  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: getAnthropicModel(),
        max_tokens: 500,
        system: SYSTEM,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: content as any }],
      },
      { timeout: 120_000 },
    );
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const json = extractJson(text);
    if (!json) return unchanged("The colour check gave no usable answer.");
    const confidence = Number(json.confidence);
    if (Number.isFinite(confidence) && confidence < 0.4) return unchanged("The colour check was unsure, so the extracted palette was kept.");

    const pick = (role: "primary" | "secondary" | "accent" | "background" | "text") => {
      const value = String(json[role] || "").trim();
      return HEX.test(value) ? value.toUpperCase() : input.colors[role];
    };
    const next: BrandColors = {
      ...input.colors,
      primary: pick("primary"),
      secondary: pick("secondary"),
      accent: pick("accent"),
      background: pick("background"),
      text: pick("text"),
    };
    // Body text must stay readable on the background.
    if (contrastRatio(next.text, next.background) < 4.5) {
      next.text = input.colors.text;
      next.background = input.colors.background;
    }
    const changed = (["primary", "secondary", "accent", "background", "text"] as const).filter(
      (role) => next[role].toUpperCase() !== String(input.colors[role] || "").toUpperCase(),
    );
    next.source = `${(input.colors.source || "extracted").replace(/\+?visual-check$/, "")}+${VISUAL_TAG}`;
    next.checkedAt = new Date().toISOString();
    next.checkedUrl = input.siteUrl;
    return { colors: next, changed: [...changed], notes: typeof json.notes === "string" ? json.notes.slice(0, 300) : null, checked: true };
  } catch (err) {
    console.warn("[brand colours] check failed", err instanceof Error ? err.message.slice(0, 160) : err);
    return unchanged("The colour check could not run.");
  }
}
