import * as cheerio from "cheerio";
import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import { getCompetitor, updateCompetitor } from "../../db";
import type { CompetitorRecord, RecreatedLandingPage } from "../../types";
import { applyDesignFixes } from "../skills/designAudit";
import { beginUnifiedAbort, endUnifiedAbort } from "./abort";
import { repairFromReview } from "./generateBlueprint";
import { repairPageImages, restoreSlotImages } from "./integrity";
import { partHtml, renderForReview, replacePart, withCss } from "./visualReview";

/**
 * Targeted edits to a finished page: the owner describes changes in plain
 * words, and only the parts they mention are rewritten (the hero, the header,
 * one section, or a page-wide style). Everything else stays exactly as built.
 * The whole page is rebuilt only when the owner asks for that.
 *
 * Every edit is checked before it is saved: images, logo, form and sections
 * must all survive, and a part whose layout faults grew is put back as it was.
 */

const MAX_EDITS = 6;
/** Target for page-wide style changes (all buttons, every heading colour…). */
const STYLES = "styles";

const PLAN_SYSTEM = `You plan edits to a finished landing page. The owner describes changes in plain words; you decide which parts of the page each change touches.

Parts: "header", "footer", each section id (sec-1 is the hero, at the top), and "styles" for a page-wide style change (every button, all headings, the page font size).

RULES
- Change only what the owner mentions. Never include a part they did not ask about.
- scope "full" ONLY when the owner explicitly asks to rebuild, regenerate or redesign the whole page or to start again. Otherwise scope is "targeted", even for many small changes.
- The logo is in the header. "Headline", "hero", "top banner" mean the first section. Use the outline's headings to find "the FAQ", "the pricing", "the testimonials" and so on.
- Images that are broken or not showing are repaired automatically before your edits; add an edit only if the owner asks for a different picture treatment (size, position, crop).
- Write each instruction as a precise, self-contained change for a front-end developer (what to change, to what), e.g. "Make the hero headline and intro white on a dark overlay over the hero photo so they are readable".

Return ONLY JSON: { "scope": "targeted" | "full", "edits": [ { "target": "header" | "footer" | "sec-N" | "styles", "instruction": "…" } ], "reply": "one short sentence on what will change" }`;

const CSS_SYSTEM = `You write a few CSS rules for a page-wide style change on a landing page built with the class system below. Use the existing classes and var(--…) tokens; no @import, no fonts, no url(). Keep it minimal: only rules needed for the change.

Return ONLY JSON: { "css": "…" }`;

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function ask(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const response = await getAnthropicClient().messages.create(
    { model: getAnthropicModel(), max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] },
    { timeout: 120_000, ...(signal ? { signal } : {}) },
  );
  return extractJson(response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
}

/** A short outline of the page for the planner: each part, its band and its first words. */
export function pageOutline(html: string): Array<{ id: string; band: string; heading: string; text: string; images: number; form: boolean }> {
  const $ = cheerio.load(html);
  const clip = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n);
  const out: Array<{ id: string; band: string; heading: string; text: string; images: number; form: boolean }> = [];
  const header = $("body > header, header.adr-header").first();
  if (header.length) {
    out.push({
      id: "header",
      band: header.attr("class") || "",
      heading: header.find("img[data-logo-role='company']").length ? "logo, menu and button" : "menu and button",
      text: clip(header.text(), 120),
      images: header.find("img").length,
      form: false,
    });
  }
  $("main [data-section-id]").each((_, el) => {
    const $el = $(el);
    if ($el.parents("[data-section-id]").length) return;
    out.push({
      id: $el.attr("data-section-id") || "",
      band: ($el.attr("class") || "").replace(/\badr-section\b/, "").trim(),
      heading: clip($el.find("h1, h2, h3").first().text(), 120),
      text: clip($el.find("p").first().text(), 160),
      images: $el.find("img").length,
      form: $el.find("form").length > 0,
    });
  });
  const footer = $("body > footer, footer.adr-footer").last();
  if (footer.length) out.push({ id: "footer", band: footer.attr("class") || "", heading: "footer", text: clip(footer.text(), 120), images: footer.find("img").length, form: false });
  return out;
}

/** What must survive an edit: images, logo, form and sections. */
function integrityProblems(before: string, after: string): string[] {
  const problems: string[] = [];
  const slots = (h: string) => new Set([...h.matchAll(/data-adrival-slot="([^"]+)"/gi)].map((m) => m[1]));
  const lost = [...slots(before)].filter((id) => !slots(after).has(id));
  if (lost.length) problems.push(`images lost: ${lost.join(", ")}`);
  const count = (h: string, re: RegExp) => (h.match(re) || []).length;
  if (count(after, /data-logo-role="company"/g) < Math.min(1, count(before, /data-logo-role="company"/g))) problems.push("the logo was lost");
  if (count(after, /<form\b/gi) < count(before, /<form\b/gi)) problems.push("the form was lost");
  if (count(after, /data-section-id="/g) < count(before, /data-section-id="/g)) problems.push("a section was lost");
  return problems;
}

type EditOutcome = { full: false; competitor: CompetitorRecord } | { full: true; feedback: string };

function save(competitorId: string, patch: Partial<RecreatedLandingPage>): CompetitorRecord {
  const latest = getCompetitor(competitorId);
  if (!latest?.recreatedPage) throw new Error("Competitor not found");
  updateCompetitor(competitorId, { recreatedPage: { ...latest.recreatedPage, ...patch, updatedAt: new Date().toISOString() } });
  return getCompetitor(competitorId)!;
}

function progress(page: RecreatedLandingPage, message: string, pct: number): RecreatedLandingPage["progress"] {
  return { phase: "editing", message, pct, stages: page.progress?.stages || [], indeterminate: false, details: page.progress?.details };
}

/**
 * Apply the owner's requested changes to the finished page. Returns
 * { full: true } when the owner asked for the whole page to be rebuilt.
 */
export async function editRecreatedPage(competitorId: string, request: string): Promise<EditOutcome> {
  const competitor = getCompetitor(competitorId);
  const page = competitor?.recreatedPage;
  if (!competitor || !page?.html) throw new Error("There is no finished page to change yet. Create the page first.");
  const original = page.html;
  const signal = beginUnifiedAbort(competitorId);
  const startedPage = save(competitorId, {
    status: "design_pending",
    error: null,
    progress: progress(page, "Reading your changes…", 10),
  }).recreatedPage!;

  try {
    // 1. Integrity first: every image back in its slot.
    const restored = await repairPageImages(original, page.generatedImages, page.brandColors);
    let html = restored.html;
    const repaired = restored.fixed.length ? [`Images put back in ${restored.fixed.length} place${restored.fixed.length === 1 ? "" : "s"}`] : [];

    // 2. Plan: which parts the request touches.
    const outline = pageOutline(html);
    const plan = await ask(PLAN_SYSTEM, JSON.stringify({ request, outline }), 1500, signal);
    if (plan?.scope === "full") {
      endUnifiedAbort(competitorId, signal);
      return { full: true, feedback: request };
    }
    const known = new Set([...outline.map((p) => p.id), STYLES]);
    const edits = (Array.isArray(plan?.edits) ? (plan!.edits as Array<Record<string, unknown>>) : [])
      .map((e) => ({ target: String(e.target || "").trim(), instruction: String(e.instruction || "").trim() }))
      .filter((e) => known.has(e.target) && e.instruction.length > 5)
      .slice(0, MAX_EDITS);
    const reply = typeof plan?.reply === "string" ? plan.reply.slice(0, 300) : "";

    // 3. Change only those parts, in parallel.
    const changed: string[] = [];
    const reverted: string[] = [];
    /** Why a part was left as it was, shown in the summary. */
    const why = new Map<string, string>();
    if (edits.length && !signal.aborted) {
      save(competitorId, { progress: progress(startedPage, `Changing ${edits.map((e) => (e.target === STYLES ? "page styles" : e.target)).join(", ")}…`, 35) });
      const rendered = await renderForReview(html).catch(() => null);
      const vocabulary = (html.match(/\.adr-[a-z0-9-]+/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 120).join(" ");
      const results = await Promise.all(
        edits.map(async (edit) => {
          try {
            if (edit.target === STYLES) {
              const json = await ask(CSS_SYSTEM, JSON.stringify({ change: edit.instruction, classes: vocabulary }), 1500, signal);
              const css = typeof json?.css === "string" ? json.css.replace(/@import[^;]*;|url\([^)]*\)/gi, "").slice(0, 4000) : "";
              return css.includes("{") ? { target: STYLES, html: "", css } : null;
            }
            const current = partHtml(html, edit.target);
            if (!current) return null;
            const next = await repairFromReview({
              target: edit.target,
              html: current,
              competitorCrop: null,
              rebuiltCrop: rendered?.crops.get(edit.target) || null,
              flaws: [],
              fix: edit.instruction,
              classSystem: `Classes used on this page: ${vocabulary}`,
              mode: "edit",
              signal,
            });
            return next ? { target: edit.target, ...next } : null;
          } catch {
            return null;
          }
        }),
      );
      const rows = results.filter((r): r is NonNullable<typeof r> => Boolean(r));

      // 4. Verify: nothing lost, and no part's layout faults grew.
      save(competitorId, { progress: progress(startedPage, "Checking the changed parts…", 75) });
      const place = (base: string, list: typeof rows) => {
        let next = base;
        for (const row of list) if (row.target !== STYLES) next = replacePart(next, row.target, row.html);
        const css = list.filter((r) => r.css.trim()).map((r) => ({ id: r.target === STYLES ? "page styles (edit)" : `${r.target} (edit)`, css: r.css }));
        next = withCss(next, css);
        return restoreSlotImages(applyDesignFixes(next).html, page.generatedImages, page.brandColors).html;
      };
      let kept = rows.filter((row) => {
        const problems = integrityProblems(html, place(html, [row]));
        if (problems.length) why.set(row.target, problems.join(", "));
        return !problems.length;
      });
      for (const row of rows) if (!kept.includes(row)) reverted.push(row.target);
      if (kept.length) {
        const trial = place(html, kept);
        const after = await renderForReview(trial).catch(() => null);
        if (rendered && after) {
          const worse = kept.filter(
            (row) => row.target !== STYLES && (after.lint.get(row.target) || []).length > (rendered.lint.get(row.target) || []).length + 1,
          );
          if (worse.length) {
            for (const row of worse) why.set(row.target, "the change made its layout worse (text squeezed, spilling or hard to read)");
            reverted.push(...worse.map((row) => row.target));
            kept = kept.filter((row) => !worse.includes(row));
          }
          if (after.page.length > rendered.page.length) {
            // A change made the page scroll sideways: keep only section edits that are clean.
            reverted.push(...kept.filter((row) => row.target === STYLES).map((row) => row.target));
            kept = kept.filter((row) => row.target !== STYLES);
          }
        }
        html = kept.length ? place(html, kept) : html;
        changed.push(...kept.map((row) => row.target));
      }
      for (const edit of edits) {
        if (changed.includes(edit.target) || reverted.includes(edit.target)) continue;
        reverted.push(edit.target);
        why.set(edit.target, "no usable rewrite came back");
      }
    }

    const label = (id: string) => (id === STYLES ? "page styles" : id === "header" || id === "footer" ? `the ${id}` : `section ${id.replace("sec-", "")}`);
    const summary = [
      changed.length ? `Changed ${changed.map(label).join(", ")}.` : edits.length ? "No change could be applied safely; the page is as it was." : "Nothing on the page matched the request.",
      reverted.length
        ? `Left as it was: ${[...new Set(reverted)].map((id) => `${label(id)} (${why.get(id) || "the change failed a check"})`).join("; ")}.`
        : "",
      repaired.join(". "),
      reply && changed.length ? `(${reply})` : "",
    ]
      .filter(Boolean)
      .join(" ");

    const note = "Page ready with image placeholders. Generate missing images when credits allow.";
    const placeholdersAdded = restored.fixed.some((id) => id.startsWith("img-fix-")) && !(page.publishBlockers || []).includes(note);
    const saved = save(competitorId, {
      status: "completed",
      html,
      ...(placeholdersAdded ? { publishBlockers: [...(page.publishBlockers || []), note], publishReady: false } : {}),
      previousHtml: html !== original ? original : page.previousHtml || null,
      lastEdit: {
        at: new Date().toISOString(),
        request: request.slice(0, 2000),
        changed,
        reverted: [...new Set(reverted)],
        repaired,
        summary,
      },
      error: null,
      progress: { phase: "ready", message: summary.slice(0, 240), pct: 100, stages: startedPage.progress?.stages || [], indeterminate: false, details: startedPage.progress?.details },
    });
    endUnifiedAbort(competitorId, signal);
    return { full: false, competitor: saved };
  } catch (err) {
    endUnifiedAbort(competitorId, signal);
    const message = signal.aborted ? "Change stopped" : err instanceof Error ? err.message : String(err);
    save(competitorId, {
      status: "completed",
      html: original,
      error: null,
      progress: { phase: "ready", message: `The change could not be applied: ${message.slice(0, 160)}. The page is as it was.`, pct: 100, stages: startedPage.progress?.stages || [], indeterminate: false, details: startedPage.progress?.details },
    });
    throw err;
  }
}

/** Put the page back as it was before the last targeted edit. */
export function undoLastEdit(competitorId: string): CompetitorRecord {
  const page = getCompetitor(competitorId)?.recreatedPage;
  if (!page?.previousHtml) throw new Error("There is no earlier version to go back to.");
  return save(competitorId, {
    html: page.previousHtml,
    previousHtml: page.html || null,
    lastEdit: page.lastEdit ? { ...page.lastEdit, summary: `Undone: ${page.lastEdit.summary}` } : null,
    progress: { phase: "ready", message: "The last change was undone.", pct: 100, stages: page.progress?.stages || [], indeterminate: false, details: page.progress?.details },
  });
}
