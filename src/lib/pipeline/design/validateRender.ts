import * as cheerio from "cheerio";
import type { LayoutSpec } from "./layoutSpec";

/** Grid rules must sit on the node whose direct children are the columns or items. */
export function layoutStructureErrors(html: string): string[] {
  const $ = cheerio.load(html);
  const errors: string[] = [];
  $("section.adr-section").each((_, el) => {
    if (($(el).attr("style") || "").includes("grid-template-columns") || $(el).attr("data-display") === "grid") {
      errors.push(`Section ${$(el).attr("data-section-id")} has grid rules on the section instead of its column container.`);
    }
    const onlyChild = $(el).children();
    if (onlyChild.length === 1 && /grid-template-columns/.test(onlyChild.attr("style") || "") && onlyChild.children().length < 2) {
      errors.push(`Section ${$(el).attr("data-section-id")} applies a column grid to a wrapper with one child.`);
    }
  });
  $("[data-display='grid']").each((_, el) => {
    const expected = Number($(el).attr("data-expected-children") || 0);
    const count = $(el).children().length;
    const id = $(el).attr("data-layout-node") || "grid";
    if (expected >= 2 && count !== expected) {
      errors.push(`${id} expected ${expected} direct children and has ${count}.`);
    }
    if (!expected && count < 2) errors.push(`${id} is a grid with ${count} direct child. Columns were not created.`);
  });
  if (/overflow\s*:\s*hidden/i.test(html)) errors.push("Global overflow clipping is hiding layout instead of fixing it.");
  if (/opacity\s*:\s*0/.test(html)) errors.push("Content is hidden with opacity 0.");
  if (/data-image-state="placeholder"/.test(html) || />Image placeholder</.test(html)) {
    errors.push("A generation prompt was exported as a visible placeholder.");
  }
  return errors;
}

export function contentPlacementErrors(html: string, spec: LayoutSpec, competitorHost: string): string[] {
  const errors: string[] = [];
  if (/\*\*/.test(html.replace(/<style[\s\S]*?<\/style>/g, ""))) errors.push("Raw Markdown markers are visible.");
  if (competitorHost && html.toLowerCase().includes(competitorHost)) {
    errors.push(`Competitor domain ${competitorHost} is still in the constructed page.`);
  }
  const h1 = html.match(/<h1\b/gi) || [];
  if (spec.sections.some((section) => section.fields.some((field) => field.role === "heading")) && h1.length !== 1) {
    errors.push(`Expected one page heading, found ${h1.length}.`);
  }
  for (const section of spec.sections) {
    if (!html.includes(`data-section-id="${section.id}"`)) errors.push(`Section ${section.id} is missing.`);
    if (html.includes(`data-section-id="${section.id}"`) && !html.includes(`data-composition="${section.composition}"`)) {
      errors.push(`Section ${section.id} does not record its measured composition.`);
    }
    for (const field of section.fields) {
      const marker = `data-field-id="${field.id}"`;
      const at = html.indexOf(marker);
      if (at < 0) {
        errors.push(`Field ${field.id} was not rendered.`);
        continue;
      }
      const before = html.slice(Math.max(0, at - 12), at);
      if (field.role === "heading" && !/<h[1-3]\s[^>]*$/.test(before)) {
        errors.push(`Heading field ${field.id} is not in a heading element.`);
      }
      if (field.role === "paragraph" && !/<p\s[^>]*$/.test(before)) {
        errors.push(`Paragraph field ${field.id} is not in a paragraph element.`);
      }
      if (field.role === "faq") {
        const panelEnd = html.indexOf("</details>", at);
        const panel = panelEnd > at ? html.slice(at, panelEnd) : "";
        if (!/<details\s[^>]*$/.test(before)) errors.push(`FAQ field ${field.id} is not an accordion question.`);
        const summary = panel.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "";
        const answer = panel.match(/data-role="faq-answer">([\s\S]*?)<\/p>/)?.[1] || "";
        const question = (field.question || "").slice(0, 24);
        const reply = (field.answer || "").slice(0, 24);
        if (question && !summary.includes(escapeStart(question))) errors.push(`FAQ ${field.id} question is not the accordion trigger.`);
        if (reply && !answer.includes(escapeStart(reply))) errors.push(`FAQ ${field.id} answer is not in its panel.`);
        if (reply && summary.includes(escapeStart(reply))) errors.push(`FAQ ${field.id} answer was placed as the question.`);
      }
    }
    const slot = findSlot(section.nodes);
    if (slot && !html.includes(`data-adrival-gen-id="${slot}"`)) {
      errors.push(`Required image ${slot} was not placed.`);
    }
  }
  return errors;
}

function escapeStart(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findSlot(node: { assetSlotId: string | null; children: Array<{ assetSlotId: string | null; children: unknown[] }> }): string | null {
  if (node.assetSlotId) return node.assetSlotId;
  for (const child of node.children) {
    const found = findSlot(child as { assetSlotId: string | null; children: Array<{ assetSlotId: string | null; children: unknown[] }> });
    if (found) return found;
  }
  return null;
}

/** Measure the finished document. Defects are reported; they are not hidden. */
export async function measureConstructedPage(html: string): Promise<string[]> {
  const { launchChromium } = await import("../content/playwrightRuntime");
  const browser = await launchChromium();
  const errors: string[] = [];
  try {
    for (const width of [1440, 768, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
      const found = await page.evaluate(() => {
        const issues: string[] = [];
        document.querySelectorAll("[data-display='grid']").forEach((el) => {
          const expected = Number(el.getAttribute("data-expected-children") || 0);
          if (expected && el.children.length !== expected) {
            issues.push(`${el.getAttribute("data-layout-node")} has ${el.children.length} children at this width, expected ${expected}.`);
          }
        });
        if (document.documentElement.scrollWidth > window.innerWidth + 8) {
          issues.push(`Horizontal overflow (${document.documentElement.scrollWidth}px content in ${window.innerWidth}px).`);
        }
        return issues;
      });
      errors.push(...found.map((item) => `${width}px: ${item}`));
      await page.close();
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
  return errors;
}
