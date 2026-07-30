/**
 * Minimal Firecrawl v2 client (scrape + map).
 * Auth: FIRECRAWL_API_KEY
 */

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

function getApiKey(): string {
  const key = process.env.FIRECRAWL_API_KEY?.trim();
  if (!key) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }
  return key;
}

async function firecrawlPost<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${FIRECRAWL_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Firecrawl ${path} returned non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const errMsg =
      (json as { error?: string } | null)?.error ||
      text.slice(0, 240) ||
      res.statusText;
    throw new Error(`Firecrawl ${path} failed (${res.status}): ${errMsg}`);
  }
  return json as T;
}

export type FirecrawlMapLink = {
  url: string;
  title?: string | null;
  description?: string | null;
};

/** Firecrawl /scrape branding format — BrandingProfile */
export type FirecrawlBrandingProfile = {
  colorScheme?: "light" | "dark" | string;
  logo?: string | null;
  colors?: {
    primary?: string | null;
    secondary?: string | null;
    accent?: string | null;
    background?: string | null;
    textPrimary?: string | null;
    textSecondary?: string | null;
    link?: string | null;
    success?: string | null;
    warning?: string | null;
    error?: string | null;
    brand?: string | null;
    text?: string | null;
    [key: string]: string | null | undefined;
  };
  fonts?: Array<{ family?: string }>;
  typography?: {
    fontFamilies?: {
      primary?: string;
      heading?: string;
      code?: string;
      [key: string]: string | undefined;
    };
    fontSizes?: Record<string, string>;
    fontWeights?: Record<string, number | string>;
    lineHeights?: Record<string, string | number>;
  };
  spacing?: {
    baseUnit?: number;
    borderRadius?: string;
    padding?: string | Record<string, string>;
    margins?: string | Record<string, string>;
  };
  components?: {
    buttonPrimary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      borderColor?: string;
    };
    buttonSecondary?: {
      background?: string;
      textColor?: string;
      borderRadius?: string;
      borderColor?: string;
    };
    input?: Record<string, string>;
    [key: string]: unknown;
  };
  images?: {
    logo?: string | null;
    favicon?: string | null;
    ogImage?: string | null;
  };
  icons?: Record<string, unknown>;
  animations?: Record<string, unknown>;
  layout?: Record<string, unknown>;
  personality?: {
    tone?: string;
    energy?: string;
    targetAudience?: string;
    [key: string]: unknown;
  };
};

export type FirecrawlScrapeResult = {
  success?: boolean;
  data?: {
    markdown?: string | null;
    html?: string | null;
    links?: string[];
    branding?: FirecrawlBrandingProfile | null;
    metadata?: {
      title?: string | null;
      description?: string | null;
      sourceURL?: string | null;
      url?: string | null;
    };
    json?: Record<string, unknown> | null;
  };
};

export async function firecrawlMapSite(
  url: string,
  options?: { limit?: number; search?: string },
): Promise<FirecrawlMapLink[]> {
  const data = await firecrawlPost<{
    success?: boolean;
    links?: FirecrawlMapLink[];
  }>("/map", {
    url,
    limit: options?.limit ?? 80,
    includeSubdomains: false,
    ignoreQueryParameters: true,
    sitemap: "include",
    ...(options?.search ? { search: options.search } : {}),
  });
  return (data.links || []).filter((l) => l?.url);
}

/**
 * Brand identity scrape: branding + links + html + markdown.
 * Falls back to html/markdown/links when branding script crashes on the page.
 * @see https://docs.firecrawl.dev/features/scrape#extract-brand-identity
 */
export async function firecrawlScrapeBranding(
  url: string,
): Promise<FirecrawlScrapeResult> {
  try {
    return await firecrawlPost<FirecrawlScrapeResult>("/scrape", {
      url,
      formats: ["branding", "links", "html", "markdown"],
      onlyMainContent: false,
      waitFor: 2000,
      blockAds: true,
      proxy: "auto",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Branding extractor can throw on some sites; still get markup + links
    if (/brand|ActionError|Javascript execution failed|500/i.test(msg)) {
      console.warn(
        "[firecrawl] branding format failed — falling back to html/links/markdown",
        msg.slice(0, 200),
      );
      const fallback = await firecrawlPost<FirecrawlScrapeResult>("/scrape", {
        url,
        formats: ["links", "html", "markdown"],
        onlyMainContent: false,
        waitFor: 2500,
        blockAds: true,
        proxy: "auto",
      });
      // Try branding-only as a second chance (sometimes combined formats trip it)
      try {
        const brandOnly = await firecrawlPost<FirecrawlScrapeResult>("/scrape", {
          url,
          formats: ["branding"],
          onlyMainContent: false,
          waitFor: 2000,
          blockAds: true,
          proxy: "auto",
        });
        if (brandOnly.data?.branding) {
          return {
            ...fallback,
            data: {
              ...fallback.data,
              branding: brandOnly.data.branding,
            },
          };
        }
      } catch {
        // ignore branding-only failure
      }
      return fallback;
    }
    throw err;
  }
}

export async function firecrawlScrapePage(
  url: string,
): Promise<FirecrawlScrapeResult> {
  return firecrawlPost<FirecrawlScrapeResult>("/scrape", {
    url,
    formats: [
      "links",
      "html",
      "markdown",
      {
        type: "json",
        prompt: `Extract the website's real navigation, footer, social, and service/product page links.
Return only links that appear on this site. Prefer specific page URLs — never collapse everything to the homepage.
Labels should be the visible link text.`,
        schema: {
          type: "object",
          properties: {
            siteName: { type: "string" },
            navLinks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  href: { type: "string" },
                },
                required: ["label", "href"],
              },
            },
            footerLinks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  href: { type: "string" },
                },
                required: ["label", "href"],
              },
            },
            socialLinks: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  href: { type: "string" },
                },
                required: ["label", "href"],
              },
            },
            servicePages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  href: { type: "string" },
                },
                required: ["label", "href"],
              },
            },
          },
        },
      },
    ],
    onlyMainContent: false,
    waitFor: 1500,
    blockAds: true,
    proxy: "auto",
  });
}

/**
 * Lightweight HTML scrape for offer/page analysis when direct fetch is blocked.
 */
export async function firecrawlScrapeHtml(
  url: string,
): Promise<FirecrawlScrapeResult> {
  return firecrawlPost<FirecrawlScrapeResult>("/scrape", {
    url,
    formats: ["html", "markdown"],
    onlyMainContent: false,
    waitFor: 2500,
    blockAds: true,
    proxy: "auto",
  });
}

export function hasFirecrawlKey(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY?.trim());
}
