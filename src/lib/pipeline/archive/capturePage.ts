import { chromium, type Browser, type Page } from "playwright";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

export type ArchivedPage = {
  url: string;
  finalUrl: string;
  html: string;
  /** Full-page PNG at desktop width */
  screenshotDesktop: Buffer;
  title: string | null;
  /** Painted color frequencies from getComputedStyle (area-weighted) */
  paintedColors: Array<{ css: string; area: number }>;
  /** Computed design tokens from the live page */
  computedTokens: {
    borderRadii: string[];
    boxShadows: string[];
    fontFamilies: string[];
  };
};

async function autoScroll(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let total = 0;
      const distance = 600;
      const timer = setInterval(() => {
        const { scrollHeight } = document.documentElement;
        window.scrollBy(0, distance);
        total += distance;
        if (total >= scrollHeight || total > 20_000) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 120);
    });
  });
}

async function inlineDocumentResources(page: Page): Promise<void> {
  // Inline stylesheets → <style>
  await page.evaluate(async () => {
    const links = Array.from(
      document.querySelectorAll('link[rel="stylesheet"]'),
    ) as HTMLLinkElement[];
    for (const link of links) {
      try {
        const href = link.href;
        if (!href || href.startsWith("data:")) continue;
        const res = await fetch(href, { credentials: "omit" });
        if (!res.ok) continue;
        let css = await res.text();
        // Absolutize url() in CSS against stylesheet href
        const base = href;
        css = css.replace(
          /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi,
          (full, _q, raw) => {
            const u = String(raw || "").trim();
            if (!u || u.startsWith("data:") || u.startsWith("#")) return full;
            try {
              return `url("${new URL(u, base).toString()}")`;
            } catch {
              return full;
            }
          },
        );
        const style = document.createElement("style");
        style.setAttribute("data-adrival-archived-css", href);
        style.textContent = css;
        link.replaceWith(style);
      } catch {
        // keep original link if fetch fails
      }
    }
  });

  // Inline images as data URLs (keeps width/height attributes intact)
  await page.evaluate(async () => {
    const toDataUrl = async (url: string): Promise<string | null> => {
      try {
        if (!url || url.startsWith("data:")) return url || null;
        const res = await fetch(url, { credentials: "omit" });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ""));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    };

    const imgs = Array.from(document.images);
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      const data = await toDataUrl(src);
      if (data) {
        img.setAttribute("src", data);
        img.removeAttribute("srcset");
      }
    }

    // Inline CSS background images that are still remote (best-effort)
    const all = Array.from(document.querySelectorAll<HTMLElement>("*[style]"));
    for (const el of all) {
      const style = el.getAttribute("style") || "";
      if (!/url\(/i.test(style)) continue;
      const next = await (async () => {
        let out = style;
        const re = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi;
        const matches = [...style.matchAll(re)];
        for (const m of matches) {
          const raw = m[2];
          if (!raw || raw.startsWith("data:")) continue;
          try {
            const abs = new URL(raw, location.href).toString();
            const data = await toDataUrl(abs);
            if (data) out = out.split(m[0]).join(`url("${data}")`);
          } catch {
            // ignore
          }
        }
        return out;
      })();
      el.setAttribute("style", next);
    }
  });

  // Preserve interactive JS (FAQ/accordions/tabs). Strip only trackers.
  // Inline same-origin/external scripts so srcDoc previews still work offline.
  await page.evaluate(async () => {
    const TRACKING =
      /google-analytics|googletagmanager|gtag\/|facebook\.net|connect\.facebook|hotjar|segment\.(com|io)|clarity\.ms|doubleclick|linkedin\.com\/px|analytics\.tiktok|hubspot|intercom|fullstory|mixpanel|montecarlo|sentry\.io\/api|cdn\.amplitude|heap-api|optimizely|newrelic|nr-data\.net|googlesyndication|adservice|scorecardresearch/i;

    const scripts = Array.from(document.querySelectorAll("script"));
    for (const script of scripts) {
      const src = script.getAttribute("src") || "";
      const body = script.textContent || "";
      if ((src && TRACKING.test(src)) || (body && TRACKING.test(body))) {
        script.remove();
        continue;
      }
      // Skip JSON-LD / application types — keep as-is
      const type = (script.getAttribute("type") || "").toLowerCase();
      if (type && type !== "text/javascript" && type !== "module" && type !== "application/javascript") {
        continue;
      }
      if (src && !src.startsWith("data:") && !src.startsWith("blob:")) {
        try {
          const abs = new URL(src, location.href).toString();
          const res = await fetch(abs, { credentials: "omit" });
          if (!res.ok) {
            script.setAttribute("src", abs);
            continue;
          }
          let code = await res.text();
          if (TRACKING.test(code)) {
            script.remove();
            continue;
          }
          // Prevent premature script end while inlining
          code = code.replace(/<\/script/gi, "<\\/script");
          const inline = document.createElement("script");
          inline.setAttribute("data-adrival-archived-js", abs);
          if (type === "module") inline.setAttribute("type", "module");
          inline.textContent = code;
          script.replaceWith(inline);
        } catch {
          try {
            script.setAttribute("src", new URL(src, location.href).toString());
          } catch {
            // leave as-is
          }
        }
      }
    }

    // Neutralize remote iframes (ads/embeds) but keep layout box
    document.querySelectorAll("iframe").forEach((n) => {
      const src = n.getAttribute("src") || "";
      if (/youtube|vimeo|maps\.google|google\.com\/maps/i.test(src)) return;
      n.setAttribute("data-adrival-iframe-src", src);
      n.setAttribute("src", "about:blank");
    });

    // Ensure details/summary remain interactive
    document.querySelectorAll("details").forEach((d) => {
      d.setAttribute("data-adrival-details", "1");
    });
  });
}

async function collectPaintedColors(page: Page) {
  return page.evaluate(() => {
    const map = new Map<string, number>();
    const nodes = Array.from(document.querySelectorAll("body, body *")).slice(
      0,
      2500,
    );
    for (const el of nodes) {
      const rect = (el as HTMLElement).getBoundingClientRect?.();
      if (!rect) continue;
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (area < 8) continue;
      const s = getComputedStyle(el as Element);
      for (const prop of [
        "backgroundColor",
        "color",
        "borderTopColor",
        "fill",
        "stroke",
      ] as const) {
        const raw = (s as any)[prop] as string;
        if (!raw || /rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/i.test(raw)) {
          continue;
        }
        if (raw === "transparent") continue;
        map.set(raw, (map.get(raw) || 0) + area);
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([css, area]) => ({ css, area }));
  });
}

async function collectComputedTokens(page: Page) {
  return page.evaluate(() => {
    const radii = new Set<string>();
    const shadows = new Set<string>();
    const fonts = new Set<string>();
    const nodes = Array.from(
      document.querySelectorAll("body, button, a, h1, h2, input, .btn, [class*='btn']"),
    ).slice(0, 400);
    for (const el of nodes) {
      const s = getComputedStyle(el);
      if (s.borderRadius && s.borderRadius !== "0px") radii.add(s.borderRadius);
      if (s.boxShadow && s.boxShadow !== "none") shadows.add(s.boxShadow);
      if (s.fontFamily) fonts.add(s.fontFamily.split(",")[0]?.replace(/["']/g, "").trim());
    }
    return {
      borderRadii: [...radii].slice(0, 12),
      boxShadows: [...shadows].slice(0, 12),
      fontFamilies: [...fonts].filter(Boolean).slice(0, 12),
    };
  });
}

/**
 * Faithful page archive via Playwright:
 * - full scroll (lazy loads)
 * - network idle
 * - inline CSS + images into a single HTML document
 */
export async function captureArchivedPage(
  url: string,
  options?: { screenshotDir?: string },
): Promise<ArchivedPage> {
  let browser: Browser | null = null;
  try {
    try {
      browser = await chromium.launch({
        headless: true,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    } catch (launchErr) {
      const msg = launchErr instanceof Error ? launchErr.message : String(launchErr);
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
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 25_000 });
    } catch {
      // some sites never go idle — continue
    }
    await autoScroll(page);
    await page.waitForTimeout(800);

    const paintedColors = await collectPaintedColors(page);
    const computedTokens = await collectComputedTokens(page);

    const screenshotDesktop = Buffer.from(
      await page.screenshot({ fullPage: true, type: "png" }),
    );

    await inlineDocumentResources(page);

    const html = await page.content();
    const title = await page.title();
    const finalUrl = page.url();

    if (options?.screenshotDir) {
      await fs.mkdir(options.screenshotDir, { recursive: true });
      await fs.writeFile(
        path.join(options.screenshotDir, "original-desktop.png"),
        screenshotDesktop,
      );
    }

    await context.close();
    return {
      url,
      finalUrl,
      html,
      screenshotDesktop,
      title: title || null,
      paintedColors,
      computedTokens,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export function tempArchiveDir(prefix = "adrival-archive-"): string {
  return path.join(os.tmpdir(), `${prefix}${Date.now()}`);
}
