import type { BrandColors, BrandDesignSystem, BusinessProfile } from "../types";
import {
  extractBrandColorsFromHtml,
  normalizeHex,
} from "./brandColors";
import {
  extractBrandAssetsFromHtml,
  fetchBrandSiteAssets,
  type BrandSiteAssets,
} from "./brandAssets";
import { fetchRawLandingHtml, normalizeLandingUrl } from "./htmlFetch";
import {
  getAnthropicClient,
  getAnthropicModel,
} from "../anthropic/client";
import {
  extractColorsViaFirecrawl,
  fetchBrandfetchColors,
  isChallengeOrEmptyHtml,
  reconcilePaletteWithHtmlEvidence,
} from "./brandColorSources";
import {
  harmonizeBrandPalette,
  isWeakOrJunkPalette,
} from "./paletteHarmonize";

export type BrandBundle = {
  businessUrl: string;
  finalUrl: string;
  colors: BrandColors;
  assets: BrandSiteAssets | null;
  design: BrandDesignSystem | null;
  warnings: string[];
};

function withWwwVariants(url: string): string[] {
  const out: string[] = [];
  const push = (u: string | null | undefined) => {
    if (!u) return;
    if (!out.includes(u)) out.push(u);
  };
  const normalized = normalizeLandingUrl(url) || url;
  push(normalized);
  try {
    const u = new URL(
      normalized.startsWith("http") ? normalized : `https://${normalized}`,
    );
    push(u.toString());
    push(`${u.origin}/`);
    if (u.hostname.startsWith("www.")) {
      u.hostname = u.hostname.replace(/^www\./i, "");
      push(u.toString());
      push(`${u.origin}/`);
    } else {
      u.hostname = `www.${u.hostname}`;
      push(u.toString());
      push(`${u.origin}/`);
    }
  } catch {
    // ignore
  }
  return out;
}

function logoCdnFallbacks(businessUrl: string): string[] {
  try {
    const host = new URL(
      businessUrl.startsWith("http") ? businessUrl : `https://${businessUrl}`,
    ).hostname.replace(/^www\./i, "");
    return [
      `https://logo.clearbit.com/${host}`,
      `https://www.google.com/s2/favicons?domain=${host}&sz=256`,
      `https://icons.duckduckgo.com/ip3/${host}.ico`,
    ];
  } catch {
    return [];
  }
}

async function firstReachableImage(urls: string[]): Promise<string | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
      });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") || "";
      if (ct && !/^image\//i.test(ct) && !/octet-stream/i.test(ct)) continue;
      return res.url || url;
    } catch {
      // try next
    }
  }
  return null;
}

async function extractColorsViaLlm(
  businessUrl: string,
  businessName?: string | null,
  pageEvidence?: string | null,
): Promise<BrandColors | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return null;
  }
  if (!pageEvidence || pageEvidence.trim().length < 80) {
    return null;
  }

  const prompt = `Extract the REAL brand UI palette from this website evidence only.

Business: ${businessName || "unknown"}
URL: ${businessUrl}

PAGE EVIDENCE (markdown / notes from a live scrape):
"""
${pageEvidence.slice(0, 6000)}
"""

Return ONLY JSON:
{ "primary": "#RRGGBB", "secondary": "#RRGGBB", "accent": "#RRGGBB", "background": "#RRGGBB", "text": "#RRGGBB", "muted": "#RRGGBB" }

Rules:
- Use colors actually evidenced on this site (logo, buttons, headings, CSS mentions).
- Do NOT invent a generic marketing orange/coral palette.
- Do NOT invent a blue/green accent unless it clearly appears as a major UI color on the site.
- Accent must match the site's real palette family.
- background white/light and text dark when that matches the page.
- If evidence is insufficient, return { "primary": null }.`;

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = getAnthropicClient();
      const completion = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      });
      const content = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]) as Record<string, string | null>;
      const primary = normalizeHex(parsed.primary || "");
      if (!primary) return null;
      return {
        primary,
        secondary: normalizeHex(parsed.secondary || "") || primary,
        accent: normalizeHex(parsed.accent || "") || primary,
        background: normalizeHex(parsed.background || "") || "#FFFFFF",
        text: normalizeHex(parsed.text || "") || "#0F172A",
        muted: normalizeHex(parsed.muted || "") || "#64748B",
        source: `llm-grounded:${businessUrl}`,
      };
    }
  } catch (err) {
    console.warn("[brand] LLM color fallback failed", err);
  }
  return null;
}

function emptyAssets(finalUrl: string, siteName: string | null): BrandSiteAssets {
  return {
    finalUrl,
    siteName,
    logoUrl: null,
    faviconUrl: null,
    ogImageUrl: null,
    navLinks: [],
    footerLinks: [],
    socialLinks: [],
    images: [],
    emails: [],
    phones: [],
  };
}

/**
 * Resolve brand colors + assets + design system from the business URL.
 * Primary: Firecrawl branding format (colors, fonts, logo, components, links).
 * Fallbacks: HTML/CSS → Brandfetch → profile cache → grounded LLM.
 */
export async function resolveBrandBundle(input: {
  businessUrl: string;
  profile?: BusinessProfile | null;
}): Promise<BrandBundle> {
  const warnings: string[] = [];
  const businessUrl =
    normalizeLandingUrl(input.businessUrl) ||
    (/^https?:\/\//i.test(input.businessUrl)
      ? input.businessUrl.trim()
      : `https://${input.businessUrl.trim()}`);

  let html: string | null = null;
  let finalUrl = businessUrl;
  let title: string | null = input.profile?.businessName || null;
  let pageEvidence: string | null = null;
  let colors: BrandColors | null = null;
  let assets: BrandSiteAssets | null = null;
  let design: BrandDesignSystem | null = null;

  // 1) Firecrawl branding — primary source
  const fc = await extractColorsViaFirecrawl(businessUrl);
  warnings.push(...fc.warnings);
  pageEvidence = fc.markdown || pageEvidence;
  if (fc.html && !isChallengeOrEmptyHtml(fc.html)) {
    html = fc.html;
  }
  if (fc.assets) {
    assets = fc.assets;
    finalUrl = fc.assets.finalUrl || finalUrl;
    title = fc.assets.siteName || title;
  }
  if (fc.design) {
    design = fc.design;
  }
  if (fc.colors && !isWeakOrJunkPalette(fc.colors)) {
    colors = fc.colors;
  }

  // 2) Live HTML assets if Firecrawl didn't return them
  if (!assets || !html) {
    for (const candidate of withWwwVariants(businessUrl)) {
      try {
        const fetched = await fetchRawLandingHtml(candidate);
        if (fetched.html && fetched.html.length > 500) {
          if (isChallengeOrEmptyHtml(fetched.html)) {
            warnings.push(`Blocked/challenge HTML from ${candidate}`);
            continue;
          }
          html = html || fetched.html;
          finalUrl = fetched.finalUrl || finalUrl;
          title = fetched.title || title;
          if (!assets) {
            try {
              assets = extractBrandAssetsFromHtml(fetched.html, finalUrl);
            } catch (err) {
              warnings.push(
                `Asset extract from HTML failed: ${(err as Error).message}`,
              );
            }
          }
          break;
        }
      } catch (err) {
        warnings.push(
          `Fetch failed for ${candidate}: ${(err as Error).message || String(err)}`,
        );
      }
    }
  }

  if (!assets) {
    try {
      assets = await fetchBrandSiteAssets(businessUrl);
    } catch (err) {
      warnings.push(`fetchBrandSiteAssets failed: ${(err as Error).message}`);
    }
  }

  // 3) HTML/CSS colors if Firecrawl branding missing
  if (isWeakOrJunkPalette(colors) && html) {
    try {
      const fromHtml = await extractBrandColorsFromHtml(html, finalUrl);
      if (!isWeakOrJunkPalette(fromHtml)) {
        colors = fromHtml;
        warnings.push("Brand colors from live HTML/CSS (Firecrawl branding empty)");
      }
    } catch (err) {
      warnings.push(`Color extract from HTML failed: ${(err as Error).message}`);
    }
  }

  // 4) Brandfetch
  if (isWeakOrJunkPalette(colors)) {
    const bf = await fetchBrandfetchColors(businessUrl);
    if (bf && !isWeakOrJunkPalette(bf)) {
      colors = bf;
      warnings.push(`Brand colors from Brandfetch (${colors.source})`);
    }
  }

  // 5) Profile cache
  if (
    isWeakOrJunkPalette(colors) &&
    input.profile?.brandColors &&
    !isWeakOrJunkPalette(input.profile.brandColors) &&
    !/^llm:/i.test(input.profile.brandColors.source || "")
  ) {
    colors = input.profile.brandColors;
    warnings.push("Used brand colors cached on business profile");
  }
  if (!assets && input.profile?.brandAssets) {
    assets = input.profile.brandAssets;
    warnings.push("Used brand assets cached on business profile");
  }
  if (!design && input.profile?.brandDesign) {
    design = input.profile.brandDesign;
  }

  // 6) Grounded LLM last resort
  if (isWeakOrJunkPalette(colors)) {
    const llmColors = await extractColorsViaLlm(
      businessUrl,
      input.profile?.businessName || title,
      pageEvidence ||
        (html && !isChallengeOrEmptyHtml(html) ? html.slice(0, 6000) : null),
    );
    if (llmColors && !isWeakOrJunkPalette(llmColors)) {
      colors = llmColors;
      warnings.push("Brand colors via grounded LLM (page evidence)");
    }
  }

  if (isWeakOrJunkPalette(colors) || !colors) {
    throw new Error(
      `Could not extract real brand colors from ${businessUrl}. Set FIRECRAWL_API_KEY and re-analyze.`,
    );
  }

  // Trust Firecrawl branding as returned; light harmonize only for non-Firecrawl sources
  if (/^firecrawl-branding:/i.test(colors.source || "")) {
    // keep Firecrawl roles intact
  } else {
    colors = html
      ? reconcilePaletteWithHtmlEvidence(colors, html, businessUrl)
      : harmonizeBrandPalette(colors);
  }

  if (isWeakOrJunkPalette(colors)) {
    throw new Error(
      `Brand color extraction for ${businessUrl} produced junk values. Re-run analyze with Firecrawl.`,
    );
  }

  if (!assets) {
    assets = emptyAssets(finalUrl, input.profile?.businessName || title);
  }
  if (!assets.logoUrl) {
    const cdnLogo = await firstReachableImage(logoCdnFallbacks(businessUrl));
    if (cdnLogo) {
      assets = {
        ...assets,
        logoUrl: cdnLogo,
        images: [
          {
            src: cdnLogo,
            alt: assets.siteName || "Logo",
            kind: "logo" as const,
          },
          ...assets.images,
        ],
      };
      warnings.push(
        "Used CDN logo fallback (Clearbit/Google) because site logo was unavailable",
      );
    }
  }

  if (!assets.siteName) {
    assets = {
      ...assets,
      siteName: input.profile?.businessName || title,
    };
  }

  return {
    businessUrl,
    finalUrl: assets.finalUrl || finalUrl,
    colors,
    assets,
    design,
    warnings,
  };
}
