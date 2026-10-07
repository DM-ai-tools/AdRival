import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

/** Data URIs shorter than this are icons, bullets or dividers, not photos. */
const MIN_PHOTO_CHARS = 4000;

export type RepeatedImage = {
  /** Where the image shows, e.g. `"Team at work" (in "Meet the team")`. */
  places: string[];
  count: number;
};

function identity(src: string): string | null {
  const value = src.trim();
  if (!value) return null;
  if (value.startsWith("data:")) {
    if (/^data:image\/svg/i.test(value)) return null;
    if (value.length < MIN_PHOTO_CHARS) return null;
    return `data:${createHash("sha1").update(value).digest("hex")}`;
  }
  if (/\.svg(\?|#|$)/i.test(value)) return null;
  if (!/^(https?:)?\/\//i.test(value)) return null;
  // The same file with different resize/cache parameters is the same image.
  return value.replace(/^https?:/i, "").replace(/[?#].*$/, "").toLowerCase();
}

function cssUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) out.push(m[2]);
  return out;
}

/**
 * Photos used more than once on the page (an img, a picture source or a CSS
 * background). The logo is allowed to repeat; icons and SVGs are ignored.
 */
export function repeatedImages(html: string): RepeatedImage[] {
  const $ = cheerio.load(html);
  const seen = new Map<string, string[]>();
  const add = (src: string, place: string) => {
    const key = identity(src);
    if (!key) return;
    seen.set(key, [...(seen.get(key) || []), place]);
  };
  const sectionOf = (el: Parameters<typeof $>[0]) => {
    const heading = $(el).closest("section, header, footer, main > div").find("h1, h2, h3").first().text().replace(/\s+/g, " ").trim();
    return heading ? ` (in "${heading.slice(0, 60)}")` : "";
  };
  // A looping marquee or carousel repeats its items on purpose (copies are aria-hidden or marked as clones).
  const isLoopCopy = (el: Parameters<typeof $>[0]) =>
    $(el).closest('[aria-hidden="true"], .swiper-slide-duplicate, .slick-cloned, .splide__slide--clone, [class*="clone"], [class*="marquee"], [class*="ticker"]').length > 0;
  const isLogo = (el: Parameters<typeof $>[0]) => {
    const node = $(el);
    const text = [node.attr("alt"), node.attr("class"), node.attr("id"), node.parent().attr("class"), node.attr("data-logo-role")]
      .filter(Boolean)
      .join(" ");
    return /logo|brand-mark|wordmark/i.test(text);
  };

  $("img").each((_, el) => {
    if (isLogo(el) || isLoopCopy(el)) return;
    const src = $(el).attr("src") || ($(el).attr("srcset") || "").split(/\s+/)[0] || "";
    const alt = ($(el).attr("alt") || "").trim();
    add(src, `${alt ? `"${alt.slice(0, 60)}"` : "an image"}${sectionOf(el)}`);
  });
  $("picture source[srcset]").each((_, el) => {
    // A <source> repeats its own <img>; count it only when the picture has no img.
    if ($(el).parent().find("img").length || isLoopCopy(el)) return;
    add(($(el).attr("srcset") || "").split(/\s+/)[0] || "", `an image${sectionOf(el)}`);
  });
  $("[style]").each((_, el) => {
    if (isLogo(el) || isLoopCopy(el)) return;
    for (const url of cssUrls($(el).attr("style") || "")) add(url, `a background${sectionOf(el)}`);
  });
  $("style").each((_, el) => {
    const css = $(el).html() || "";
    // Rules whose selector names a logo are allowed to repeat.
    for (const rule of css.split("}")) {
      const [selector, body = ""] = rule.split("{");
      if (/logo/i.test(selector || "")) continue;
      for (const url of cssUrls(body)) add(url, `a background (${(selector || "").trim().slice(0, 40)})`);
    }
  });

  return [...seen.values()].filter((places) => places.length > 1).map((places) => ({ places, count: places.length }));
}

/** One line per repeated image, for the agent and for the review notes. */
export function describeRepeats(repeats: RepeatedImage[]): string[] {
  return repeats.map((r) => `${r.count} places: ${r.places.join("; ")}`);
}
