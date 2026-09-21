import { assertPublicHttpUrl } from "../content/safeUrl";
import { architectureFromProbe, type LayoutProbe, type PageLayoutEvidence } from "./layoutEvidence";

/**
 * Measure the live competitor page. This is capture repair, not a design template.
 * Animation is recorded as unknown unless a control is present in the DOM.
 */
export async function captureLayoutEvidence(sourceUrl: string): Promise<PageLayoutEvidence> {
  const url = await assertPublicHttpUrl(sourceUrl);
  const { launchChromium } = await import("../content/playwrightRuntime");
  const browser = await launchChromium();
  try {
    const desktop = await readProbe(browser, url.toString(), 1440, 900);
    const mobile = await readProbe(browser, url.toString(), 390, 844).catch(() => null);
    const stacks = mobile
      ? desktop.bands.some((band, index) => band.columnWidths.length >= 2 && (mobile.bands[index]?.columnWidths.length || 0) < 2)
      : null;
    return architectureFromProbe({ ...desktop, mobileStacks: stacks }, url.toString());
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function readProbe(browser: import("playwright").Browser, url: string, width: number, height: number): Promise<LayoutProbe> {
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
    if (!response || response.status() >= 400) {
      return emptyProbe(width, height, [`Page responded ${response?.status() || "without a document"}.`]);
    }
    await page.evaluate(async () => {
      const max = Math.min(document.documentElement.scrollHeight, 8000);
      for (let y = 0; y < max; y += 700) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      window.scrollTo(0, 0);
    });
    const probe = await page.evaluate(probePage);
    return probe;
  } finally {
    await page.close().catch(() => undefined);
  }
}

function emptyProbe(width: number, height: number, gaps: string[]): LayoutProbe {
  return {
    viewport: { width, height },
    pageBackground: "",
    headerArrangement: "unknown",
    footerArrangement: "unknown",
    footerGroups: null,
    bands: [],
    mobileStacks: null,
    gaps,
  };
}

export function probePage(): LayoutProbe {
  const style = (el: Element) => getComputedStyle(el);
  const boxOf = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  };
  const pageBackground = style(document.body).backgroundColor;
  const root = document.querySelector("main") || document.body;
  const tall = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return rect.height > 80 && rect.width > 200;
  };
  const candidates = Array.from(document.querySelectorAll("section, .brxe-section, .elementor-section, .elementor-top-section, [data-element_type='section'], [class*='wp-block-cover']")).filter(tall);
  const marked = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
  const sectionBands = marked.length ? marked : Array.from(root.querySelectorAll("section")).filter((el) => {
    if (!tall(el)) return false;
    const nested = Array.from(el.querySelectorAll("section")).filter(tall);
    return nested.length < 2;
  });
  let bands = sectionBands.length >= 3 ? sectionBands : Array.from(root.children).filter((el) => {
    if (/^(SCRIPT|STYLE|HEADER|FOOTER|NAV)$/.test(el.tagName)) return false;
    return tall(el);
  });
  if (bands.length < 3) {
    let current: Element = root;
    for (let depth = 0; depth < 6 && bands.length < 3; depth += 1) {
      const kids = Array.from(current.children).filter((el) => !/^(SCRIPT|STYLE|HEADER|FOOTER|NAV)$/.test(el.tagName) && tall(el));
      if (kids.length === 1) {
        current = kids[0];
        bands = Array.from(current.children).filter((el) => !/^(SCRIPT|STYLE|HEADER|FOOTER|NAV)$/.test(el.tagName) && tall(el));
      } else {
        bands = kids;
        break;
      }
    }
  }
  bands = bands.slice(0, 24);
  const arrangement = (el: Element | null): "split" | "centered" | "stacked" | "unknown" => {
    if (!el) return "unknown";
    const computed = style(el);
    if (computed.flexDirection === "column") return "stacked";
    if (computed.justifyContent === "center") return "centered";
    if (computed.display.includes("flex") || computed.display.includes("grid")) return "split";
    return "unknown";
  };
  const measured = bands.map((el) => {
    const visible = Array.from(el.children).filter((child) => boxOf(child).height > 24 && boxOf(child).width > 40);
    const gridRoot = visible.length === 1 && /grid|flex/.test(style(visible[0]).display) ? visible[0] : el;
    const cells = Array.from(gridRoot.children).filter((child) => boxOf(child).width > 80 && boxOf(child).height > 40);
    const widths = cells.map((child) => boxOf(child).width);
    const similar = widths.length >= 3 && Math.max(...widths) - Math.min(...widths) < 80;
    const roles = cells.map((child) => {
      const img = child.querySelector("img, picture, video");
      const text = (child.textContent || "").trim().length;
      if (img && text < 40) return "media" as const;
      if (img && text >= 40) return "mixed" as const;
      if (text > 0) return "content" as const;
      return "unknown" as const;
    });
    const img = el.querySelector("img, picture, video");
    const imgBox = img ? boxOf(img) : null;
    const self = boxOf(el);
    let mediaPosition: "left" | "right" | "above" | "below" | "background" | "none" = "none";
    if (imgBox && imgBox.width > 140 && imgBox.height > 80) {
      if (imgBox.width > self.width * 0.8 && imgBox.y <= self.y + 24) mediaPosition = "background";
      else if (imgBox.x > self.x + self.width * 0.45) mediaPosition = "right";
      else if (imgBox.x + imgBox.width < self.x + self.width * 0.55) mediaPosition = "left";
      else if (imgBox.y > self.y + self.height * 0.45) mediaPosition = "below";
      else mediaPosition = "above";
    }
    const computed = style(el);
    const fills = [el, ...Array.from(el.querySelectorAll("div, section")).slice(0, 16)]
      .map((node) => style(node).backgroundColor)
      .filter((color) => color && color !== "transparent" && !/^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/.test(color));
    const painted = fills.find((color) => color !== pageBackground) || fills[0] || computed.backgroundColor;
    const separator: "whitespace" | "background" | "border" | "divider" = painted && painted !== pageBackground && painted !== "rgba(0, 0, 0, 0)" && painted !== "transparent"
      ? "background"
      : parseFloat(computed.borderTopWidth || "0") > 0
        ? "border"
        : el.querySelector("hr")
          ? "divider"
          : "whitespace";
    const heading = el.querySelector("h1, h2, h3");
    const headingText = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180) : null;
    const paragraph = el.querySelector("p");
    return {
      box: self,
      background: painted,
      pageBackground,
      textAlign: heading ? style(heading).textAlign : computed.textAlign,
      paddingY: parseFloat(computed.paddingTop || "0") || null,
      gap: parseFloat(style(gridRoot).columnGap || style(gridRoot).gap || "0") || null,
      containerWidth: Math.round(Math.min(self.width, boxOf(gridRoot).width)),
      fullWidth: self.width > window.innerWidth * 0.92,
      columnWidths: similar ? [] : widths,
      columnRoles: similar ? [] : roles,
      repeatedCount: similar ? cells.length : 0,
      repeatedColumns: similar ? Math.min(cells.length, Math.max(1, Math.round(self.width / (widths[0] || self.width)))) : 0,
      repeatedGap: similar ? parseFloat(style(gridRoot).gap || "0") || null : null,
      repeatedBordered: similar ? parseFloat(style(cells[0]).borderTopWidth || "0") > 0 : false,
      repeatedRadius: similar ? parseFloat(style(cells[0]).borderRadius || "0") || null : null,
      mediaPosition: similar ? "none" as const : mediaPosition,
      mediaAspect: imgBox && imgBox.height ? Math.round((imgBox.width / imgBox.height) * 100) / 100 : null,
      heading: headingText,
      headingAlign: heading ? (/center/.test(style(heading).textAlign) ? "center" as const : "start" as const) : "unknown" as const,
      textMeasure: paragraph ? Math.round(boxOf(paragraph).width) : null,
      separator,
      interactions: Array.from(el.querySelectorAll("details, [role='tab'], video")).slice(0, 4).map((node) => ({
        kind: node.tagName === "DETAILS" ? "accordion" : node.tagName === "VIDEO" ? "video" : "tabs",
        evidence: `DOM control ${node.tagName.toLowerCase()} was present. Motion was not inferred.`,
      })),
    };
  });
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pageBackground,
    headerArrangement: arrangement(document.querySelector("header")),
    footerArrangement: arrangement(document.querySelector("footer")),
    footerGroups: document.querySelector("footer") ? document.querySelectorAll("footer nav, footer ul").length || null : null,
    mobileStacks: null,
    gaps: bands.length ? [] : ["No measured content bands."],
    bands: measured,
  };
}
