import { chromium } from "playwright";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export type ViewportSpec = { name: string; width: number; height: number };

export const DEFAULT_VIEWPORTS: ViewportSpec[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export type VisualGateResult = {
  ok: boolean;
  maxDiffRatio: number;
  results: Array<{
    viewport: string;
    diffRatio: number;
    diffPixels: number;
    totalPixels: number;
  }>;
  notes: string[];
};

function pngFromBuffer(buf: Buffer): PNG {
  return PNG.sync.read(buf);
}

/**
 * Render archived HTML in Playwright at multiple viewports and diff vs original screenshots.
 * originalDesktop is the full-page capture from the live page (desktop).
 * For mobile/tablet we re-render BOTH original HTML snapshot and patched HTML for a fair compare.
 */
export async function runVisualGate(input: {
  originalHtml: string;
  patchedHtml: string;
  threshold?: number;
  viewports?: ViewportSpec[];
}): Promise<VisualGateResult> {
  const threshold = input.threshold ?? 0.12;
  const viewports = input.viewports || DEFAULT_VIEWPORTS;
  const notes: string[] = [];
  const results: VisualGateResult["results"] = [];

  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.setContent(input.originalHtml, { waitUntil: "load", timeout: 30_000 });
      await pageB.setContent(input.patchedHtml, { waitUntil: "load", timeout: 30_000 });
      await pageA.waitForTimeout(300);
      await pageB.waitForTimeout(300);

      const shotA = Buffer.from(
        await pageA.screenshot({ fullPage: false, type: "png" }),
      );
      const shotB = Buffer.from(
        await pageB.screenshot({ fullPage: false, type: "png" }),
      );
      await context.close();

      const imgA = pngFromBuffer(shotA);
      const imgB = pngFromBuffer(shotB);
      const width = Math.min(imgA.width, imgB.width);
      const height = Math.min(imgA.height, imgB.height);

      // Crop to common size if needed
      const a = new PNG({ width, height });
      const b = new PNG({ width, height });
      PNG.bitblt(imgA, a, 0, 0, width, height, 0, 0);
      PNG.bitblt(imgB, b, 0, 0, width, height, 0, 0);

      const diff = new PNG({ width, height });
      const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
        threshold: 0.2,
        includeAA: false,
      });
      const totalPixels = width * height;
      const diffRatio = totalPixels ? diffPixels / totalPixels : 0;
      results.push({
        viewport: vp.name,
        diffRatio,
        diffPixels,
        totalPixels,
      });
      if (diffRatio > threshold) {
        notes.push(
          `${vp.name}: ${(diffRatio * 100).toFixed(1)}% pixels differ (threshold ${(threshold * 100).toFixed(0)}%)`,
        );
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  const maxDiffRatio = results.reduce((m, r) => Math.max(m, r.diffRatio), 0);
  return {
    ok: maxDiffRatio <= threshold,
    maxDiffRatio,
    results,
    notes,
  };
}
