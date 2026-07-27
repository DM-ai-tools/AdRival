const MAX_HTML_CHARS = 350_000;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

async function tryFetch(url: string): Promise<Response> {
  return fetch(url, {
    redirect: "follow",
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
}

/**
 * Fetch landing-page HTML with URL cleanup + retries for common 403/blocked cases.
 */
export async function fetchRawLandingHtml(url: string): Promise<{
  finalUrl: string;
  title: string | null;
  html: string;
}> {
  const candidates = buildFetchCandidates(url);
  if (candidates.length === 0) {
    throw new Error(`Could not normalize landing URL: ${url}`);
  }

  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      const res = await tryFetch(candidate);
      if (!res.ok) {
        lastError = new Error(
          `Landing page fetch failed (${res.status}) for ${candidate}`,
        );
        // Retry next candidate on 401/403/429/5xx
        if ([401, 403, 429, 500, 502, 503, 520, 521, 522, 523, 524].includes(res.status)) {
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
      // Soft challenge pages often return tiny HTML / captcha shells
      if (html.length < 200 && /captcha|access denied|just a moment|cf-browser/i.test(html)) {
        lastError = new Error(
          `Landing page blocked by bot protection for ${candidate}`,
        );
        continue;
      }

      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch?.[1]
        ? titleMatch[1].replace(/\s+/g, " ").trim()
        : null;

      return {
        finalUrl: res.url || candidate,
        title,
        html,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw (
    lastError ||
    new Error(`Landing page fetch failed for ${url}`)
  );
}
