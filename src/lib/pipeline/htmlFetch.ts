import { assertPublicHttpUrl } from "./content/safeUrl";
import {
  firecrawlScrapeHtml,
  hasFirecrawlKey,
} from "../firecrawl/client";

const MAX_HTML_CHARS = 350_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

const BLOCK_PAGE_RE =
  /captcha|access denied|just a moment|cf-browser|attention required|enable javascript and cookies|checking your browser|verify you are human|bot detection|request blocked|forbidden/i;

/**
 * Clean ad landing URLs before fetch:
 * - strip unresolved Meta/Google macros like {{ad.id}}, {{fbclid}}
 * - drop empty / broken query params
 * - optionally strip tracking params for a retry URL
 */
export function normalizeLandingUrl(
  raw: string,
  options?: { stripTracking?: boolean },
): string | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;

  // Remove unresolved template macros anywhere in the string
  let cleaned = trimmed
    .replace(/\{\{[^}]+\}\}/g, "")
    .replace(/%7B%7B[^%]*%7D%7D/gi, "")
    .replace(/\{%[^\n%]+%\}/g, "");

  try {
    const u = new URL(cleaned.startsWith("http") ? cleaned : `https://${cleaned}`);
    if (!/^https?:$/i.test(u.protocol)) return null;

    // Remove empty params and params that still look like macros/placeholders
    const dropKeys: string[] = [];
    u.searchParams.forEach((value, key) => {
      const v = value.trim();
      if (
        !v ||
        /\{\{|%\d|undefined|null|^\{|\}$/i.test(v) ||
        (options?.stripTracking &&
          /^(utm_|fbclid|fbp|fbc|gclid|wbraid|gbraid|mc_|sub\d*$|ref$|fb_|li_fat_id)/i.test(
            key,
          ))
      ) {
        dropKeys.push(key);
      }
    });
    for (const key of dropKeys) u.searchParams.delete(key);

    // tidy trailing ? or &
    let out = u.toString();
    out = out.replace(/\?$/, "").replace(/&&+/g, "&");
    return out;
  } catch {
    return null;
  }
}

function buildFetchCandidates(url: string): string[] {
  const primary = normalizeLandingUrl(url);
  const noTracking = normalizeLandingUrl(url, { stripTracking: true });
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u) return;
    if (!out.includes(u)) out.push(u);
  };
  push(primary);
  push(noTracking);

  try {
    const base = new URL(primary || url);
    push(`${base.origin}${base.pathname}`.replace(/\/$/, "") || base.origin);
    push(base.origin);
    push(`${base.origin}/`);

    // Flip www ↔ apex — many brand sites only answer on one host
    const flipped = new URL(base.toString());
    if (flipped.hostname.startsWith("www.")) {
      flipped.hostname = flipped.hostname.replace(/^www\./i, "");
    } else {
      flipped.hostname = `www.${flipped.hostname}`;
    }
    push(flipped.toString());
    push(flipped.origin);
    push(`${flipped.origin}/`);
  } catch {
    // ignore
  }
  return out;
}

function extractTitle(html: string): string | null {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return titleMatch?.[1]
    ? titleMatch[1].replace(/\s+/g, " ").trim()
    : null;
}

function looksBlocked(html: string): boolean {
  const sample = html.slice(0, 8_000);
  if (html.length < 400 && BLOCK_PAGE_RE.test(sample)) return true;
  if (BLOCK_PAGE_RE.test(sample) && html.length < 12_000) {
    // Challenge shells are usually short and lack real page structure
    const hasRealContent =
      /<h1[\s>]/i.test(html) &&
      (/<p[\s>]/i.test(html) || /<section[\s>]/i.test(html));
    if (!hasRealContent) return true;
  }
  return false;
}

/**
 * Direct HTTP often returns an SPA shell or funnel stub with almost no
 * headings/copy. Those must not short-circuit Firecrawl/Playwright.
 */
export function looksLikeThinShell(html: string): boolean {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const headings = (html.match(/<h[1-3]\b/gi) || []).length;
  const paragraphs = (html.match(/<p\b/gi) || []).length;
  if (stripped.length < 500) return true;
  if (headings < 2 && stripped.length < 3_500) return true;
  if (headings < 3 && paragraphs < 3 && stripped.length < 6_000) return true;
  if (
    /id=["']__(?:next|nuxt)["']|id=["']root["']|data-reactroot|ng-version=/i.test(
      html,
    ) &&
    headings < 3 &&
    stripped.length < 5_000
  ) {
    return true;
  }
  return false;
}

function markdownToBasicHtml(markdown: string, title?: string | null): string {
  const escaped = markdown
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withBreaks = escaped
    .split(/\n{2,}/)
    .map((block) => {
      const line = block.trim();
      if (!line) return "";
      const heading = line.match(/^(#{1,6})\s+(.+)$/m);
      if (heading) {
        const level = Math.min(heading[1].length, 6);
        return `<h${level}>${heading[2]}</h${level}>`;
      }
      return `<p>${line.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
  const safeTitle = (title || "Landing page").replace(/</g, "");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${safeTitle}</title></head><body>${withBreaks}</body></html>`;
}

async function tryFetch(url: string, hops = 0): Promise<Response> {
  await assertPublicHttpUrl(url);
  const res = await fetch(url, {
    redirect: "manual",
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
  if (res.status >= 300 && res.status < 400) {
    if (hops >= 4) throw new Error("Too many redirects while fetching the page.");
    const location = res.headers.get("location");
    if (!location) throw new Error("Redirect had no location.");
    return tryFetch(new URL(location, url).toString(), hops + 1);
  }
  return res;
}

async function fetchViaFirecrawl(url: string): Promise<{
  finalUrl: string;
  title: string | null;
  html: string;
  source: "firecrawl";
}> {
  if (!hasFirecrawlKey()) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }
  const result = await firecrawlScrapeHtml(url);
  const data = result.data;
  const htmlRaw = data?.html?.trim() || "";
  const markdown = data?.markdown?.trim() || "";
  const metaTitle = data?.metadata?.title || null;
  const finalUrl =
    data?.metadata?.url ||
    data?.metadata?.sourceURL ||
    url;

  let html = htmlRaw;
  if (!html && markdown) {
    html = markdownToBasicHtml(markdown, metaTitle);
  }
  if (!html || html.length < 200) {
    throw new Error(`Site scrape returned empty HTML for ${url}`);
  }
  if (looksBlocked(html)) {
    throw new Error(`Firecrawl still hit bot protection for ${url}`);
  }

  return {
    finalUrl,
    title: metaTitle || extractTitle(html),
    html: html.slice(0, MAX_HTML_CHARS),
    source: "firecrawl",
  };
}

async function fetchViaPlaywright(url: string): Promise<{
  finalUrl: string;
  title: string | null;
  html: string;
  source: "playwright";
}> {
  const { chromiumLaunchOptions } = await import("./content/playwrightRuntime");
  const { chromium } = await import("playwright");
  let browser = null as Awaited<ReturnType<typeof chromium.launch>> | null;
  try {
    browser = await chromium.launch(
      chromiumLaunchOptions(["--disable-blink-features=AutomationControlled"]),
    );
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: BROWSER_HEADERS["User-Agent"],
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await assertPublicHttpUrl(page.url() || url);
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
    } catch {
      // some sites never idle
    }
    await page.waitForTimeout(800);
    const html = (await page.content()).slice(0, MAX_HTML_CHARS);
    const title = (await page.title()) || extractTitle(html);
    const finalUrl = page.url() || url;
    await context.close();

    if (!html || html.length < 200) {
      throw new Error(`Playwright returned empty HTML for ${url}`);
    }
    if (looksBlocked(html)) {
      throw new Error(`Playwright still hit bot protection for ${url}`);
    }

    return { finalUrl, title, html, source: "playwright" };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

/**
 * Fetch landing-page HTML with URL cleanup + retries for common 403/blocked cases.
 * Fallback order: direct fetch → Firecrawl → Playwright.
 */
export async function fetchRawLandingHtml(url: string): Promise<{
  finalUrl: string;
  title: string | null;
  html: string;
  source: "direct" | "firecrawl" | "playwright";
}> {
  const candidates = buildFetchCandidates(url);
  if (candidates.length === 0) {
    throw new Error(`Could not normalize landing URL: ${url}`);
  }
  await assertPublicHttpUrl(candidates[0]);

  let lastError: Error | null = null;
  let blockedByProtection = false;
  let thinDirect: {
    finalUrl: string;
    title: string | null;
    html: string;
    source: "direct";
  } | null = null;

  for (const candidate of candidates) {
    try {
      const res = await tryFetch(candidate);
      if (!res.ok) {
        lastError = new Error(
          `Landing page fetch failed (${res.status}) for ${candidate}`,
        );
        // Retry next candidate on 401/403/429/5xx
        if (
          [401, 403, 429, 500, 502, 503, 520, 521, 522, 523, 524].includes(
            res.status,
          )
        ) {
          if ([401, 403, 429].includes(res.status)) blockedByProtection = true;
          continue;
        }
        throw lastError;
      }

      const contentType = res.headers.get("content-type") || "";
      if (
        contentType &&
        !/text\/html|application\/xhtml|text\/plain/i.test(contentType)
      ) {
        lastError = new Error(
          `URL did not return HTML (got ${contentType}) for ${candidate}`,
        );
        continue;
      }

      const html = (await res.text()).slice(0, MAX_HTML_CHARS);
      if (looksBlocked(html)) {
        blockedByProtection = true;
        lastError = new Error(
          `Landing page blocked by bot protection for ${candidate}`,
        );
        continue;
      }

      const direct = {
        finalUrl: res.url || candidate,
        title: extractTitle(html),
        html,
        source: "direct" as const,
      };

      // SPA / funnel shells look "successful" but lack architecture — keep as
      // fallback and continue to rendered scrapers.
      if (looksLikeThinShell(html)) {
        thinDirect = thinDirect || direct;
        lastError = new Error(
          `Landing page HTML looks like a thin JS shell for ${candidate}`,
        );
        console.warn(
          `[htmlFetch] thin shell from direct fetch for ${candidate}; trying rendered fallbacks`,
        );
        break;
      }

      return direct;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  const primary = candidates[0];

  // Firecrawl often bypasses WAF/403 that block datacenter Node fetch
  if (hasFirecrawlKey()) {
    try {
      console.warn(
        `[htmlFetch] ${thinDirect ? "thin shell" : "direct fetch blocked"} for ${primary}; trying Firecrawl`,
      );
      const viaFirecrawl = await fetchViaFirecrawl(primary);
      if (
        !looksLikeThinShell(viaFirecrawl.html) ||
        !thinDirect ||
        viaFirecrawl.html.length >= thinDirect.html.length
      ) {
        return viaFirecrawl;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn("[htmlFetch] Firecrawl fallback failed", lastError.message);
    }
  } else if (blockedByProtection) {
    console.warn(
      "[htmlFetch] bot protection hit but FIRECRAWL_API_KEY is not set",
    );
  }

  // Last resort: real Chromium (helps on JS-rendered / soft challenges)
  try {
    console.warn(
      `[htmlFetch] trying Playwright fallback for ${primary}`,
    );
    const viaPlaywright = await fetchViaPlaywright(primary);
    if (
      !looksLikeThinShell(viaPlaywright.html) ||
      !thinDirect ||
      viaPlaywright.html.length >= thinDirect.html.length
    ) {
      return viaPlaywright;
    }
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err));
    console.warn("[htmlFetch] Playwright fallback failed", lastError.message);
  }

  if (thinDirect) return thinDirect;

  throw (
    lastError ||
    new Error(`Landing page fetch failed for ${url}`)
  );
}
