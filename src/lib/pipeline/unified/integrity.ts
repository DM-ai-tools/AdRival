import type { BrandColors, GeneratedLandingImage } from "../../types";
import { applyImageSlotsToHtml, placeholderDataUri } from "./contract";

/**
 * Page integrity: every image slot carries a real image. A section rewritten
 * with its images held out as short tokens (adr-asset://N) can come back with
 * a token, an empty src or a 1x1 stand-in, which the browser shows as a broken
 * image; a hero then loses its dark photo and its white headline disappears.
 */

const TOKEN_RE = /adr-asset:\/\/\d+/g;
const REAL_IMAGE = /^data:image\/(png|jpe?g|webp|avif|svg\+xml);base64,[A-Za-z0-9+/=]{200,}/i;

function srcOf(tag: string): string {
  return tag.match(/\ssrc="([^"]*)"/i)?.[1] || "";
}

/**
 * Put every generated image back into its slot (by slot id), and give slots
 * with no image a brand-coloured placeholder. Leftover tokens elsewhere
 * (inline styles) are removed.
 */
export function restoreSlotImages(
  html: string,
  images: GeneratedLandingImage[] | null | undefined,
  colors?: Pick<BrandColors, "primary" | "secondary" | "accent"> | null,
): { html: string; fixed: string[] } {
  const byId = new Map((images || []).filter((image) => REAL_IMAGE.test(image.publicUrl || "")).map((image) => [image.id, image]));
  const fixes = new Map<string, string>();
  const fixed: string[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bdata-adrival-slot="([^"]+)"/i)?.[1];
    if (!id || fixes.has(id)) continue;
    const src = srcOf(tag);
    const stored = byId.get(id);
    // A real image stays, unless a generated image exists and the slot shows a stand-in.
    if (REAL_IMAGE.test(src) && !/svg\+xml/i.test(src)) continue;
    if (REAL_IMAGE.test(src) && /svg\+xml/i.test(src) && !stored) continue;
    if (stored && stored.publicUrl !== src) {
      fixes.set(id, stored.publicUrl);
      fixed.push(id);
    } else if (!stored && !REAL_IMAGE.test(src)) {
      fixes.set(id, placeholderDataUri({ id, purpose: "", width: 1200, height: 800 }, colors || null));
      fixed.push(id);
    }
  }
  let out = fixes.size ? applyImageSlotsToHtml(html, fixes) : html;
  if (out.includes("adr-asset://")) {
    out = out.replace(/url\((["']?)adr-asset:\/\/\d+\1\)/gi, "none").replace(TOKEN_RE, "");
    if (!fixed.length) fixed.push("stray image references");
  }
  return { html: out, fixed };
}

/** True when some slot shows no real image or a token is left in the page. */
export function hasBrokenImages(html: string): boolean {
  if (/adr-asset:\/\/\d+/.test(html)) return true;
  for (const match of html.matchAll(/<img\b[^>]*data-adrival-slot="[^"]+"[^>]*>/gi)) {
    if (!REAL_IMAGE.test(srcOf(match[0]))) return true;
  }
  return false;
}
