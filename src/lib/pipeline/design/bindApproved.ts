import * as cheerio from "cheerio";
import type { CanonicalContent, CompetitorReference, DraftField } from "../content/model";
import { sanitizeLayoutShell } from "./sanitize";

export type DesignBinding = {
  html: string;
  bound: number;
  removed: number;
  blockers: string[];
};

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function includedFields(snapshot: CanonicalContent): Array<{ sectionId: string; field: DraftField }> {
  return snapshot.sections
    .filter((section) => section.decision !== "omit" && section.decision !== "needs_input")
    .flatMap((section) => (section.fields || []).map((field) => ({ sectionId: section.id, field })));
}

/**
 * Bind exact approved fields onto captured nodes.
 * Unmatched competitor sentences are removed. Copy is not shortened to fit the original box.
 */
export function bindApprovedSnapshot(
  html: string,
  snapshot: CanonicalContent,
  competitor: CompetitorReference,
): DesignBinding {
  const blockers: string[] = [];
  const $ = cheerio.load(sanitizeLayoutShell(html, competitor.host));
  const components = competitor.sections.flatMap((section) => section.components || []);
  const approvedText = new Set(
    snapshot.sections
      .flatMap((section) => [
        section.heading,
        ...section.paragraphs,
        ...(section.fields || []).map((field) => field.text),
        ...section.items.map((item) => item.label),
      ])
      .map(norm)
      .filter(Boolean),
  );
  let bound = 0;
  const used = new Set<string>();

  const fields = includedFields(snapshot);
  for (const { field } of fields) {
    if (field.disposition === "omit" || !field.text.trim()) continue;
    const source = components.find((component) => component.id === field.sourceComponentId);
    const sourceText = norm(source?.text || "");
    const node = $("[data-cid]").toArray().find((el) => {
      const id = $(el).attr("data-cid") || "";
      if (used.has(id)) return false;
      if (id === field.sourceComponentId || id === field.id) return true;
      const text = norm($(el).text());
      return sourceText.length >= 12 && text === sourceText;
    });
    if (!node) {
      blockers.push(`Approved field “${field.text.slice(0, 80)}” has no captured layout node.`);
      continue;
    }
    const id = $(node).attr("data-cid") || field.id;
    used.add(id);
    $(node).text(field.text);
    bound += 1;
  }

  for (const section of snapshot.sections) {
    if (section.decision === "omit" || !section.heading.trim()) continue;
    if ([...approvedText].some((text) => text === norm(section.heading))) continue;
    approvedText.add(norm(section.heading));
  }

  let removed = 0;
  $("[data-cid]").each((_, el) => {
    const id = $(el).attr("data-cid") || "";
    if (used.has(id)) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 40) return;
    if (approvedText.has(norm(text))) return;
    const fromCompetitor = competitor.sections.some((section) => {
      const source = `${section.sourceText} ${(section.components || []).map((component) => component.text).join(" ")}`;
      return norm(source).includes(norm(text).slice(0, 40));
    });
    if (!fromCompetitor) return;
    $(el).text("");
    removed += 1;
  });

  const host = competitor.host.replace(/^www\./, "").toLowerCase();
  $("img[src], source[srcset]").each((_, el) => {
    const src = `${$(el).attr("src") || ""} ${$(el).attr("srcset") || ""}`.toLowerCase();
    if (host && src.includes(host)) {
      $(el).removeAttr("src");
      $(el).removeAttr("srcset");
      $(el).attr("data-adrival-image", "unresolved");
      removed += 1;
    }
  });
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (host && href.toLowerCase().includes(host)) {
      $(el).removeAttr("href");
      $(el).attr("data-adrival-link", "unresolved");
      if (competitor.name.length > 2 && $(el).text().toLowerCase().includes(competitor.name.toLowerCase())) {
        $(el).text("");
      }
    }
  });
  const cleaned = stripCompetitorResidue($.html(), snapshot, competitor);
  return { html: cleaned, bound, removed, blockers };
}

/** Remove leftover competitor URLs and source sentences after approved text is placed. */
export function stripCompetitorResidue(
  html: string,
  snapshot: CanonicalContent,
  competitor: CompetitorReference,
): string {
  const host = competitor.host.replace(/^www\./, "").toLowerCase();
  const approved = snapshot.sections
    .flatMap((section) => [section.heading, ...section.paragraphs, ...(section.fields || []).map((field) => field.text)])
    .join(" ")
    .toLowerCase();
  const snippets = competitor.sections
    .map((section) => section.sourceText.replace(/\s+/g, " ").trim())
    .filter((text) => text.length >= 40)
    .map((text) => text.slice(0, 48).toLowerCase());
  const $ = cheerio.load(html);
  if (host) {
    $("*").each((_, el) => {
      const attribs = (el as { attribs?: Record<string, string> }).attribs || {};
      for (const [name, value] of Object.entries(attribs)) {
        if (value.toLowerCase().includes(host)) $(el).attr(name, "");
      }
    });
    $("style").each((_, el) => {
      const css = $(el).text();
      if (css.toLowerCase().includes(host)) {
        $(el).text(css.replace(new RegExp(`https?:\\/\\/[^)"']*${host.replace(/\./g, "\\.")}[^)"']*`, "gi"), ""));
      }
    });
  }
  const title = snapshot.meta.title.trim() || snapshot.clientName;
  if (title) $("title").text(title);
  $("meta[name='description']").attr("content", snapshot.meta.description || "");
  $("link[rel='canonical'], meta[property='og:url']").remove();
  $("meta[property='og:title']").attr("content", title);
  $("meta[property='og:site_name']").attr("content", snapshot.clientName);
  $("meta[property='og:description'], meta[name='twitter:description']").attr("content", snapshot.meta.description || "");
  $("meta[name='twitter:title']").attr("content", title);
  $("[data-cid]").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 400) return;
    const lower = text.toLowerCase();
    if (approved.includes(lower)) return;
    const inSource = competitor.sections.some((section) => {
      const source = `${section.heading} ${section.sourceText}`.toLowerCase();
      return source.includes(lower);
    });
    if (inSource) $(el).text("");
  });
  const competitorHeadings = new Set(
    competitor.sections.map((section) => section.heading.replace(/\s+/g, " ").trim().toLowerCase()).filter((heading) => heading.length > 8),
  );
  $("h1,h2,h3,h4,div,span,a,button").each((_, el) => {
    if ($(el).find("h1,h2,h3,p").length) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    if (!competitorHeadings.has(lower) || approved.includes(lower)) return;
    $(el).text("");
  });
  $("h1,h2,h3,h4,p,li,a,button,span,div").each((_, el) => {
    if ($(el).find("[data-cid]").length) return;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length < 8) return;
    const lower = text.toLowerCase();
    if (approved.includes(lower.slice(0, Math.min(40, lower.length)))) return;
    const rival = competitor.name.trim().toLowerCase();
    const fromSource = snippets.some((snippet) =>
      lower.includes(snippet.slice(0, 32)) || snippet.startsWith(lower) || lower.startsWith(snippet.slice(0, 18)),
    );
    const isRival = rival.length > 2 && lower.includes(rival) && !approved.includes(rival);
    if (!fromSource && !isRival) return;
    $(el).text("");
  });
  let next = $.html();
  if (host) {
    const hostRe = host.replace(/\./g, "\\.");
    next = next.replace(new RegExp(`https?:\\/\\/[^\\s"'<>]*${hostRe}[^\\s"'<>]*`, "gi"), "");
    next = next.replace(new RegExp(`[\\w.+-]+@${hostRe}`, "gi"), "");
    next = next.replace(new RegExp(hostRe, "gi"), "");
  }
  return next;
}
