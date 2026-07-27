import * as cheerio from "cheerio";
import { fetchRawLandingHtml } from "./htmlFetch";

export type BrandLink = {
  label: string;
  href: string;
};

export type BrandImage = {
  src: string;
  alt?: string;
  kind: "logo" | "hero" | "content" | "icon" | "og";
};

export type BrandSiteAssets = {
  finalUrl: string;
  siteName: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  navLinks: BrandLink[];
  footerLinks: BrandLink[];
  socialLinks: BrandLink[];
  images: BrandImage[];
  emails: string[];
  phones: string[];
};

function absolutize(baseUrl: string, value: string): string {
  const v = value.trim();
  if (
    !v ||
    v.startsWith("data:") ||
    v.startsWith("mailto:") ||
    v.startsWith("tel:") ||
    v.startsWith("#") ||
    v.startsWith("javascript:")
  ) {
    return v;
  }
  try {
    return new URL(v, baseUrl).toString();
  } catch {
    return v;
  }
}

function normalizeText(t: string): string {
  return t.replace(/\s+/g, " ").trim();
}

function looksLikeLogo(src: string, alt = "", className = "", id = ""): boolean {
  const hay = `${src} ${alt} ${className} ${id}`.toLowerCase();
  if (/handshake|people|team|photo|hero|banner|stock|testimonial|portrait/i.test(hay)) {
    return false;
  }
  return /logo|brand|site-title|navbar-brand|header__logo|masthead|wordmark|logotype/i.test(
    hay,
  );
}

function looksLikeIcon(src: string, alt = "", className = ""): boolean {
  const hay = `${src} ${alt} ${className}`.toLowerCase();
  return /favicon|icon|sprite|pixel|tracking|1x1|spacer|badge|avatar|emoji|social/i.test(
    hay,
  );
}

function looksLikePhoto(src: string, alt = "", className = ""): boolean {
  const hay = `${src} ${alt} ${className}`.toLowerCase();
  return /handshake|people|team|photo|portrait|stock|unsplash|pexels|testimonial|hero-image|banner-image|shutterstock/i.test(
    hay,
  );
}

function looksSocial(href: string, label = ""): boolean {
  return Boolean(detectSocialNetwork(href, label));
}

export type SocialNetwork =
  | "facebook"
  | "instagram"
  | "linkedin"
  | "youtube"
  | "tiktok"
  | "twitter"
  | "pinterest"
  | "threads";

/** Detect which social network a link/label refers to. */
export function detectSocialNetwork(
  href: string,
  label = "",
  className = "",
): SocialNetwork | null {
  const hay = `${href} ${label} ${className}`.toLowerCase();
  if (/instagram\.com|\/\/instagr\.am|\bign\b|instagram/i.test(hay)) return "instagram";
  if (/facebook\.com|fb\.com|fb\.me|\bfb\b|facebook/i.test(hay)) return "facebook";
  if (/linkedin\.com|linkedin/i.test(hay)) return "linkedin";
  if (/youtube\.com|youtu\.be|youtube/i.test(hay)) return "youtube";
  if (/tiktok\.com|tiktok/i.test(hay)) return "tiktok";
  if (/twitter\.com|\bx\.com\b|(^|[^a-z])x([^a-z]|$)|twitter|\btwitter\b/i.test(hay)) {
    return "twitter";
  }
  if (/pinterest\.com|pinterest/i.test(hay)) return "pinterest";
  if (/threads\.net|threads/i.test(hay)) return "threads";
  return null;
}

function socialLabel(network: SocialNetwork): string {
  switch (network) {
    case "facebook":
      return "Facebook";
    case "instagram":
      return "Instagram";
    case "linkedin":
      return "LinkedIn";
    case "youtube":
      return "YouTube";
    case "tiktok":
      return "TikTok";
    case "twitter":
      return "X / Twitter";
    case "pinterest":
      return "Pinterest";
    case "threads":
      return "Threads";
  }
}

function dedupeSocialByNetwork(links: BrandLink[]): BrandLink[] {
  const byNet = new Map<SocialNetwork, BrandLink>();
  for (const link of links) {
    const net = detectSocialNetwork(link.href, link.label);
    if (!net) continue;
    if (!byNet.has(net)) byNet.set(net, { ...link, label: socialLabel(net) });
  }
  return [...byNet.values()];
}

function dedupeLinks(links: BrandLink[]): BrandLink[] {
  const seen = new Set<string>();
  const out: BrandLink[] = [];
  for (const link of links) {
    const key = `${link.label.toLowerCase()}|${link.href}`;
    if (seen.has(key)) continue;
    if (!link.href || link.href === "#" || link.href.startsWith("javascript:")) {
      continue;
    }
    seen.add(key);
    out.push(link);
  }
  return out;
}

function pickBestLogo(
  candidates: Array<{ src: string; score: number }>,
): string | null {
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].src;
}

/**
 * Extract logo, footer/nav links, and reusable images from the user's website HTML.
 */
export function extractBrandAssetsFromHtml(
  html: string,
  baseUrl: string,
): BrandSiteAssets {
  const $ = cheerio.load(html);
  const logoCandidates: Array<{ src: string; score: number }> = [];
  const images: BrandImage[] = [];
  const navLinks: BrandLink[] = [];
  const footerLinks: BrandLink[] = [];
  const socialLinks: BrandLink[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();

  const siteName =
    normalizeText(
      $('meta[property="og:site_name"]').attr("content") ||
        $("title").first().text() ||
        "",
    ) || null;

  const ogImageRaw = $('meta[property="og:image"]').attr("content");
  const ogImageUrl = ogImageRaw ? absolutize(baseUrl, ogImageRaw) : null;
  if (ogImageUrl) {
    images.push({ src: ogImageUrl, alt: siteName || undefined, kind: "og" });
  }

  let faviconUrl: string | null = null;
  $('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]').each(
    (_, el) => {
      const href = $(el).attr("href");
      if (!href || faviconUrl) return;
      faviconUrl = absolutize(baseUrl, href);
    },
  );

  // Images
  $("img[src]").each((_, el) => {
    const $el = $(el);
    const src = absolutize(baseUrl, $el.attr("src") || "");
    if (!src || src.startsWith("data:")) return;
    const alt = $el.attr("alt") || "";
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""} ${$el.parent().parent().attr("class") || ""}`;
    const id = $el.attr("id") || "";
    const inHeader =
      $el.closest(
        "header, nav, [role='banner'], .navbar, .header, .site-header, .masthead",
      ).length > 0;
    const inFooter =
      $el.closest("footer, [role='contentinfo'], .footer").length > 0;
    const width = Number($el.attr("width") || 0);
    const height = Number($el.attr("height") || 0);

    if (looksLikePhoto(src, alt, className)) {
      images.push({
        src,
        alt,
        kind: inHeader ? "content" : "content",
      });
      return;
    }

    if (looksLikeLogo(src, alt, className, id)) {
      let score = 12;
      if (inHeader) score += 6;
      if (/logo/i.test(alt)) score += 4;
      if (/logo/i.test(src)) score += 5;
      if (/\.svg(\?|$)/i.test(src)) score += 3;
      if (/\.png(\?|$)/i.test(src)) score += 1;
      logoCandidates.push({ src, score });
      images.push({ src, alt, kind: "logo" });
      return;
    }

    // Header / nav image that isn't a photo and is logo-sized → likely logo
    if (
      inHeader &&
      !inFooter &&
      !looksLikeIcon(src, alt, className) &&
      !looksLikePhoto(src, alt, className)
    ) {
      const smallish =
        (height > 0 && height <= 120) ||
        (width > 0 && width <= 280) ||
        (height === 0 && width === 0);
      if (smallish) {
        let score = 7;
        if (/\.svg(\?|$)/i.test(src)) score += 3;
        if (siteName && alt.toLowerCase().includes(siteName.toLowerCase().slice(0, 6))) {
          score += 4;
        }
        logoCandidates.push({ src, score });
        images.push({ src, alt, kind: "logo" });
        return;
      }
    }

    if (looksLikeIcon(src, alt, className) || inFooter) {
      images.push({ src, alt, kind: "icon" });
      return;
    }

    const isTiny = (width > 0 && width < 64) || (height > 0 && height < 64);
    if (isTiny) {
      images.push({ src, alt, kind: "icon" });
      return;
    }

    const inHero =
      $el.closest(
        "hero, .hero, .banner, .jumbotron, [class*='hero'], [class*='Hero'], main, section",
      ).length > 0;
    images.push({
      src,
      alt,
      kind:
        inHero && images.filter((i) => i.kind === "hero").length === 0
          ? "hero"
          : "content",
    });
  });

  // picture/source logos
  $("header source[srcset], nav source[srcset], .logo source[srcset]").each(
    (_, el) => {
      const srcset = $(el).attr("srcset") || "";
      const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
      if (!first) return;
      const src = absolutize(baseUrl, first);
      logoCandidates.push({ src, score: 8 });
      images.push({ src, kind: "logo" });
    },
  );

  // CSS background logos in header (url(...))
  $("header [style*='url('], nav [style*='url('], .logo[style*='url(']").each(
    (_, el) => {
      const style = $(el).attr("style") || "";
      const m = style.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
      if (!m?.[1]) return;
      const src = absolutize(baseUrl, m[1]);
      if (!src || src.startsWith("data:")) return;
      logoCandidates.push({ src, score: 8 });
      images.push({ src, kind: "logo" });
    },
  );

  // Nav links
  $("header a[href], nav a[href], [role='navigation'] a[href], .navbar a[href]").each(
    (_, el) => {
      const $el = $(el);
      const href = absolutize(baseUrl, $el.attr("href") || "");
      const label =
        normalizeText($el.text()) ||
        $el.attr("aria-label") ||
        $el.attr("title") ||
        "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const network = detectSocialNetwork(href, label, className);
      if (network) {
        socialLinks.push({ label: socialLabel(network), href });
        return;
      }
      if (!label || label.length > 48) return;
      navLinks.push({ label, href });
    },
  );

  // Footer links (include icon-only social anchors)
  $("footer a[href], [role='contentinfo'] a[href], .footer a[href], [class*='Footer'] a[href]").each(
    (_, el) => {
      const $el = $(el);
      const href = absolutize(baseUrl, $el.attr("href") || "");
      const label =
        normalizeText($el.text()) ||
        $el.attr("aria-label") ||
        $el.attr("title") ||
        "";
      const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
      const network = detectSocialNetwork(href, label, className);
      if (network) {
        socialLinks.push({ label: socialLabel(network), href });
        return;
      }
      if (!label || label.length > 60) return;
      footerLinks.push({ label, href });
    },
  );

  // Site-wide social harvest (icon-only links anywhere: header widgets, share bars, etc.)
  $("a[href]").each((_, el) => {
    const $el = $(el);
    const href = absolutize(baseUrl, $el.attr("href") || "");
    const label =
      normalizeText($el.text()) ||
      $el.attr("aria-label") ||
      $el.attr("title") ||
      "";
    const className = `${$el.attr("class") || ""} ${$el.parent().attr("class") || ""}`;
    const network = detectSocialNetwork(href, label, className);
    if (!network) return;
    // Prefer profile/pages over share intents
    if (/[?&](share|u|url)=/i.test(href)) return;
    socialLinks.push({ label: socialLabel(network), href });
  });

  // Regex backup: catch social profile URLs even if markup is unusual
  for (const m of html.matchAll(
    /https?:\/\/(?:www\.)?(?:facebook\.com|instagram\.com|linkedin\.com|youtube\.com|youtu\.be|tiktok\.com|twitter\.com|x\.com|pinterest\.com|threads\.net)\/[^\s"'<>)\\]+/gi,
  )) {
    let href = m[0].replace(/[.,;]+$/, "");
    try {
      href = new URL(href).toString();
    } catch {
      continue;
    }
    if (/[?&](share|u|url)=/i.test(href)) continue;
    const network = detectSocialNetwork(href);
    if (!network) continue;
    socialLinks.push({ label: socialLabel(network), href });
  }

  // mailto / tel anywhere
  $("a[href^='mailto:'], a[href^='tel:']").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (href.startsWith("mailto:")) {
      const email = href.replace(/^mailto:/i, "").split("?")[0].trim();
      if (email) emails.add(email);
    }
    if (href.startsWith("tel:")) {
      const phone = href.replace(/^tel:/i, "").trim();
      if (phone) phones.add(phone);
    }
  });

  // Fallback: if no footer links, use remaining nav-ish page links
  if (footerLinks.length === 0) {
    $("a[href]").each((_, el) => {
      const href = absolutize(baseUrl, $(el).attr("href") || "");
      const label = normalizeText($(el).text());
      if (!label || label.length < 2 || label.length > 40) return;
      if (looksSocial(href, label)) return;
      if (/privacy|terms|about|contact|careers|blog|support|faq|cookie/i.test(label + href)) {
        footerLinks.push({ label, href });
      }
    });
  }

  // Prefer real logo; fall back to apple-touch-icon (usually a clean brand mark)
  let logoUrl = pickBestLogo(logoCandidates.filter((c) => c.score > 0));
  if (!logoUrl && faviconUrl && !/favicon\.ico/i.test(faviconUrl)) {
    logoUrl = faviconUrl;
  }
  $('link[rel="apple-touch-icon"]').each((_, el) => {
    if (logoUrl) return;
    const href = $(el).attr("href");
    if (href) logoUrl = absolutize(baseUrl, href);
  });

  // Ensure we have at least one hero candidate
  if (!images.some((i) => i.kind === "hero") && ogImageUrl) {
    images.unshift({ src: ogImageUrl, kind: "hero", alt: siteName || undefined });
  }

  return {
    finalUrl: baseUrl,
    siteName,
    logoUrl,
    faviconUrl,
    ogImageUrl,
    navLinks: dedupeLinks(navLinks).slice(0, 12),
    footerLinks: dedupeLinks(footerLinks).slice(0, 24),
    socialLinks: dedupeSocialByNetwork(socialLinks).slice(0, 12),
    images: (() => {
      const seen = new Set<string>();
      const out: BrandImage[] = [];
      for (const img of images) {
        if (seen.has(img.src)) continue;
        seen.add(img.src);
        out.push(img);
      }
      return out.slice(0, 40);
    })(),
    emails: [...emails].slice(0, 5),
    phones: [...phones].slice(0, 5),
  };
}

export async function fetchBrandSiteAssets(
  businessUrl: string,
): Promise<BrandSiteAssets> {
  const fetched = await fetchRawLandingHtml(businessUrl);
  return extractBrandAssetsFromHtml(fetched.html, fetched.finalUrl);
}
