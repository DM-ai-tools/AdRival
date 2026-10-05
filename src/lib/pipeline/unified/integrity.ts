import type { GeneratedLandingImage } from "../../types";
import { placeholderDataUri } from "./contract";

/**
 * Page integrity: every image on the page shows a real picture. An image can
 * break in several ways: a section rewritten with its images held out as
 * tokens (adr-asset://N) comes back with a token; the build's 1x1 stand-in
 * stays in place; a remote address no longer loads inside the page; a srcset
 * points somewhere invalid (browsers prefer it to src); or the data itself
 * does not decode. A broken hero photo also hides its white headline.
 *
 * Every <img> in the page body is checked. A broken one gets, in order: its
 * own generated image (by slot id), a generated image not yet on the page,
 * or a brand-coloured placeholder marked as a slot so "Generate missing
 * images" can fill it.
 */

const TOKEN = "adr-asset://";

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
  return m ? m[1] : null;
}

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}="[^"]*"`, "i");
  const escaped = value.replace(/"/g, "&quot;");
  return re.test(tag) ? tag.replace(re, () => ` ${name}="${escaped}"`) : tag.replace(/^<img\b/i, () => `<img ${name}="${escaped}"`);
}

function dropAttr(tag: string, name: string): string {
  return tag.replace(new RegExp(`\\s${name}="[^"]*"`, "gi"), "");
}

/** Does this data URI hold a real, decodable picture (not a 1x1 stand-in)? */
export function isRealImageData(src: string | null | undefined): boolean {
  const m = String(src || "").match(/^data:image\/([a-z0-9.+-]+);base64,([\s\S]+)$/i);
  if (!m) return false;
  const kind = m[1].toLowerCase();
  let bytes: Buffer;
  try {
    bytes = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  } catch {
    return false;
  }
  if (kind.startsWith("svg")) return /<svg[\s>]/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4000)));
  if (bytes.length < 200) return false;
  const head = bytes.subarray(0, 12);
  const png = head[0] === 0x89 && head.toString("latin1", 1, 4) === "PNG";
  const jpeg = head[0] === 0xff && head[1] === 0xd8;
  const gif = head.toString("latin1", 0, 4) === "GIF8";
  const webp = head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP";
  const avif = bytes.toString("latin1", 4, 12).startsWith("ftyp");
  return png || jpeg || gif || webp || avif;
}

/** The body of the page (where images are checked); the head is left alone. */
function bodyRange(html: string): [number, number] {
  const start = html.search(/<body[\s>]/i);
  const end = html.search(/<\/body>/i);
  return [start < 0 ? 0 : start, end < 0 ? html.length : end];
}

export type ImageRepair = { html: string; fixed: string[] };

/**
 * Check every image in the page body and repair the broken ones.
 * `embedded` maps remote addresses to data URIs fetched beforehand.
 */
export function restoreSlotImages(
  html: string,
  images: GeneratedLandingImage[] | null | undefined,
  colors?: { primary?: string | null; secondary?: string | null; accent?: string | null } | null,
  embedded?: Map<string, string>,
): ImageRepair {
  const real = (images || []).filter((image) => isRealImageData(image.publicUrl));
  const byId = new Map(real.map((image) => [image.id, image]));
  const [from, to] = bodyRange(html);
  const body = html.slice(from, to);
  // Generated images that are not on the page yet can fill broken spots.
  const unused = real.filter((image) => !body.includes(image.publicUrl.slice(-120)));
  const fixed: string[] = [];
  let fixCount = 0;

  const replacements = new Map<string, string>();
  for (const match of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (replacements.has(tag)) continue;
    let next = tag;
    // srcset wins over src in the browser; a bad one breaks a good src.
    const srcset = attr(next, "srcset");
    if (srcset !== null && (srcset.includes(TOKEN) || !/^(https?:|data:image\/)/i.test(srcset.trim()) || /^data:image\/gif/i.test(srcset.trim()))) {
      next = dropAttr(dropAttr(next, "srcset"), "sizes");
    }
    const slot = attr(next, "data-adrival-slot");
    const logo = attr(next, "data-logo-role");
    let src = attr(next, "src") || "";
    const remote = /^https?:\/\//i.test(src) ? embedded?.get(src) : undefined;
    if (remote && isRealImageData(remote)) {
      next = setAttr(next, "src", remote);
      src = remote;
    }
    const ok = isRealImageData(src) && !(slot && byId.has(slot) && /^data:image\/svg/i.test(src) && byId.get(slot)!.publicUrl !== src);
    if (!ok && !logo) {
      const own = slot ? byId.get(slot) : undefined;
      const spare = own ? undefined : unused.shift();
      if (own) {
        next = setAttr(next, "src", own.publicUrl);
      } else if (spare) {
        next = setAttr(setAttr(next, "src", spare.publicUrl), "data-adrival-slot", spare.id);
      } else if (!isRealImageData(src)) {
        const id = slot || `img-fix-${++fixCount}`;
        next = setAttr(
          setAttr(next, "src", placeholderDataUri({ id, purpose: attr(next, "alt") || "", width: 1200, height: 800 }, colors || null)),
          "data-adrival-slot",
          id,
        );
      }
      if (next !== tag) fixed.push(attr(next, "data-adrival-slot") || "image");
    }
    if (next !== tag) replacements.set(tag, next);
  }

  let outBody = body;
  for (const [before, after] of replacements) outBody = outBody.split(before).join(after);
  // Tokens left anywhere else (inline styles, <source> tags) are removed.
  if (outBody.includes(TOKEN)) {
    outBody = outBody
      .replace(/<source\b[^>]*adr-asset:\/\/\d+[^>]*>/gi, "")
      .replace(/url\((["']?)adr-asset:\/\/\d+\1\)/gi, "none")
      .replace(/adr-asset:\/\/\d+/g, "");
    if (!fixed.length) fixed.push("stray image references");
  }
  return { html: html.slice(0, from) + outBody + html.slice(to), fixed };
}

/** Fetch a remote image as a data URI (null when it does not load as an image). */
export async function fetchImageAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126 Safari/537.36" },
    });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 100 || bytes.length > 6_000_000) return null;
    const uri = `data:${type};base64,${bytes.toString("base64")}`;
    return isRealImageData(uri) ? uri : null;
  } catch {
    return null;
  }
}

/** Like restoreSlotImages, but first embeds remote images that still load. */
export async function repairPageImages(
  html: string,
  images: GeneratedLandingImage[] | null | undefined,
  colors?: { primary?: string | null; secondary?: string | null; accent?: string | null } | null,
): Promise<ImageRepair> {
  const [from, to] = bodyRange(html);
  const remotes = [...new Set([...html.slice(from, to).matchAll(/<img\b[^>]*\ssrc="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]))].slice(0, 24);
  const embedded = new Map<string, string>();
  await Promise.all(
    remotes.map(async (url) => {
      const uri = await fetchImageAsDataUri(url);
      if (uri) embedded.set(url, uri);
    }),
  );
  return restoreSlotImages(html, images, colors, embedded);
}

/** True when some image in the page body is broken or a token is left. */
export function hasBrokenImages(html: string): boolean {
  const [from, to] = bodyRange(html);
  const body = html.slice(from, to);
  if (body.includes(TOKEN)) return true;
  for (const match of body.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, "data-logo-role")) continue;
    const srcset = attr(tag, "srcset");
    if (srcset !== null && !/^(https?:|data:image\/)/i.test(srcset.trim())) return true;
    if (!isRealImageData(attr(tag, "src"))) return true;
  }
  return false;
}
