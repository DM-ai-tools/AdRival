import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import type { BrandColors } from "../types";
import {
  luminance,
  normalizeHex,
  parseCssColorToHex,
  rgbToHex,
  saturation,
} from "./brandColors";
import {
  harmonizeBrandPalette,
  isJunkBrandHex,
  pickStrongestBrandHex,
} from "./paletteHarmonize";

type WeightedHex = { hex: string; weight: number; role: string };

function bump(
  map: Map<string, { weight: number; roles: Set<string> }>,
  hex: string | null,
  weight: number,
  role: string,
) {
  if (!hex || isJunkBrandHex(hex)) return;
  if (luminance(hex) > 0.93 || luminance(hex) < 0.06) return;
  const cur = map.get(hex) || { weight: 0, roles: new Set<string>() };
  cur.weight += weight;
  cur.roles.add(role);
  map.set(hex, cur);
}

/**
 * Role-weighted computed colors from the live DOM (buttons, links, headings, surfaces).
 */
async function collectRoleWeightedColors(page: Page): Promise<WeightedHex[]> {
  const rows = await page.evaluate(() => {
    const out: Array<{
      css: string;
      weight: number;
      role: string;
    }> = [];

    const push = (
      el: Element,
      prop: "backgroundColor" | "color" | "borderTopColor" | "fill",
      role: string,
      mult: number,
    ) => {
      const rect = (el as HTMLElement).getBoundingClientRect?.();
      if (!rect) return;
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 4) return;
      const raw = getComputedStyle(el)[prop];
      if (!raw || raw === "transparent") return;
      if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(raw)) return;
      out.push({ css: raw, weight: area * mult, role });
    };

    const all = Array.from(document.querySelectorAll("body, body *")).slice(
      0,
      3500,
    );

    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const cls = `${el.className || ""}`;
      const id = el.id || "";
      const hay = `${tag} ${cls} ${id}`.toLowerCase();

      const isCta =
        tag === "button" ||
        (el as HTMLElement).getAttribute("role") === "button" ||
        /btn|button|cta|primary|submit|get-started|book|apply/i.test(hay) ||
        (tag === "a" && /btn|button|cta|primary/i.test(cls));

      const isLink = tag === "a" && !isCta;
      const isHeading = /^h[1-3]$/.test(tag);
      const inHeader =
        el.closest("header, nav, [role='banner'], .navbar") != null;
      const inHero =
        el.closest(
          "[class*='hero'], [class*='Hero'], [class*='banner'], [class*='Banner'], section:first-of-type",
        ) != null;

      if (isCta) {
        push(el, "backgroundColor", "cta-bg", 12);
        push(el, "color", "cta-text", 2);
        push(el, "borderTopColor", "cta-border", 4);
      } else if (isLink) {
        push(el, "color", "link", 6);
      } else if (isHeading) {
        push(el, "color", "heading", 5);
      } else if (inHero) {
        push(el, "backgroundColor", "hero-bg", 3);
        push(el, "color", "hero-text", 2);
      } else if (inHeader) {
        push(el, "backgroundColor", "header-bg", 2);
        push(el, "color", "header-text", 2);
      } else {
        push(el, "backgroundColor", "surface", 1);
        if (tag === "p" || tag === "li" || tag === "span") {
          push(el, "color", "body-text", 1.2);
        }
      }
    }

    // theme-color meta
    const theme = document.querySelector('meta[name="theme-color"]');
    const themeContent = theme?.getAttribute("content");
    if (themeContent) {
      out.push({ css: themeContent, weight: 50_000, role: "theme-color" });
    }

    return out;
  });

  const map = new Map<string, { weight: number; roles: Set<string> }>();
  for (const row of rows) {
    const hex = parseCssColorToHex(row.css) || normalizeHex(row.css);
    bump(map, hex, row.weight, row.role);
  }

  return [...map.entries()]
    .map(([hex, v]) => ({
      hex,
      weight: v.weight,
      role: [...v.roles].join(","),
    }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Dominant chromatic colors from a PNG screenshot (catches logo / hero image hues).
 */
function colorsFromScreenshotPng(pngBuffer: Buffer): WeightedHex[] {
  const png = PNG.sync.read(pngBuffer);
  const { width, height, data } = png;
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 50));
  const counts = new Map<string, number>();

  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (width * y + x) << 2;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 200) continue;
      // Quantize to reduce noise
      const rq = Math.round(r / 12) * 12;
      const gq = Math.round(g / 12) * 12;
      const bq = Math.round(b / 12) * 12;
      const hex = rgbToHex(rq, gq, bq);
      if (isJunkBrandHex(hex)) continue;
      const lum = luminance(hex);
      if (lum > 0.92 || lum < 0.07) continue;
      if (saturation(hex) < 0.18) continue; // skip grays from screenshot
      counts.set(hex, (counts.get(hex) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([hex, weight]) => ({ hex, weight, role: "screenshot" }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 16);
}

function buildPaletteFromEvidence(
  roleColors: WeightedHex[],
  shotColors: WeightedHex[],
  sourceUrl: string,
): BrandColors | null {
  const cta = roleColors.filter((c) => /cta-bg|cta-border|theme-color/i.test(c.role));
  const links = roleColors.filter((c) => /link/i.test(c.role));
  const headings = roleColors.filter((c) => /heading/i.test(c.role));
  const chromatic = roleColors.filter(
    (c) => saturation(c.hex) >= 0.2 && !isJunkBrandHex(c.hex),
  );

  const primary =
    pickStrongestBrandHex([
      ...cta.slice(0, 5).map((c) => c.hex),
      ...shotColors.slice(0, 5).map((c) => c.hex),
      ...links.slice(0, 3).map((c) => c.hex),
      ...chromatic.slice(0, 8).map((c) => c.hex),
    ]) || null;

  if (!primary) return null;

  const darkCandidates = [
    ...headings.map((c) => c.hex),
    ...roleColors.filter((c) => luminance(c.hex) < 0.25).map((c) => c.hex),
    ...chromatic.filter((c) => luminance(c.hex) < 0.28).map((c) => c.hex),
  ];

  const secondary =
    darkCandidates.find((h) => h !== primary && !isJunkBrandHex(h)) || primary;

  const accent =
    pickStrongestBrandHex([
      ...cta.map((c) => c.hex),
      ...links.map((c) => c.hex),
      ...shotColors.map((c) => c.hex),
      primary,
    ]) || primary;

  const bg =
    roleColors.find(
      (c) =>
        /surface|hero-bg|header-bg/i.test(c.role) &&
        luminance(c.hex) > 0.88 &&
        saturation(c.hex) < 0.15,
    )?.hex || "#FFFFFF";

  const text =
    roleColors.find(
      (c) =>
        /body-text|heading/i.test(c.role) &&
        luminance(c.hex) < 0.3 &&
        !isJunkBrandHex(c.hex),
    )?.hex ||
    (luminance(secondary) < 0.3 ? secondary : "#0F172A");

  const muted =
    roleColors.find(
      (c) =>
        saturation(c.hex) < 0.2 &&
        luminance(c.hex) > 0.35 &&
        luminance(c.hex) < 0.7,
    )?.hex || "#64748B";

  const evidence = [
    ...roleColors.map((c) => c.hex),
    ...shotColors.map((c) => c.hex),
  ];

  return harmonizeBrandPalette(
    {
      primary,
      secondary,
      accent,
      background: bg,
      text,
      muted,
      source: `playwright-painted:${sourceUrl}`,
    },
    evidence,
  );
}

export type PlaywrightBrandColorResult = {
  colors: BrandColors | null;
  finalUrl: string;
  title: string | null;
  warnings: string[];
};

/**
 * Extract brand palette from the LIVE rendered page via Playwright:
 * 1) role-weighted getComputedStyle (CTAs, links, headings)
 * 2) screenshot pixel sampling (logo / hero image hues)
 */
export async function extractBrandColorsViaPlaywright(
  urlInput: string,
): Promise<PlaywrightBrandColorResult> {
  const warnings: string[] = [];
  const url = /^https?:\/\//i.test(urlInput.trim())
    ? urlInput.trim()
    : `https://${urlInput.trim()}`;

  let browser: Browser | null = null;
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (launchErr) {
      const msg =
        launchErr instanceof Error ? launchErr.message : String(launchErr);
      if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
        throw new Error(
          `Playwright Chromium is not installed. Run: npx playwright install chromium\n${msg}`,
        );
      }
      throw launchErr;
    }

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      // Prefer real paint over bot shells when possible
      colorScheme: "light",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 20_000 });
    } catch {
      warnings.push("Playwright: networkidle timeout — continuing");
    }
    // Scroll to trigger lazy hero/logo paints
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let total = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 500);
          total += 500;
          if (total >= Math.min(document.body.scrollHeight, 4000)) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 80);
      });
    });
    await page.waitForTimeout(600);

    const finalUrl = page.url();
    const title = (await page.title()) || null;

    // Skip obvious challenge pages
    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (
      /just a moment|verify you are human|attention required|enable javascript|captcha/i.test(
        bodyText.slice(0, 500),
      ) &&
      bodyText.length < 800
    ) {
      warnings.push("Playwright hit a bot-challenge shell");
      await context.close();
      return { colors: null, finalUrl, title, warnings };
    }

    const roleColors = await collectRoleWeightedColors(page);
    const shotBuf = Buffer.from(
      await page.screenshot({ type: "png", fullPage: false }),
    );
    const shotColors = colorsFromScreenshotPng(shotBuf);

    const colors = buildPaletteFromEvidence(roleColors, shotColors, finalUrl);
    if (!colors) {
      warnings.push("Playwright found no usable chromatic brand colors");
    } else {
      warnings.push(
        `Playwright palette: primary=${colors.primary} secondary=${colors.secondary} accent=${colors.accent} (cta/link/screenshot evidence)`,
      );
    }

    await context.close();
    return { colors, finalUrl, title, warnings };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}
