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
    const data = dataUriForPublicPath(value);
    if (data) {
      embedded += 1;
      return data;
    }
    if (/^https?:/i.test(value) && !value.startsWith("data:")) external.push(value.split("?")[0]);
    return value;
  };
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src) $(el).attr("src", rewrite(src));
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
