import type { BrandColors } from "../types";
import {
  luminance,
  normalizeHex,
  parseCssColorToHex,
  saturation,
} from "./brandColors";
import {
  harmonizeBrandPalette,
  isJunkBrandHex,
  isWeakOrJunkPalette,
  pickStrongestBrandHex,
} from "./paletteHarmonize";
import { fetchRawLandingHtml } from "./htmlFetch";
import {
  extractBrandAssetsFromHtml,
  type BrandSiteAssets,
} from "./brandAssets";
import {
  extractColorsViaFirecrawl,
  isChallengeOrEmptyHtml,
} from "./brandColorSources";

export type DeterministicBrandResult = {
  colors: BrandColors | null;
  assets: BrandSiteAssets | null;
  finalUrl: string;
  method:
    | "theme-color"
    | "css-vars"
    | "manifest"
    | "logo-vibrant"
    | "markup-hex"
    | "combined"
    | "none";
  warnings: string[];
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function absolutize(baseUrl: string, value: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function cleanHex(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parsed = parseCssColorToHex(raw.trim()) || normalizeHex(raw.trim());
  if (!parsed || isJunkBrandHex(parsed)) return null;
  return parsed;
}

/**
 * Explicit brand tokens from HTML: theme-color, apple status bar, CSS vars.
 */
export function extractDeclaredBrandTokens(html: string): {
  themeColor: string | null;
  cssPrimary: string | null;
  cssSecondary: string | null;
  cssAccent: string | null;
  cssBg: string | null;
  cssText: string | null;
  evidence: string[];
} {
  const evidence: string[] = [];
  let themeColor: string | null = null;
  let cssPrimary: string | null = null;
  let cssSecondary: string | null = null;
  let cssAccent: string | null = null;
  let cssBg: string | null = null;
  let cssText: string | null = null;

  for (const m of html.matchAll(
    /<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["'][^>]*>/gi,
  )) {
    themeColor = cleanHex(m[1]) || themeColor;
  }
  for (const m of html.matchAll(
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["'][^>]*>/gi,
  )) {
    themeColor = cleanHex(m[1]) || themeColor;
  }
  for (const m of html.matchAll(
    /<meta[^>]+name=["']msapplication-TileColor["'][^>]*content=["']([^"']+)["']/gi,
  )) {
    themeColor = themeColor || cleanHex(m[1]);
  }
  if (themeColor) evidence.push(themeColor);

  // CSS custom properties that look like brand tokens
  const varRules: Array<{ re: RegExp; slot: "primary" | "secondary" | "accent" | "bg" | "text" }> =
    [
      {
        re: /--[\w-]*(?:brand-?primary|color-?primary|primary-?color|primary|brand|main|theme)[\w-]*\s*:\s*([^;!}{]+)/gi,
        slot: "primary",
      },
      {
        re: /--[\w-]*(?:secondary|brand-?secondary|color-?secondary)[\w-]*\s*:\s*([^;!}{]+)/gi,
        slot: "secondary",
      },
      {
        re: /--[\w-]*(?:accent|cta|highlight|link)[\w-]*\s*:\s*([^;!}{]+)/gi,
        slot: "accent",
      },
      {
        re: /--[\w-]*(?:background|bg|surface|canvas)[\w-]*\s*:\s*([^;!}{]+)/gi,
        slot: "bg",
      },
      {
        re: /--[\w-]*(?:text|foreground|ink|body-color)[\w-]*\s*:\s*([^;!}{]+)/gi,
        slot: "text",
      },
    ];

  for (const { re, slot } of varRules) {
    for (const m of html.matchAll(re)) {
      const hex = cleanHex(m[1]);
      if (!hex) continue;
      evidence.push(hex);
      if (slot === "primary" && !cssPrimary) cssPrimary = hex;
      if (slot === "secondary" && !cssSecondary) cssSecondary = hex;
      if (slot === "accent" && !cssAccent) cssAccent = hex;
      if (slot === "bg" && !cssBg && luminance(hex) > 0.8) cssBg = hex;
      if (slot === "text" && !cssText && luminance(hex) < 0.35) cssText = hex;
    }
  }

  return {
    themeColor,
    cssPrimary,
    cssSecondary,
    cssAccent,
    cssBg,
    cssText,
    evidence: [...new Set(evidence)],
  };
}

/**
 * Fetch web app manifest and read theme_color / background_color.
 */
export async function extractManifestColors(
  html: string,
  baseUrl: string,
): Promise<{ themeColor: string | null; background: string | null; evidence: string[] }> {
  const evidence: string[] = [];
  let themeColor: string | null = null;
  let background: string | null = null;

  const hrefMatch =
    html.match(
      /<link[^>]+rel=["']manifest["'][^>]*href=["']([^"']+)["']/i,
    ) ||
    html.match(
      /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']manifest["']/i,
    );
  if (!hrefMatch?.[1]) {
    return { themeColor, background, evidence };
  }
  const manifestUrl = absolutize(baseUrl, hrefMatch[1]);
  if (!manifestUrl) return { themeColor, background, evidence };

  try {
    const res = await fetch(manifestUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: "application/manifest+json,application/json,*/*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) return { themeColor, background, evidence };
    const data = (await res.json()) as {
      theme_color?: string;
      background_color?: string;
    };
    themeColor = cleanHex(data.theme_color || "");
    background = cleanHex(data.background_color || "");
    if (themeColor) evidence.push(themeColor);
    if (background) evidence.push(background);
  } catch {
    // ignore
  }
  return { themeColor, background, evidence };
}

function isRasterImageBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return true;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
  // WEBP (RIFF....WEBP)
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return true;
  return false;
}

async function fetchImageBufferDirect(logoUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(logoUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
        "User-Agent": BROWSER_UA,
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (/svg|html|text\//i.test(ct) || /\.svg(\?|$)/i.test(logoUrl)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!isRasterImageBuffer(buf)) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Run node-vibrant against a logo/favicon image URL or buffer.
 */
export async function extractPaletteFromLogoUrl(
  logoUrl: string,
  prefetched?: Buffer | null,
): Promise<{
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  muted: string | null;
  evidence: string[];
} | null> {
  try {
    if (/\.svg(\?|$)/i.test(logoUrl)) return null;
    const buf = prefetched || (await fetchImageBufferDirect(logoUrl));
    if (!buf || buf.length < 200 || !isRasterImageBuffer(buf)) return null;

    const { Vibrant } = await import("node-vibrant/node");
    const palette = await Vibrant.from(buf).getPalette();

    const hexOf = (key: string): string | null => {
      const swatch = (palette as Record<string, { hex?: string } | null>)[key];
      return cleanHex(swatch?.hex || "");
    };

    const vibrant = hexOf("Vibrant");
    const darkVibrant = hexOf("DarkVibrant");
    const lightVibrant = hexOf("LightVibrant");
    const muted = hexOf("Muted");
    const darkMuted = hexOf("DarkMuted");

    const primary =
      pickStrongestBrandHex([vibrant, darkVibrant, lightVibrant]) || vibrant;
    const secondary = darkVibrant || darkMuted || muted || primary;
    const accent = lightVibrant || vibrant || primary;
    const evidence = [vibrant, darkVibrant, lightVibrant, muted, darkMuted].filter(
      (h): h is string => Boolean(h),
    );

    if (!primary) return null;
    return {
      primary,
      secondary: secondary && !isJunkBrandHex(secondary) ? secondary : primary,
      accent: accent && !isJunkBrandHex(accent) ? accent : primary,
      muted: muted && saturation(muted) < 0.35 ? muted : null,
      evidence,
    };
  } catch (err) {
    console.warn("[brand-deterministic] Vibrant logo extract failed", err);
    return null;
  }
}

function collectStylesheetUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const push = (href: string | null | undefined) => {
    if (!href || href.startsWith("data:")) return;
    const abs = absolutize(baseUrl, href);
    if (abs && !out.includes(abs)) out.push(abs);
  };
  for (const m of html.matchAll(
    /<link[^>]+rel=["'][^"']*stylesheet[^"']*["'][^>]*href=["']([^"']+)["']/gi,
  )) {
    push(m[1]);
  }
  for (const m of html.matchAll(
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*stylesheet[^"']*["']/gi,
  )) {
    push(m[1]);
  }
  return out.slice(0, 12);
}

async function fetchStylesheetTexts(urls: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(12_000),
        headers: {
          Accept: "text/css,*/*;q=0.1",
          "User-Agent": BROWSER_UA,
        },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && text.length > 20) chunks.push(text.slice(0, 400_000));
    } catch {
      // ignore
    }
  }
  return chunks.join("\n");
}

type PlaywrightDeclaredAssist = {
  themeColor: string | null;
  cssPrimary: string | null;
  cssSecondary: string | null;
  cssAccent: string | null;
  cssBg: string | null;
  cssText: string | null;
  evidence: string[];
  logoBuffers: Array<{ url: string; buf: Buffer }>;
  finalUrl: string;
  warnings: string[];
};

/**
 * Playwright assist for deterministic tokens only:
 * - theme-color meta after styles load
 * - :root / html CSS custom properties
 * - logo image bytes (when direct fetch is bot-blocked)
 * Does NOT use screenshot dominant-color sampling.
 */
async function extractDeclaredViaPlaywright(
  urlInput: string,
  logoCandidates: string[],
): Promise<PlaywrightDeclaredAssist> {
  const warnings: string[] = [];
  const url = /^https?:\/\//i.test(urlInput.trim())
    ? urlInput.trim()
    : `https://${urlInput.trim()}`;

  const { chromium } = await import("playwright");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: BROWSER_UA,
      locale: "en-US",
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      warnings.push("Playwright CSS-assist: networkidle timeout");
    }
    await page.waitForTimeout(500);

    const finalUrl = page.url() || url;
    let fromPage: { themeMeta: string | null; found: Record<string, string> } = {
      themeMeta: null,
      found: {},
    };
    try {
      // Use string evaluate so tsx/esbuild __name helpers are not injected into the browser.
      fromPage = (await page.evaluate(`(() => {
      const clean = (raw) => {
        if (!raw) return null;
        const v = String(raw).trim();
        if (!v || v === "transparent" || v.startsWith("var(")) return null;
        return v;
      };

      const themeMeta =
        document
          .querySelector('meta[name="theme-color"]')
          ?.getAttribute("content") ||
        document
          .querySelector('meta[name="msapplication-TileColor"]')
          ?.getAttribute("content") ||
        null;

      const roots = [document.documentElement, document.body].filter(Boolean);
      const props = [
        "--brand-primary",
        "--color-primary",
        "--primary-color",
        "--primary",
        "--brand",
        "--theme-color",
        "--main-color",
        "--brand-secondary",
        "--color-secondary",
        "--secondary",
        "--accent",
        "--brand-accent",
        "--color-accent",
        "--cta",
        "--highlight",
        "--link-color",
        "--background",
        "--bg",
        "--surface",
        "--text",
        "--foreground",
        "--ink",
      ];

      const found = {};
      for (const el of roots) {
        const cs = getComputedStyle(el);
        for (const prop of props) {
          if (found[prop]) continue;
          const val = clean(cs.getPropertyValue(prop));
          if (val) found[prop] = val;
        }
      }

      try {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules = null;
          try {
            rules = sheet.cssRules;
          } catch (e) {
            continue;
          }
          if (!rules) continue;
          for (const rule of Array.from(rules)) {
            if (!rule.selectorText) continue;
            if (
              !/:root|html|body|\\.theme|\\[data-theme/i.test(rule.selectorText)
            )
              continue;
            const style = rule.style;
            if (!style) continue;
            for (let i = 0; i < style.length; i++) {
              const name = style.item(i);
              if (!name || !name.startsWith("--")) continue;
              if (
                !/(brand|primary|secondary|accent|cta|theme|main|link|background|bg|text|foreground)/i.test(
                  name,
                )
              )
                continue;
              if (found[name]) continue;
              const val = clean(style.getPropertyValue(name));
              if (val) found[name] = val;
            }
          }
        }
      } catch (e) {
        // cross-origin sheets may throw
      }

      return { themeMeta, found };
    })()`)) as { themeMeta: string | null; found: Record<string, string> };
    } catch (err) {
      warnings.push(
        `Playwright CSS var read failed: ${(err as Error).message || String(err)}`,
      );
    }

    const pickFound = (re: RegExp): string | null => {
      for (const [k, v] of Object.entries(fromPage.found)) {
        if (re.test(k)) return v;
      }
      return null;
    };

    const evidence: string[] = [];
    const themeColor = cleanHex(fromPage.themeMeta);
    const cssPrimary = cleanHex(
      pickFound(/primary|brand$|brand-color|theme|main/i) || null,
    );
    const cssSecondary = cleanHex(pickFound(/secondary/i) || null);
    const cssAccent = cleanHex(pickFound(/accent|cta|highlight|link/i) || null);
    const cssBg = cleanHex(pickFound(/background|^--bg$|surface/i) || null);
    const cssText = cleanHex(pickFound(/text|foreground|ink/i) || null);
    for (const h of [themeColor, cssPrimary, cssSecondary, cssAccent, cssBg, cssText]) {
      if (h) evidence.push(h);
    }

    const logoBuffers: Array<{ url: string; buf: Buffer }> = [];
    for (const logoUrl of logoCandidates.slice(0, 5)) {
      try {
        const res = await context.request.get(logoUrl, { timeout: 20_000 });
        if (!res.ok()) continue;
        const buf = Buffer.from(await res.body());
        if (!isRasterImageBuffer(buf)) continue;
        logoBuffers.push({ url: logoUrl, buf });
        break;
      } catch {
        // try next
      }
    }

    await context.close();
    warnings.push(
      `Playwright CSS-assist: theme=${themeColor || "—"} primary=${cssPrimary || "—"} accent=${cssAccent || "—"} logoBufs=${logoBuffers.length}`,
    );
    return {
      themeColor,
      cssPrimary,
      cssSecondary,
      cssAccent,
      cssBg,
      cssText,
      evidence,
      logoBuffers,
      finalUrl,
      warnings,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

function resolveLogoCandidates(
  assets: BrandSiteAssets | null,
  html: string,
  baseUrl: string,
): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u || u.startsWith("data:")) return;
    if (!out.includes(u)) out.push(u);
  };
  push(assets?.logoUrl || null);
  push(assets?.ogImageUrl || null);
  push(assets?.faviconUrl || null);

  // apple-touch-icon / icon links
  for (const m of html.matchAll(
    /<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]*href=["']([^"']+)["']/gi,
  )) {
    push(absolutize(baseUrl, m[1]));
  }
  for (const m of html.matchAll(
    /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'][^"']*icon[^"']*["']/gi,
  )) {
    push(absolutize(baseUrl, m[1]));
  }

  // CDN logo guesses
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./i, "");
    push(`https://logo.clearbit.com/${host}`);
  } catch {
    // ignore
  }

  return out.slice(0, 8);
}

/**
 * Last-resort deterministic signal: chromatic hex literals written in markup/CSS text.
 * Reproducible from the same HTML — not a screenshot judgment call.
 */
export function extractMarkupChromaticPalette(html: string): {
  primary: string | null;
  secondary: string | null;
  accent: string | null;
  evidence: string[];
} | null {
  const counts = new Map<string, number>();
  for (const m of html.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const hex = cleanHex(`#${m[1]}`);
    if (!hex) continue;
    if (luminance(hex) > 0.92 || luminance(hex) < 0.08) continue;
    if (saturation(hex) < 0.18) continue; // skip greys
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }
  // rgb()/hsl() literals
  for (const m of html.matchAll(
    /(?:rgba?|hsla?)\(\s*[^)]{3,40}\)/gi,
  )) {
    const hex = cleanHex(m[0]);
    if (!hex) continue;
    if (luminance(hex) > 0.92 || luminance(hex) < 0.08) continue;
    if (saturation(hex) < 0.18) continue;
    counts.set(hex, (counts.get(hex) || 0) + 1);
  }

  const ranked = [...counts.entries()]
    .map(([hex, count]) => ({
      hex,
      score: count * 10 + saturation(hex) * 8 + (1 - Math.abs(luminance(hex) - 0.45)) * 2,
    }))
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return null;
  const primary = ranked[0].hex;
  const accent =
    ranked.find((r) => r.hex !== primary && saturation(r.hex) > 0.35)?.hex ||
    primary;
  const secondary =
    ranked.find(
      (r) =>
        r.hex !== primary &&
        r.hex !== accent &&
        luminance(r.hex) < 0.35,
    )?.hex || null;

  return {
    primary,
    secondary,
    accent,
    evidence: ranked.slice(0, 8).map((r) => r.hex),
  };
}

/**
 * Deterministic brand palette:
 * 1) theme-color + CSS variables (HTML + linked stylesheets) + web manifest
 * 2) Playwright assist for computed :root CSS vars + logo bytes (no screenshot sampling)
 * 3) Vibrant.js on site logo / icons
 * Reproducible — no screenshot dominant-color guessing.
 */
export async function extractBrandColorsDeterministic(
  businessUrl: string,
): Promise<DeterministicBrandResult> {
  const warnings: string[] = [];
  let html: string | null = null;
  let finalUrl = businessUrl;
  let assets: BrandSiteAssets | null = null;
  let htmlLikelyBotBlocked = false;

  try {
    const fetched = await fetchRawLandingHtml(businessUrl);
    if (fetched.html && !isChallengeOrEmptyHtml(fetched.html)) {
      html = fetched.html;
      finalUrl = fetched.finalUrl;
      // Firecrawl bypasses WAF; Playwright from our IP usually still hits the shield
      if (fetched.source !== "direct") {
        htmlLikelyBotBlocked = true;
      }
      if (/sgcaptcha|cloudflare|cf-challenge|just a moment/i.test(fetched.html.slice(0, 2000))) {
        htmlLikelyBotBlocked = true;
      }
    } else {
      warnings.push("Direct HTML blocked/empty — trying Firecrawl for markup");
      htmlLikelyBotBlocked = true;
    }
  } catch (err) {
    warnings.push(`Direct fetch failed: ${(err as Error).message}`);
    htmlLikelyBotBlocked = true;
  }

  if (!html) {
    try {
      const fc = await extractColorsViaFirecrawl(businessUrl);
      warnings.push(...fc.warnings);
      if (fc.html && !isChallengeOrEmptyHtml(fc.html)) {
        html = fc.html;
        htmlLikelyBotBlocked = true;
      }
    } catch (err) {
      warnings.push(`Firecrawl markup failed: ${(err as Error).message}`);
    }
  }

  if (!html) {
    return {
      colors: null,
      assets: null,
      finalUrl,
      method: "none",
      warnings: [...warnings, "No HTML available for deterministic color extract"],
    };
  }

  try {
    assets = extractBrandAssetsFromHtml(html, finalUrl);
  } catch (err) {
    warnings.push(`Asset extract failed: ${(err as Error).message}`);
  }

  // Linked stylesheets often hold the real --brand-* tokens
  const sheetUrls = collectStylesheetUrls(html, finalUrl);
  let sheetCss = "";
  if (sheetUrls.length) {
    sheetCss = await fetchStylesheetTexts(sheetUrls);
    if (sheetCss) {
      warnings.push(`Fetched ${sheetUrls.length} stylesheet(s) for CSS vars`);
    }
  } else {
    warnings.push("No <link rel=stylesheet> in markup — may need Playwright CSS-assist");
  }

  const declaredHtml = extractDeclaredBrandTokens(html);
  const declaredCss = sheetCss
    ? extractDeclaredBrandTokens(sheetCss)
    : {
        themeColor: null,
        cssPrimary: null,
        cssSecondary: null,
        cssAccent: null,
        cssBg: null,
        cssText: null,
        evidence: [] as string[],
      };
  const manifest = await extractManifestColors(html, finalUrl);

  let theme =
    declaredHtml.themeColor ||
    declaredCss.themeColor ||
    manifest.themeColor ||
    null;
  let cssPrimary = declaredHtml.cssPrimary || declaredCss.cssPrimary;
  let cssSecondary = declaredHtml.cssSecondary || declaredCss.cssSecondary;
  let cssAccent = declaredHtml.cssAccent || declaredCss.cssAccent;
  let cssBg = declaredHtml.cssBg || declaredCss.cssBg || manifest.background;
  let cssText = declaredHtml.cssText || declaredCss.cssText;

  const evidence = [
    ...declaredHtml.evidence,
    ...declaredCss.evidence,
    ...manifest.evidence,
  ];

  const logos = resolveLogoCandidates(assets, html, finalUrl);
  let logoBuffers: Array<{ url: string; buf: Buffer }> = [];

  // Playwright assist when markup/CSS declarations are thin (and site is reachable)
  const needsCssAssist = !theme && !cssPrimary && !cssAccent;
  if (needsCssAssist && !htmlLikelyBotBlocked) {
    try {
      const assist = await extractDeclaredViaPlaywright(businessUrl, logos);
      warnings.push(...assist.warnings);
      if (assist.finalUrl) finalUrl = assist.finalUrl;
      theme = theme || assist.themeColor;
      cssPrimary = cssPrimary || assist.cssPrimary;
      cssSecondary = cssSecondary || assist.cssSecondary;
      cssAccent = cssAccent || assist.cssAccent;
      cssBg = cssBg || assist.cssBg;
      cssText = cssText || assist.cssText;
      evidence.push(...assist.evidence);
      logoBuffers = assist.logoBuffers;
    } catch (err) {
      warnings.push(
        `Playwright CSS-assist failed: ${(err as Error).message || String(err)}`,
      );
    }
  } else if (needsCssAssist && htmlLikelyBotBlocked) {
    warnings.push(
      "Skipped Playwright CSS-assist (site bot-shielded) — using markup/logo fallbacks",
    );
  }

  let method: DeterministicBrandResult["method"] = "none";
  let primary: string | null = null;
  let secondary: string | null = null;
  let accent: string | null = null;

  // Prefer explicit declarations
  if (theme || cssPrimary || cssAccent) {
    primary =
      pickStrongestBrandHex([cssPrimary, theme, cssAccent]) ||
      cssPrimary ||
      theme ||
      cssAccent;
    secondary = cssSecondary || manifest.background || null;
    accent = cssAccent || theme || primary;
    method =
      cssPrimary || cssAccent
        ? "css-vars"
        : theme
          ? "theme-color"
          : "manifest";
    warnings.push(
      `Declared tokens: theme=${theme || "—"} cssPrimary=${cssPrimary || "—"} cssAccent=${cssAccent || "—"}`,
    );
  }

  // Logo Vibrant fallback / enrichment when declarations are thin
  const needsLogo =
    !primary ||
    !accent ||
    !secondary ||
    (primary && secondary && primary === secondary && !cssSecondary);

  let logoVibrant: Awaited<ReturnType<typeof extractPaletteFromLogoUrl>> = null;
  if (needsLogo || !primary) {
    // Direct logo fetch first
    for (const logo of logos) {
      logoVibrant = await extractPaletteFromLogoUrl(logo);
      if (logoVibrant?.primary) {
        warnings.push(`Vibrant palette from logo: ${logo}`);
        break;
      }
    }
    // Bot-blocked logos: reuse buffers from CSS-assist, or fetch via Playwright
    if (!logoVibrant?.primary) {
      if (!logoBuffers.length && logos.length && !htmlLikelyBotBlocked) {
        try {
          const assist = await extractDeclaredViaPlaywright(businessUrl, logos);
          warnings.push(...assist.warnings);
          logoBuffers = assist.logoBuffers;
          // Also absorb any CSS tokens we missed
          if (!primary) {
            theme = theme || assist.themeColor;
            cssPrimary = cssPrimary || assist.cssPrimary;
            cssAccent = cssAccent || assist.cssAccent;
            if (assist.cssPrimary || assist.themeColor || assist.cssAccent) {
              primary =
                pickStrongestBrandHex([
                  cssPrimary,
                  theme,
                  cssAccent,
                  assist.cssPrimary,
                  assist.themeColor,
                  assist.cssAccent,
                ]) ||
                cssPrimary ||
                theme ||
                cssAccent;
              secondary = secondary || cssSecondary || assist.cssSecondary;
              accent = cssAccent || assist.cssAccent || theme || primary;
              if (primary) method = "css-vars";
            }
          }
        } catch (err) {
          warnings.push(
            `Playwright logo fetch failed: ${(err as Error).message || String(err)}`,
          );
        }
      }
      for (const { url: logo, buf } of logoBuffers) {
        logoVibrant = await extractPaletteFromLogoUrl(logo, buf);
        if (logoVibrant?.primary) {
          warnings.push(`Vibrant palette from Playwright logo bytes: ${logo}`);
          break;
        }
      }
    }
  }

  if (logoVibrant?.primary) {
    evidence.push(...logoVibrant.evidence);
    if (!primary) {
      primary = logoVibrant.primary;
      secondary = logoVibrant.secondary || primary;
      accent = logoVibrant.accent || primary;
      method = "logo-vibrant";
    } else {
      // Enrich missing roles from logo; keep declared primary when present
      secondary = secondary || logoVibrant.secondary || primary;
      accent =
        accent && accent !== primary
          ? accent
          : logoVibrant.accent || logoVibrant.primary || primary;
      method = method === "none" ? "logo-vibrant" : "combined";
    }
  }

  // Markup chromatic hexes — when CSS vars/logo are blocked (captcha shells, etc.)
  if (!primary) {
    const markup = extractMarkupChromaticPalette(html);
    if (markup?.primary) {
      primary = markup.primary;
      secondary = markup.secondary || primary;
      accent = markup.accent || primary;
      method = "markup-hex";
      evidence.push(...markup.evidence);
      warnings.push(
        `Markup chromatic palette: primary=${primary} accent=${accent} (from explicit hex/rgb in HTML)`,
      );
    }
  }

  if (!primary) {
    return {
      colors: null,
      assets,
      finalUrl,
      method: "none",
      warnings: [
        ...warnings,
        "No theme-color/CSS vars/manifest/logo palette found",
      ],
    };
  }

  secondary = secondary || primary;
  accent = accent || primary;

  const colors = harmonizeBrandPalette(
    {
      primary,
      secondary,
      accent,
      background:
        cssBg ||
        manifest.background ||
        (luminance(secondary) > 0.85 ? secondary : "#FFFFFF"),
      text:
        cssText ||
        (luminance(secondary) < 0.3 ? secondary : "#0F172A"),
      muted: logoVibrant?.muted || "#64748B",
      source: `deterministic:${method}:${finalUrl}`,
    },
    evidence,
  );

  if (isWeakOrJunkPalette(colors)) {
    return {
      colors: null,
      assets,
      finalUrl,
      method: "none",
      warnings: [...warnings, "Deterministic palette looked like junk — discarded"],
    };
  }

  return {
    colors,
    assets,
    finalUrl,
    method,
    warnings,
  };
}
