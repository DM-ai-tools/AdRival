import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";

function dataUriForPublicPath(url: string): string | null {
  const clean = url.split("?")[0];
  const match = clean.match(/\/generated\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const file = path.join(process.cwd(), "public", "generated", decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".svg" ? "image/svg+xml" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Preview and download must be this same document, with app-hosted images embedded. */
export function packagePortableHtml(html: string): { html: string; embedded: number; external: string[] } {
  const $ = cheerio.load(html);
  let embedded = 0;
  const external: string[] = [];
  const rewrite = (value: string): string => {
    if (!value || value.startsWith("data:")) return value;
    const data = dataUriForPublicPath(value);
    if (data) {
      embedded += 1;
      return data;
    }
    if (/^https?:/i.test(value)) external.push(value.split("?")[0]);
    return value;
  };
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src) {
      $(el).attr("src", rewrite(src));
      if (($(el).attr("src") || "").startsWith("data:")) $(el).removeAttr("loading");
    }
  });
  $("[srcset]").each((_, el) => {
    const next = ($(el).attr("srcset") || "")
      .split(",")
      .map((part) => {
        const [url, size] = part.trim().split(/\s+/, 2);
        return `${rewrite(url)}${size ? ` ${size}` : ""}`;
      })
      .join(", ");
    $(el).attr("srcset", next);
  });
  $("[style]").each((_, el) => {
    const style = $(el).attr("style") || "";
    $(el).attr("style", style.replace(/url\((['"]?)([^'")]+)\1\)/g, (_all, _q, url) => `url("${rewrite(url)}")`));
  });
  if (!$("meta[name='viewport']").length) {
    $("head").append('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  return { html: $.html(), embedded, external: [...new Set(external)].slice(0, 12) };
}

/** Fetch remote http(s) images and rewrite them to data URIs for portable HTML. */
export async function embedRemoteImagesInHtml(
  html: string,
  options?: { maxImages?: number; timeoutMs?: number; maxBytes?: number },
): Promise<{ html: string; embedded: number }> {
  const maxImages = options?.maxImages ?? 12;
  const timeoutMs = options?.timeoutMs ?? 8000;
  const maxBytes = options?.maxBytes ?? 1_500_000;
  const $ = cheerio.load(html);
  const cache = new Map<string, string | null>();
  let embedded = 0;

  const fetchOne = async (url: string): Promise<string | null> => {
    if (cache.has(url)) return cache.get(url) || null;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "image/*,*/*;q=0.8" },
      });
      if (!response.ok) {
        cache.set(url, null);
        return null;
      }
      const mime = (response.headers.get("content-type") || "image/png").split(";")[0].trim();
      if (!mime.startsWith("image/")) {
        cache.set(url, null);
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 32 || bytes.length > maxBytes) {
        cache.set(url, null);
        return null;
      }
      const data = `data:${mime};base64,${bytes.toString("base64")}`;
      cache.set(url, data);
      return data;
    } catch {
      cache.set(url, null);
      return null;
    }
  };

  const jobs: Array<Promise<void>> = [];
  $("img[src]").each((_, el) => {
    const src = ($(el).attr("src") || "").trim();
    if (!/^https?:/i.test(src)) return;
    if (jobs.length >= maxImages) return;
    jobs.push(
      (async () => {
        const data = await fetchOne(src);
        if (data) {
          $(el).attr("src", data).removeAttr("loading").removeAttr("srcset");
          embedded += 1;
        }
      })(),
    );
  });
  await Promise.all(jobs);
  return { html: $.html(), embedded };
}
