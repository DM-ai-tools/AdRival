import type { BrandColors, BusinessProfile } from "../types";
import {
  extractBrandColors,
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

const DEFAULT_COLORS: BrandColors = {
  primary: "#0F7A6C",
  secondary: "#134E4A",
  accent: "#F59E0B",
  background: "#FFFFFF",
  text: "#0F172A",
  muted: "#64748B",
  source: "fallback",
};

export type BrandBundle = {
  businessUrl: string;
  finalUrl: string;
  colors: BrandColors;
  assets: BrandSiteAssets | null;
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
    const u = new URL(normalized.startsWith("http") ? normalized : `https://${normalized}`);
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
      // clearbit returns 200 with tiny placeholder sometimes — accept anyway
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
): Promise<BrandColors | null> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return null;
  }

  const prompt = `You know public brand websites. Infer the main brand palette used on this company's website UI (buttons, links, logo accents) — not random decorative colors.

Business: ${businessName || "unknown"}
URL: ${businessUrl}

Return ONLY JSON:
{ "primary": "#RRGGBB", "secondary": "#RRGGBB", "accent": "#RRGGBB", "background": "#RRGGBB", "text": "#RRGGBB", "muted": "#RRGGBB" }

Rules:
- Use real hex from their site branding when you know it (e.g. logo / primary CTA).
- Prefer saturated brand colors for primary/accent.
- background usually near-white; text near-black/dark navy.
- If uncertain, still give your best estimate from their public branding.`;

  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const client = getAnthropicClient();
      const completion = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 400,
        temperature: 0.1,
        messages: [{ role: "user", content: prompt }],
      });
      const content = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]) as Record<string, string>;
      const primary = normalizeHex(parsed.primary || "");
      if (!primary) return null;
      return {
        primary,
        secondary: normalizeHex(parsed.secondary || "") || DEFAULT_COLORS.secondary,
        accent: normalizeHex(parsed.accent || "") || DEFAULT_COLORS.accent,
        background: normalizeHex(parsed.background || "") || "#FFFFFF",
        text: normalizeHex(parsed.text || "") || "#0F172A",
        muted: normalizeHex(parsed.muted || "") || DEFAULT_COLORS.muted,
        source: `llm:${businessUrl}`,
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
 * Strictly resolve brand colors + assets from the user-entered business URL.
 * Live HTML/CSS first; profile cache + logo CDNs + LLM colors as fallbacks.
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

  // 1) Live fetch with www / origin variants
  for (const candidate of withWwwVariants(businessUrl)) {
    try {
      const fetched = await fetchRawLandingHtml(candidate);
      if (fetched.html && fetched.html.length > 500) {
        // Reject obvious Cloudflare challenge shells
        if (
          /just a moment|cf-browser-verification|challenge-platform|attention required/i.test(
            fetched.html,
          ) &&
          fetched.html.length < 100_000
        ) {
          warnings.push(`Blocked/challenge HTML from ${candidate}`);
          continue;
        }
        html = fetched.html;
        finalUrl = fetched.finalUrl;
        title = fetched.title || title;
        break;
      }
    } catch (err) {
      warnings.push(
        `Fetch failed for ${candidate}: ${(err as Error).message || String(err)}`,
      );
    }
  }

  let colors: BrandColors | null = null;
  let assets: BrandSiteAssets | null = null;

  if (html) {
    try {
      colors = await extractBrandColorsFromHtml(html, finalUrl);
    } catch (err) {
      warnings.push(`Color extract from HTML failed: ${(err as Error).message}`);
    }
    try {
      assets = extractBrandAssetsFromHtml(html, finalUrl);
    } catch (err) {
      warnings.push(`Asset extract from HTML failed: ${(err as Error).message}`);
    }
  } else {
    // Direct helpers as secondary attempt
    try {
      colors = await extractBrandColors(businessUrl);
      if (colors.source?.includes("fallback")) {
        warnings.push("extractBrandColors returned fallback palette");
      }
    } catch (err) {
      warnings.push(`extractBrandColors failed: ${(err as Error).message}`);
    }
    try {
      assets = await fetchBrandSiteAssets(businessUrl);
    } catch (err) {
      warnings.push(`fetchBrandSiteAssets failed: ${(err as Error).message}`);
    }
  }

  // 2) Profile cache (from earlier Analyze URL)
  if (
    (!colors || colors.source?.includes("fallback")) &&
    input.profile?.brandColors &&
    !input.profile.brandColors.source?.includes("fallback")
  ) {
    colors = input.profile.brandColors;
    warnings.push("Used brand colors cached on business profile");
  }
  if (!assets && input.profile?.brandAssets) {
    assets = input.profile.brandAssets;
    warnings.push("Used brand assets cached on business profile");
  }

  // 3) LLM color inference when HTML blocked
  if (!colors || colors.source?.includes("fallback")) {
    const llmColors = await extractColorsViaLlm(
      businessUrl,
      input.profile?.businessName || title,
    );
    if (llmColors) {
      colors = llmColors;
      warnings.push("Inferred brand colors via Claude (site HTML blocked)");
    }
  }

  if (!colors) {
    colors = { ...DEFAULT_COLORS, source: `fallback:${businessUrl}` };
    warnings.push("Fell back to default palette — could not read site colors");
  }

  // 4) Logo CDN fallbacks when site blocked / no logo found
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
          { src: cdnLogo, alt: assets.siteName || "Logo", kind: "logo" as const },
          ...assets.images,
        ],
      };
      warnings.push("Used CDN logo fallback (Clearbit/Google) because site logo was unavailable");
    }
  }

  // Ensure siteName
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
    warnings,
  };
}
