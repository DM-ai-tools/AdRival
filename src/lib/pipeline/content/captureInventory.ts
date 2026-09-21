import { mkdir } from "node:fs/promises";
import path from "node:path";
import { assertPublicHttpUrl } from "./safeUrl";
import { applyVisionGroups, inventoryFromBlocks, type PageInventory, type RenderedBlock } from "./inventory";
import { architectureFromProbe, alignLayoutEvidence } from "../design/layoutEvidence";
import { probePage } from "../design/captureLayout";
import type { LayoutProbe } from "../design/layoutEvidence";
import { analyzeScreenshotTiles } from "./vision";

export interface CaptureFrame {
  finalUrl: string;
  blocks: RenderedBlock[];
  gaps: string[];
  overlays?: string[];
  tiles?: Array<{ id: string; viewport: string; path: string; y: number }>;
  layout?: LayoutProbe;
}

export interface CaptureDeps {
  open?: (url: string, viewport: { width: number; height: number }) => Promise<CaptureFrame>;
  vision?: typeof analyzeScreenshotTiles;
}

const DESKTOP = { name: "desktop", width: 1440, height: 900 };
const MOBILE = { name: "mobile", width: 390, height: 844 };

async function openWithPlaywright(url: string, viewport: { width: number; height: number }): Promise<CaptureFrame> {
  const { launchChromium } = await import("./playwrightRuntime");
  const browser = await launchChromium();
  const captureId = `cap-${Date.now()}`;
  const dir = path.join(process.cwd(), "data", "captures", captureId);
  try {
    await mkdir(dir, { recursive: true });
    const page = await browser.newPage({ viewport });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    const finalUrl = page.url();
    if (finalUrl && finalUrl !== url) await assertPublicHttpUrl(finalUrl);
    if (!response || response.status() >= 400) {
      return { finalUrl, blocks: [], gaps: [`Page responded ${response?.status() || "without a document"}.`] };
    }
    const overlays: string[] = [];
    const closed = await page.evaluate(() => {
      const notes: string[] = [];
      const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
      for (const button of buttons.slice(0, 20)) {
        if (button.getAttribute("type") === "submit") continue;
        const label = (button.textContent || "").replace(/\s+/g, " ").trim();
        if (/^(accept|agree|got it|close|dismiss)$/i.test(label) || /cookie/i.test(label)) {
          (button as HTMLElement).click();
          notes.push(`Closed overlay control “${label.slice(0, 40)}”.`);
          break;
        }
      }
      return notes;
    });
    overlays.push(...closed);
    await page.evaluate(async () => {
      const step = 700;
      let y = 0;
      const max = Math.min(document.documentElement.scrollHeight, 12000);
      const started = Date.now();
      while (y < max && Date.now() - started < 8000) {
        y += step;
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    });
    const readBlocks = () => page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll("h1,h2,h3,p,li,button,a,img"));
      return nodes.slice(0, 400).map((node, index) => {
        const box = node.getBoundingClientRect();
        return {
          tag: node.tagName.toLowerCase(),
          text: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500),
          alt: node.getAttribute("alt"),
          href: node.getAttribute("href"),
          nodeId: node.id || `n-${index}`,
          box: { x: box.x, y: box.y + window.scrollY, width: box.width, height: box.height },
        };
      }).filter((block) => block.text || block.alt);
    });
    const blocks = await readBlocks();
    const seen = new Set(blocks.map((block) => block.text));
    const interactionNotes: string[] = [];
    const controls = page.locator("details summary, [role='tab'], button");
    const count = Math.min(await controls.count(), 6);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const label = ((await control.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!/faq|read more|tab|next/i.test(label) && (await control.evaluate((node) => node.tagName).catch(() => "")) !== "SUMMARY") continue;
      await control.click({ timeout: 1500 }).catch(() => undefined);
      interactionNotes.push(`Opened “${label.slice(0, 40) || "content control"}”.`);
      const extra = await readBlocks();
      for (const block of extra) {
        if (block.text && !seen.has(block.text)) {
          seen.add(block.text);
          blocks.push(block);
        }
      }
    }
    const tiles: CaptureFrame["tiles"] = [];
    const height = await page.evaluate(() => Math.min(document.documentElement.scrollHeight, 8000));
    const tileHeight = viewport.height;
    let y = 0;
    let tileIndex = 0;
    while (y < height && tileIndex < 8) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      const file = path.join(dir, `${viewport.width < 500 ? "mobile" : "desktop"}-tile-${tileIndex}.jpg`);
      await page.screenshot({
        path: file,
        type: "jpeg",
        quality: 60,
        clip: { x: 0, y: 0, width: viewport.width, height: Math.min(tileHeight, Math.max(1, height - y)) },
      });
      tiles.push({ id: `tile-${viewport.width}-${tileIndex}`, viewport: viewport.width < 500 ? "mobile" : "desktop", path: file, y });
      y += Math.max(200, tileHeight - 160);
      tileIndex += 1;
    }
    await page.screenshot({ path: path.join(dir, `${viewport.width < 500 ? "mobile" : "desktop"}-full.jpg`), type: "jpeg", quality: 40, fullPage: true }).catch(() => undefined);
    const gaps = [...interactionNotes];
    if (blocks.length === 0) gaps.push("Rendered DOM returned no text.");
    const layout = await page.evaluate(probePage).catch(() => undefined);
    return { finalUrl, blocks, gaps, overlays, tiles, layout };
  } finally {
    await browser.close();
  }
}

/** Capture desktop and mobile rendered text from the same URL. Vision is not assumed. */
export async function captureRenderedInventory(sourceUrl: string, deps: CaptureDeps = {}): Promise<PageInventory> {
  const url = await assertPublicHttpUrl(sourceUrl);
  const open = deps.open || openWithPlaywright;
  const gaps: string[] = [];
  let desktop;
  try {
    desktop = await open(url.toString(), DESKTOP);
  } catch (err) {
    gaps.push(`Desktop capture failed: ${(err as Error).message}`);
    desktop = { finalUrl: url.toString(), blocks: [], gaps };
  }
  try {
    const mobile = await open(desktop.finalUrl || url.toString(), MOBILE);
    const mobileText = new Set(mobile.blocks.map((block) => block.text));
    const extra = mobile.blocks.filter((block) => block.text && !desktop.blocks.some((item) => item.text === block.text));
    desktop.blocks.push(...extra);
    if (mobile.gaps.length) gaps.push(...mobile.gaps);
    if (mobileText.size === 0) gaps.push("Mobile viewport returned no rendered text.");
  } catch (err) {
    gaps.push(`Mobile capture failed: ${(err as Error).message}`);
  }
  const inventory = inventoryFromBlocks({
    sourceUrl,
    finalUrl: desktop.finalUrl || url.toString(),
    blocks: desktop.blocks,
    gaps: [...gaps, ...desktop.gaps, ...(desktop.overlays || []).map((note) => `Overlay: ${note}`)],
  });
  inventory.tiles = desktop.tiles || [];
  inventory.overlays = desktop.overlays || [];
  if (desktop.layout) {
    inventory.layout = alignLayoutEvidence(
      architectureFromProbe(desktop.layout, inventory.finalUrl),
      inventory.sections.map((section) => section.id),
    );
    if (inventory.layout.incomplete) {
      inventory.gaps.push("Layout measurements did not cover every captured section. Design must repair capture before building.");
    }
  } else {
    inventory.gaps.push("Layout measurements were not returned. Section-purpose summaries are not design evidence.");
  }
  if (!inventory.sections.some((section) => section.components.some((item) => item.kind === "paragraph"))) {
    inventory.gaps.push("Rendered capture did not include body paragraphs. Drafting must not treat an analysis summary as source text.");
  }
  const vision = deps.vision || analyzeScreenshotTiles;
  if (inventory.tiles.length) {
    try {
      const visual = await vision(inventory.tiles);
      if (!visual.used) {
        inventory.visionUsed = false;
        if (visual.gap) inventory.gaps.push(visual.gap);
      } else {
        const reconciled = applyVisionGroups(inventory, visual.groups);
        inventory.sections = reconciled.sections;
        inventory.gaps = reconciled.gaps;
        inventory.coverage = reconciled.coverage;
        inventory.visionUsed = true;
        if (visual.gap) inventory.gaps.push(visual.gap);
      }
    } catch (err) {
      inventory.visionUsed = false;
      inventory.gaps.push(`Visual analysis failed: ${(err as Error).message}. DOM text was kept and was not treated as a completed visual pass.`);
    }
  } else {
    inventory.visionUsed = false;
    inventory.gaps.push("No screenshot tiles were captured, so visual analysis was not run. A model section list is not capture evidence.");
  }
  if (inventory.coverage.unresolved > 0) {
    inventory.gaps.push(`${inventory.coverage.unresolved} region(s) are unresolved. Capture is not complete.`);
  }
  return inventory;
}
