/**
 * Firecrawl screenshot capture for vision-guided recreate + offer analysis.
 * Screenshots are downscaled to Anthropic's max dimension (8000px).
 * @see https://www.firecrawl.dev/glossary/web-scraping-apis/firecrawl-screenshot-instead-of-playwright
 * @see https://docs.firecrawl.dev/features/scrape
 */

import sharp from "sharp";
import {
  firecrawlScrapeScreenshot,
  hasFirecrawlKey,
} from "../firecrawl/client";

export type CompetitorScreenshotTile = {
  id: string;
  /** raw base64 (no data: prefix) */
  data: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  label: string;
  sourceUrl: string;
};

/** Anthropic rejects any side > 8000px; keep a margin. */
const MAX_VISION_EDGE = 7500;
const MAX_DOWNLOAD_BYTES = 12_000_000;
const MAX_OUTPUT_BYTES = 3_500_000;

/**
 * Fit image under Anthropic vision limits and emit JPEG for smaller payloads.
 */
export async function prepareVisionImage(
  bytes: Buffer,
): Promise<{ data: string; mediaType: "image/jpeg" } | null> {
  try {
    const image = sharp(bytes, { failOn: "none", animated: false });
    const meta = await image.metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) return null;

    let pipeline = image.rotate(); // honor EXIF
    const longEdge = Math.max(width, height);
    if (longEdge > MAX_VISION_EDGE) {
      if (width >= height) {
        pipeline = pipeline.resize({
          width: MAX_VISION_EDGE,
          withoutEnlargement: true,
        });
      } else {
        pipeline = pipeline.resize({
          height: MAX_VISION_EDGE,
          withoutEnlargement: true,
        });
      }
    }

    let quality = 72;
    let out = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
    // Shrink further if still huge (very tall pages after width clamp).
    while (out.length > MAX_OUTPUT_BYTES && quality > 40) {
      quality -= 10;
      out = await sharp(out).jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    if (out.length < 800 || out.length > MAX_OUTPUT_BYTES) return null;
    return { data: out.toString("base64"), mediaType: "image/jpeg" };
  } catch {
    return null;
  }
}

async function downloadScreenshot(
  url: string,
): Promise<{ data: string; mediaType: CompetitorScreenshotTile["mediaType"] } | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(25000),
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 800 || bytes.length > MAX_DOWNLOAD_BYTES) return null;
    return prepareVisionImage(bytes);
  } catch {
    return null;
  }
}

/**
 * Capture screenshots via Firecrawl for LLM vision.
 * Recreate should prefer fold-only (faster). Offer analysis can take full page too.
 */
export async function captureCompetitorScreenshotTiles(
  pageUrl: string,
  options?: { foldOnly?: boolean },
): Promise<{ tiles: CompetitorScreenshotTile[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (!hasFirecrawlKey()) {
    return {
      tiles: [],
      warnings: ["FIRECRAWL_API_KEY not set — skipped competitor screenshots"],
    };
  }

  const tiles: CompetitorScreenshotTile[] = [];
  const foldOnly = Boolean(options?.foldOnly);

  // Above-the-fold first — hero, badge, primary CTA, nav rhythm.
  try {
    const fold = await firecrawlScrapeScreenshot(pageUrl, {
      fullPage: false,
      quality: 68,
      viewport: { width: 1440, height: 900 },
    });
    if (fold.screenshotUrl) {
      const embedded = await downloadScreenshot(fold.screenshotUrl);
      if (embedded) {
        tiles.push({
          id: "competitor-fold",
          data: embedded.data,
          mediaType: embedded.mediaType,
          label: "Above-the-fold competitor screenshot (hero, CTA, nav)",
          sourceUrl: fold.finalUrl || pageUrl,
        });
      } else {
        warnings.push("Firecrawl fold screenshot URL could not be prepared for vision");
      }
    } else {
      warnings.push("Firecrawl returned no above-the-fold screenshot");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`Fold screenshot failed: ${message.slice(0, 160)}`);
  }

  if (!foldOnly) {
    // Full page at lower quality for section rhythm (resized under 8000px).
    try {
      const full = await firecrawlScrapeScreenshot(pageUrl, {
        fullPage: true,
        quality: 48,
        viewport: { width: 1200, height: 800 },
      });
      if (full.screenshotUrl) {
        const embedded = await downloadScreenshot(full.screenshotUrl);
        if (embedded) {
          tiles.push({
            id: "competitor-full",
            data: embedded.data,
            mediaType: embedded.mediaType,
            label: "Full-page competitor screenshot (section order and layout rhythm)",
            sourceUrl: full.finalUrl || pageUrl,
          });
        } else {
          warnings.push("Firecrawl full-page screenshot could not be prepared for vision");
        }
      } else {
        warnings.push("Firecrawl returned no full-page screenshot");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Full-page screenshot failed: ${message.slice(0, 160)}`);
    }
  }

  if (!tiles.length) {
    warnings.push("No competitor screenshots available for vision guidance");
  }

  return { tiles, warnings };
}
