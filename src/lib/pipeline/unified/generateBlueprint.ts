import { getAnthropicModel } from "../../anthropic/client";
import type { BlueprintForm, BlueprintSection, CompetitorBlueprint } from "./blueprint";
import type { DesignSystem } from "./designSystem";
import type { UnifiedGenerationResponse, UnifiedImageSlot } from "./contract";
import { clampTokens, streamUnifiedMessage, textFromMessage, type ContentPart, type UnifiedProgressInfo } from "./generatePage";
import { FORM_SLOT_ATTR, LEAD_FORM_SCRIPT, buildLeadFormHtml, type LeadFormCopy } from "./leadForm";
import type { CompetitorFormField } from "./recreateChrome";
import { mergeSectionStyles, sanitizeFragment } from "./fragmentCss";
import { repairGuide } from "../skills/playbook";

/**
 * Blueprint generation: the page is written section by section from the
 * competitor's own section crops and text, on one shared stylesheet.
 * Sections run in parallel because consistency comes from the stylesheet,
 * not from each call seeing the previous one.
 */

const SYSTEM = `You are a senior front-end developer and conversion copywriter. You rebuild a competitor's landing page, section by section, for a different business (the CLIENT).

KEEP from the competitor (the attached screenshots are crops of the exact sections you are rebuilding):
- each section's layout: columns, number of cards/items, media side, alignment, band type (light/tinted/dark/brand/gradient), order of elements, visual weight
- the amount of content: similar word count and the same number of cards, steps, questions or list items
- the campaign's offer type and call-to-action concept

REPLACE everything that identifies the competitor:
- every word — write original, specific copy for the client (their name, services, audience, location from the brief)
- colours and fonts — the page stylesheet already carries the client's brand; use its classes
- imagery — use image slots; logos — only the client's logo and authorised proof logos

HARD RULES
- Never name the competitor or reuse their brand, product or people names.
- Never copy their sentences or distinctive phrases (no 4+ consecutive words from their copy, except the campaign keyword and generic service names).
- Headings, eyebrows and button labels must be your own words. Do not reuse the competitor's wording OR its sentence pattern (turning "The most expensive person in your team shouldn't be you" into "The most expensive click in your account shouldn't be a guess" is still copying). Start from the client's angle instead.
- competitorContentReferenceOnly shows what each section covers and how much it says. Use it for structure, topic and length only; doNotReuse lists lines you must not reuse even partly.
- Never invent statistics, percentages, client names, awards, reviews, testimonials, certifications or people. If a competitor section shows proof the client facts cannot back, keep the same layout and fill it with truthful content (how the work is done, what the client includes, guarantees or facts that ARE in clientFacts). Put what is missing in unresolvedRequirements.
- Finish every sentence. No placeholder brackets, no lorem ipsum, no "[Client Name]".
- Write in a concrete, confident, professional voice. No emoji, no exclamation spam, no filler like "in today's fast-paced world".
- Use the CLASS SYSTEM provided. Do not restyle colours, fonts, buttons or cards.
- Return ONE JSON object exactly matching the requested output contract. HTML goes in JSON strings.`;

const TRANSPARENT_GIF = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

export type BlueprintGenerationInput = {
  blueprint: CompetitorBlueprint;
  design: DesignSystem;
  client: {
    name: string;
    url: string;
    whatTheyDo: string;
    offerings: string[];
    audience: string | null;
    location: string | null;
  };
  keyword: string;
  campaignOffer: Record<string, unknown> | null;
  clientFacts: Array<{ id: string; category: string; value: string; status: string }>;
  destinations: {
    nav: Array<{ label: string; href: string }>;
    footer: Array<{ label: string; href: string }>;
    footerColumns: Array<{ heading: string; links: Array<{ label: string; href: string }> }>;
    cta: Array<{ label: string; href: string }>;
    social: Array<{ label: string; href: string }>;
    phones: string[];
    emails: string[];
  };
  proofLogos: Array<{ src: string; alt: string }>;
  form: BlueprintForm | null;
  imageBudget: number;
  userFeedback?: string | null;
  /**
   * Per-run design context from the skills: the chosen style direction's
   * rules and the client's industry guide (UI UX Pro Max). The fixed rules
   * are in the cached system prompt.
   */
  designDirection?: {
    style: string;
    styleRules: string | null;
    industry: Record<string, string> | null;
  } | null;
  signal?: AbortSignal;
  onProgress?: (info: UnifiedProgressInfo) => void;
};

type PlannedSlot = { id: string; sectionId: string; aspectRatio: string };

function ratioFor(size: { width: number; height: number } | null): string {
  if (!size || !size.width || !size.height) return "1920:1280";
  const r = size.width / size.height;
  if (r > 2) return "2048:880";
  if (r > 1.6) return "1920:1088";
  if (r > 1.25) return "1920:1280";
  if (r > 1.1) return "1920:1536";
  if (r > 0.9) return "1920:1920";
  if (r > 0.75) return "1536:1920";
  return "1280:1920";
}

/** Where the competitor shows photography, the rebuild gets an image slot (hero first, then biggest). */
export function planImageSlots(sections: BlueprintSection[], budget: number): PlannedSlot[] {
  const candidates = sections
    .filter((s) => s.media.position !== "none" && s.media.images - s.media.logos > 0 && s.kind !== "logos")
    .map((s) => ({
      s,
      score: (s.kind === "hero" ? 1e9 : 0) + (s.media.largest ? s.media.largest.width * s.media.largest.height : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, budget));
  return candidates
    .map(({ s }) => ({ id: `img-${s.id}`, sectionId: s.id, aspectRatio: ratioFor(s.media.largest) }))
    .sort((a, b) => a.sectionId.localeCompare(b.sectionId, undefined, { numeric: true }));
}

function bandFor(section: BlueprintSection): string {
  switch (section.background.kind) {
    case "dark":
      return "adr-section--dark";
    case "gradient":
      return "adr-section--gradient";
    case "wash":
      return "adr-section--wash (light page with a soft colour glow — not a solid band)";
    case "image":
      return "adr-section--dark (the competitor uses a photo background; use an image slot as the backdrop or the dark band)";
    case "color":
      return "adr-section--alt or adr-section--brand (tinted band — pick by how strong the colour is in the screenshot)";
    default:
      return "none (plain page background)";
  }
}

function sectionSpec(section: BlueprintSection, slots: PlannedSlot[], form: BlueprintForm | null) {
  const slot = slots.find((s) => s.sectionId === section.id) || null;
  return {
    id: section.id,
    kind: section.kind,
    band: bandFor(section),
    align: /center/.test(section.align) ? "centered" : "left-aligned",
    layout: {
      columns: section.layout.columns,
      cards: section.layout.cards,
      mediaPosition: section.media.position,
      video: section.media.video,
      logoCount: section.media.logos,
    },
    targetWords: section.wordCount,
    competitorContentReferenceOnly: section.blocks.map((b) => `${b.role}: ${b.text}`).slice(0, 70),
    doNotReuse: section.blocks
      .filter((b) => /^h[1-6]$|button|link/.test(b.role) && b.text.length <= 90)
      .map((b) => b.text)
      .slice(0, 16),
    imageSlot: slot
      ? { id: slot.id, aspectRatio: slot.aspectRatio, markup: `<img data-adrival-slot="${slot.id}" src="${TRANSPARENT_GIF}" alt="…">` }
      : null,
    formSlot: form && form.sectionId === section.id
      ? `Place <div ${FORM_SLOT_ATTR}></div> where the competitor's form sits (it is replaced by the real form: ${form.fields.length} fields${form.mode !== "single" ? `, ${form.mode}` : ""}). Rebuild the text around it (heading, intro, reassurance) in the same arrangement.`
      : null,
  };
}

function clientBrief(input: BlueprintGenerationInput) {
  return {
    name: input.client.name,
    url: input.client.url,
    whatTheyDo: input.client.whatTheyDo,
    offerings: input.client.offerings.slice(0, 12),
    audience: input.client.audience,
    location: input.client.location,
    campaignKeyword: input.keyword,
  };
}

function imagePart(data: string): ContentPart {
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
}

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

function slotsFrom(value: unknown, planned: PlannedSlot[], sectionId: string): UnifiedImageSlot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row, index) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const id = String(r.id || "");
    const plan = planned.find((p) => p.id === id && (p.sectionId === sectionId || sectionId === "*"));
    const prompt = String(r.prompt || "").trim();
    if (!plan || prompt.length < 20) return [];
    return [{
      id,
      sectionId: plan.sectionId,
      purpose: String(r.purpose || `${plan.sectionId} image`),
      prompt,
      aspectRatio: plan.aspectRatio,
      alt: String(r.alt || r.purpose || "Illustration"),
      kind: "illustrative" as const,
      priority: index + 1,
    }];
  });
}

function formCopyFrom(value: unknown): LeadFormCopy | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const stepFields: Record<string, CompetitorFormField[]> = {};
  if (r.stepFields && typeof r.stepFields === "object") {
    for (const [title, list] of Object.entries(r.stepFields as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      stepFields[title] = list.flatMap((f, i) => {
        if (!f || typeof f !== "object") return [];
        const x = f as Record<string, unknown>;
        const type = String(x.type || "text");
        return [{
          label: String(x.label || `Question ${i + 1}`).slice(0, 80),
          name: String(x.name || x.label || `q${i + 1}`).slice(0, 40),
          type: (["text", "email", "tel", "url", "number", "textarea", "select", "checkbox", "radio"].includes(type) ? type : "text") as CompetitorFormField["type"],
          required: Boolean(x.required),
          options: Array.isArray(x.options) ? x.options.map(String).slice(0, 12) : undefined,
        }];
      }).slice(0, 6);
    }
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  return {
    submitLabel: str(r.submitLabel),
    successMessage: str(r.successMessage),
    note: str(r.note),
    consentLabel: str(r.consentLabel),
    stepFields,
  };
}

/** The CTA destination, with the competitor's label given as intent only. */
function ctaIntent(link: { label: string; href: string } | undefined) {
  if (!link) return null;
  return { href: link.href, intent: link.label, note: "intent is the competitor's wording — write your own label with the same meaning" };
}

const FORM_COPY_CONTRACT = `"formCopy": { "submitLabel": "your own button label for the campaign's CTA concept (not the competitor's words)", "successMessage": "thank-you line", "note": "short reassurance under the button or null", "consentLabel": "consent line or null", "stepFields": { "<step title with no known fields>": [{ "label", "name", "type": "text|email|tel|url|select|textarea|radio|checkbox", "required", "options": [] }] } }`;

async function runJson(input: {
  content: ContentPart[];
  maxTokens: number;
  label: string;
  pass: UnifiedProgressInfo["pass"];
  signal?: AbortSignal;
  onProgress?: (info: UnifiedProgressInfo) => void;
}): Promise<{ json: Record<string, unknown> | null; raw: string; stopReason: string | null }> {
  input.onProgress?.({ chars: 0, pass: input.pass, label: input.label });
  const message = await streamUnifiedMessage({
    model: getAnthropicModel(),
    maxTokens: clampTokens(input.maxTokens),
    content: input.content,
    signal: input.signal,
    system: SYSTEM,
    onProgress: ({ chars }) =>
      input.onProgress?.({ chars, pass: input.pass, label: `${input.label} · ${Math.max(1, Math.round(chars / 1000))}k chars` }),
  });
  const raw = textFromMessage(message);
  return { json: extractJson(raw), raw, stopReason: message.stop_reason };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Facts split across section batches so each one leans on different evidence. */
export function partitionFacts<T>(facts: T[], parts: number, shared = 4): T[][] {
  const core = facts.slice(0, shared);
  const rest = facts.slice(shared);
  return Array.from({ length: Math.max(1, parts) }, (_, p) => [...core, ...rest.filter((_, i) => i % Math.max(1, parts) === p)]);
}

const SECTION_BATCH = 2;

export async function generateBlueprintPage(input: BlueprintGenerationInput): Promise<{
  response: UnifiedGenerationResponse;
  rawLength: number;
  model: string;
  formNotes: string[];
  ctaLabel: string | null;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Content generation is not configured. Contact your administrator.");
  }
  const { blueprint, design } = input;
  const hero = blueprint.sections[0];
  const body = blueprint.sections.slice(1);
  const slots = planImageSlots(blueprint.sections, input.imageBudget);
  const warnings: string[] = [];
  const unresolved: string[] = [];
  let rawLength = 0;

  const batches: BlueprintSection[][] = [];
  for (let i = 0; i < body.length; i += SECTION_BATCH) batches.push(body.slice(i, i + SECTION_BATCH));
  const factSets = partitionFacts(input.clientFacts, batches.length + 1, 4);
  const common = {
    client: clientBrief(input),
    campaignOffer: input.campaignOffer,
    classSystem: design.vocabulary,
    userFeedback: input.userFeedback || null,
    designDirection: input.designDirection || null,
  };

  // ——— Header + hero + footer ———
  const heroParts: ContentPart[] = [];
  const heroLabels: string[] = [];
  if (blueprint.header?.crop) {
    heroParts.push(imagePart(blueprint.header.crop));
    heroLabels.push("Image 1: competitor header");
  }
  if (hero?.crop) {
    heroParts.push(imagePart(hero.crop));
    heroLabels.push(`Image ${heroLabels.length + 1}: competitor hero (${hero.id})`);
  }
  if (blueprint.footer?.crop) {
    heroParts.push(imagePart(blueprint.footer.crop));
    heroLabels.push(`Image ${heroLabels.length + 1}: competitor footer`);
  }
  const heroForm = input.form && hero && input.form.sectionId === hero.id;
  heroParts.push({
    type: "text",
    text: JSON.stringify({
      task: "Rebuild the competitor's header, hero section and footer for the client.",
      images: heroLabels,
      ...common,
      clientFacts: factSets[0].slice(0, 10),
      header: {
        competitor: blueprint.header ? { menuItems: blueprint.header.nav.length, hasCta: Boolean(blueprint.header.cta), dark: blueprint.header.dark, logoPosition: blueprint.header.logoPosition } : null,
        useNav: input.destinations.nav,
        cta: ctaIntent(input.destinations.cta[0]),
        markup: `<header class="adr-header${blueprint.header?.dark ? " adr-header--dark" : ""}"><div class="adr-container adr-header-inner"><a class="adr-brand" href="${input.client.url}"><img data-logo-role="company" src="{{ADRIVAL_IDENTITY_LOGO}}" alt="${input.client.name} logo"></a><nav aria-label="Primary"><ul class="adr-nav">…</ul></nav><a class="adr-btn adr-btn--primary" href="…">…</a></div></header>`,
        rules: "Use ONLY useNav links (same count as the competitor at most). If useNav is empty, show logo + CTA only. Exactly one CTA button.",
      },
      hero: hero ? sectionSpec(hero, slots, heroForm ? input.form : null) : null,
      footer: {
        competitor: blueprint.footer ? { columns: blueprint.footer.columns, dark: blueprint.footer.dark } : null,
        columns: input.destinations.footerColumns,
        links: input.destinations.footer,
        social: input.destinations.social,
        phones: input.destinations.phones,
        emails: input.destinations.emails,
        markup: `<footer class="adr-footer${blueprint.footer?.dark ? " adr-footer--dark" : ""}"><div class="adr-container"><div class="adr-footer-grid">(brand column with logo + one-line description, then link columns: <div><h3>Heading</h3><ul><li><a href>…</a></li></ul></div>)</div><div class="adr-footer-meta">© year ${input.client.name} · contact</div></div></footer>`,
        rules: "Only the links given. Match the competitor's column count when enough links exist; never invent pages.",
      },
      copyRules: [
        "Hero H1: the client's version of the competitor's promise, built around the campaign offer and keyword. Keep it about as long as the competitor's.",
        "Hero CTA follows campaignOffer's CTA concept.",
        heroForm ? "The hero holds the lead form — include the form slot." : "No form in the hero unless formSlot says so.",
      ],
      outputContract: `{ "headerHtml": "<header>…</header>", "heroHtml": "<section class=\\"adr-section …\\" data-section-id=\\"${hero?.id || "sec-1"}\\">…</section>", "footerHtml": "<footer>…</footer>", "title": "page <title>", "description": "meta description", "ctaLabel": "your own 2-6 word primary button label for the campaign CTA (never the competitor's wording); use it for every primary button", "imageSlots": [{ "id": "planned slot id", "purpose": "…", "prompt": "photographic scene for the client, no text, no logos", "alt": "…" }], ${heroForm ? `${FORM_COPY_CONTRACT}, ` : ""}"warnings": [], "unresolvedRequirements": [] }`,
    }),
  });

  const heroPromise = runJson({
    content: heroParts,
    maxTokens: 16_000,
    label: "Header, hero and footer",
    pass: "hero",
    signal: input.signal,
    onProgress: input.onProgress,
  });

  // ——— Body sections, in parallel ———
  const batchPromise = mapLimit(batches, 3, async (batch, b) => {
    const parts: ContentPart[] = [];
    const labels: string[] = [];
    for (const s of batch) {
      if (s.crop) {
        parts.push(imagePart(s.crop));
        labels.push(`Image ${labels.length + 1}: competitor section ${s.id} (${s.kind})`);
      }
    }
    const formHere = input.form && batch.some((s) => s.id === input.form!.sectionId);
    parts.push({
      type: "text",
      text: JSON.stringify({
        task: `Rebuild competitor sections ${batch.map((s) => s.id).join(", ")} for the client (part ${b + 1} of ${batches.length}).`,
        images: labels,
        ...common,
        clientFacts: factSets[b + 1] || factSets[0],
        pageOutline: blueprint.sections.map((s) => `${s.id} ${s.kind}${s.heading ? `: ${s.heading.slice(0, 60)}` : ""}`),
        sections: batch.map((s) => sectionSpec(s, slots, formHere ? input.form : null)),
        proofLogos: input.proofLogos.map((l, i) => ({ src: `{{ADRIVAL_PROOF_LOGO}}-${i + 1}`, alt: l.alt })),
        cta: ctaIntent(input.destinations.cta[0]),
        copyRules: [
          "Each section: same structure, card/item count and roughly targetWords as the competitor content.",
          "Give each section its own angle; do not repeat the hero's headline or lines from other sections.",
          "Logo strips: use proofLogos with data-logo-role=\"proof\" when available, otherwise a row of .adr-badge items built only from clientFacts, or omit the strip.",
          "At most one primary button per section; prefer .adr-link for secondary actions.",
          "Testimonials/case studies: never invent quotes, names or numbers — rebuild as client promises, process or fact-backed proof in the same card layout.",
        ],
        outputContract: `{ "sections": [{ "id": "…", "html": "<section class=\\"adr-section …\\" data-section-id=\\"…\\">…</section>", "imageSlots": [{ "id": "planned slot id", "purpose": "…", "prompt": "photographic scene for the client, no text, no logos", "alt": "…" }] }], ${formHere ? `${FORM_COPY_CONTRACT}, ` : ""}"warnings": [], "unresolvedRequirements": [] }`,
      }),
    });
    const maxTokens = Math.min(16_000, 3_500 + batch.reduce((n, s) => n + Math.min(4_000, 900 + s.wordCount * 9), 0));
    let result = await runJson({
      content: parts,
      maxTokens,
      label: `Sections ${batch[0].order + 1}–${batch[batch.length - 1].order + 1} of ${blueprint.sections.length}`,
      pass: "body",
      signal: input.signal,
      onProgress: input.onProgress,
    });
    if (!Array.isArray(result.json?.sections)) {
      result = await runJson({
        content: parts,
        maxTokens: Math.min(16_000, maxTokens + 4_000),
        label: `Sections ${batch[0].order + 1}–${batch[batch.length - 1].order + 1} (retry)`,
        pass: "body",
        signal: input.signal,
        onProgress: input.onProgress,
      });
    }
    return { batch, result };
  });

  const [firstHero, batchResults] = await Promise.all([heroPromise, batchPromise]);
  let heroResult = firstHero;
  // The header, hero and footer come back in one answer; if it was cut off or
  // unreadable, ask once more with more room before giving up on the page.
  if (typeof heroResult.json?.heroHtml !== "string" || !/<section[\s>]/i.test(String(heroResult.json.heroHtml))) {
    console.warn(
      `[blueprint] hero answer unusable (stop=${heroResult.stopReason}, chars=${heroResult.raw.length}, json=${Boolean(heroResult.json)}); retrying`,
    );
    heroResult = await runJson({
      content: heroParts,
      maxTokens: 20_000,
      label: "Header, hero and footer (retry)",
      pass: "hero",
      signal: input.signal,
      onProgress: input.onProgress,
    });
  }
  rawLength += heroResult.raw.length + batchResults.reduce((n, r) => n + r.result.raw.length, 0);

  const heroJson = heroResult.json;
  const headerHtml = typeof heroJson?.headerHtml === "string" ? heroJson.headerHtml : "";
  const heroHtml = typeof heroJson?.heroHtml === "string" ? heroJson.heroHtml : "";
  const footerHtml = typeof heroJson?.footerHtml === "string" ? heroJson.footerHtml : "";
  if (!/<section[\s>]/i.test(heroHtml)) {
    throw new Error("The hero section could not be generated.");
  }
  const imageSlots: UnifiedImageSlot[] = [...slotsFrom(heroJson?.imageSlots, slots, hero?.id || "sec-1")];
  let formCopy: LeadFormCopy | null = heroForm ? formCopyFrom(heroJson?.formCopy) : null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  warnings.push(...strings(heroJson?.warnings));
  unresolved.push(...strings(heroJson?.unresolvedRequirements));

  const fragments = new Map<string, string>();
  fragments.set(hero!.id, heroHtml);
  for (const { batch, result } of batchResults) {
    const rows = Array.isArray(result.json?.sections) ? (result.json!.sections as Array<Record<string, unknown>>) : [];
    for (const s of batch) {
      const row = rows.find((r) => String(r.id || "") === s.id);
      const html = typeof row?.html === "string" ? row.html : "";
      if (!/<section[\s>]/i.test(html)) {
        unresolved.push(`Section ${s.id} (${s.kind}) could not be generated.`);
        continue;
      }
      fragments.set(s.id, html);
      imageSlots.push(...slotsFrom(row?.imageSlots, slots, s.id));
    }
    if (!formCopy && input.form && batch.some((s) => s.id === input.form!.sectionId)) {
      formCopy = formCopyFrom(result.json?.formCopy);
    }
    warnings.push(...strings(result.json?.warnings));
    unresolved.push(...strings(result.json?.unresolvedRequirements));
    if (result.stopReason === "max_tokens") warnings.push(`Sections ${batch.map((s) => s.id).join(", ")} hit the output limit.`);
  }

  // ——— Assemble ———
  const ordered = blueprint.sections
    .map((s) => ({ id: s.id, html: fragments.get(s.id) || "" }))
    .filter((s) => s.html);
  const cleaned = ordered.map((s) => sanitizeFragment(s.html, s.id));
  const sectionCss = mergeSectionStyles(cleaned.map((c) => ({ id: c.id, css: c.css })));
  let main = cleaned.map((c) => c.html).join("\n");

  // One primary button label in the client's words, replacing the competitor's
  // CTA wording wherever a section echoed it.
  const competitorCtas = [
    blueprint.header?.cta,
    typeof input.campaignOffer?.cta === "string" ? (input.campaignOffer.cta as string) : null,
    input.form?.submitLabel,
    ...blueprint.sections.flatMap((s) => s.blocks.filter((b) => b.role === "button").map((b) => b.text)),
  ]
    .map((t) => (t || "").replace(/\s+/g, " ").trim())
    .filter((t) => t.split(" ").length >= 3 && t.length <= 60);
  const proposed = typeof heroJson?.ctaLabel === "string" ? heroJson.ctaLabel.replace(/\s+/g, " ").trim().slice(0, 48) : "";
  const ctaLabel = proposed && !competitorCtas.some((c) => normText(c) === normText(proposed)) ? proposed : null;
  const swapCtas = (html: string) => swapCtaLabels(html, competitorCtas, ctaLabel);

  const formNotes: string[] = [];
  if (input.form) {
    const built = buildLeadFormHtml(input.form, {
      ...(formCopy || {}),
      submitLabel: formCopy?.submitLabel || ctaLabel || input.form.submitLabel,
    });
    formNotes.push(...built.notes);
    const panel = `<div class="adr-form-panel">${built.html}</div>`;
    const slotRe = new RegExp(`<div[^>]*${FORM_SLOT_ATTR}[^>]*>\\s*</div>`, "i");
    if (slotRe.test(main)) {
      main = main.replace(slotRe, panel);
    } else if (input.form.sectionId && main.includes(`data-section-id="${input.form.sectionId}"`)) {
      // The model skipped the slot: put the form at the end of its section.
      const idx = main.indexOf(`data-section-id="${input.form.sectionId}"`);
      const close = main.indexOf("</section>", idx);
      main = `${main.slice(0, close)}<div class="adr-container">${panel}</div>${main.slice(close)}`;
      formNotes.push("The form was added at the end of its section because the layout had no form slot.");
    } else {
      main += `<section class="adr-section" data-section-id="adr-lead-form-section"><div class="adr-container adr-narrow">${panel}</div></section>`;
      formNotes.push("The form's section could not be generated, so the form was added before the footer.");
    }
  }
  // Any leftover slots (duplicates) are removed.
  main = swapCtas(main.replace(new RegExp(`<div[^>]*${FORM_SLOT_ATTR}[^>]*>\\s*</div>`, "gi"), ""));

  const title = typeof heroJson?.title === "string" ? heroJson.title : input.client.name;
  const description = typeof heroJson?.description === "string" ? heroJson.description : "";
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${design.fontLinks.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n")}
<style>
${design.css}
${sectionCss}
</style>
</head>
<body>
${swapCtas(sanitizeFragment(headerHtml || "<header></header>", "header").html)}
<main id="adr-sections">
${main}
</main>
${swapCtas(sanitizeFragment(footerHtml || "<footer></footer>", "footer").html)}
${input.form ? LEAD_FORM_SCRIPT : ""}
</body>
</html>`;

  const missing = blueprint.sections.filter((s) => !fragments.has(s.id)).map((s) => s.id);
  if (missing.length) unresolved.push(`Sections not generated: ${missing.join(", ")}.`);

  return {
    response: {
      html,
      title,
      description,
      sections: blueprint.sections.map((s) => ({ id: s.id, heading: s.heading || undefined, purpose: s.kind })),
      imageSlots,
      warnings,
      unresolvedRequirements: unresolved,
    },
    rawLength,
    model: getAnthropicModel(),
    formNotes,
    ctaLabel,
  };
}

export function normText(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Replace button and link labels that repeat a competitor CTA with the client's label. */
export function swapCtaLabels(html: string, competitorCtas: string[], label: string | null): string {
  if (!label || !competitorCtas.length) return html;
  const set = new Set(competitorCtas.map(normText));
  return html.replace(/(<(a|button)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi, (whole, open: string, _tag: string, inner: string, close: string) => {
    if (/<(img|svg)\b/i.test(inner)) return whole;
    const text = inner.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/[→↓›»>]/g, " ");
    if (!set.has(normText(text))) return whole;
    const arrow = /→|&rarr;/.test(inner) ? " →" : "";
    return `${open}${label}${arrow}${close}`;
  });
}

const FORM_HOLD_RE = /<div class="adr-form-panel">[\s\S]*?<\/form>\s*<\/div>/i;

/** Take the built form out of a section while it is rewritten, and put it back after. */
export function holdForm(sectionHtml: string): { html: string; restore: (html: string) => string } {
  const match = sectionHtml.match(FORM_HOLD_RE);
  if (!match) return { html: sectionHtml, restore: (h) => h };
  const panel = match[0];
  const slot = new RegExp(`<div[^>]*${FORM_SLOT_ATTR}[^>]*>\\s*</div>`, "i");
  return {
    html: sectionHtml.replace(panel, `<div ${FORM_SLOT_ATTR}></div>`),
    restore: (h) =>
      slot.test(h) ? h.replace(slot, panel) : h.replace(/<\/section>\s*$/i, `<div class="adr-container">${panel}</div></section>`),
  };
}

/**
 * Reword only the lines that echo the competitor, keeping the section's
 * markup, classes and layout exactly as they are.
 */
export async function rewordBlueprintSection(input: {
  sectionHtml: string;
  copiedLines: string[];
  client: BlueprintGenerationInput["client"];
  keyword: string;
  clientFacts: BlueprintGenerationInput["clientFacts"];
  signal?: AbortSignal;
  onProgress?: (info: UnifiedProgressInfo) => void;
  label: string;
}): Promise<string | null> {
  const held = holdForm(input.sectionHtml);
  const result = await runJson({
    content: [{
      type: "text",
      text: JSON.stringify({
        task: "Some lines in this section repeat a competitor's wording. Rewrite ONLY those lines, and any sentence that closely paraphrases them, in original words for the client. Keep every tag, class, attribute, link, image and the form slot exactly as they are. Keep the same meaning, length and tone.",
        competitorLinesToAvoid: input.copiedLines.slice(0, 12),
        client: { name: input.client.name, whatTheyDo: input.client.whatTheyDo, offerings: input.client.offerings.slice(0, 10), keyword: input.keyword },
        clientFacts: input.clientFacts.slice(0, 12),
        sectionHtml: held.html,
        outputContract: `{ "html": "the same <section>…</section> with only those lines reworded" }`,
      }),
    }],
    maxTokens: Math.min(12_000, 2_000 + Math.ceil(held.html.length / 2.5)),
    label: input.label,
    pass: "polish",
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const html = typeof result.json?.html === "string" ? result.json.html : "";
  if (!/<section[\s>]/i.test(html)) return null;
  // Reject rewrites that changed the structure rather than the words.
  const tags = (h: string) => (h.match(/<[a-z][a-z0-9]*\b/gi) || []).length;
  const before = tags(held.html);
  if (Math.abs(tags(html) - before) > Math.max(4, before * 0.12)) return null;
  return held.restore(sanitizeFragment(html, "reword").html);
}

/** Regenerate one section with feedback about how it differs from the competitor. */
export async function regenerateBlueprintSection(input: BlueprintGenerationInput & {
  section: BlueprintSection;
  problems: string[];
  currentHtml: string;
}): Promise<{ html: string; css: string; imageSlots: UnifiedImageSlot[] } | null> {
  const slots = planImageSlots(input.blueprint.sections, input.imageBudget);
  const parts: ContentPart[] = [];
  if (input.section.crop) parts.push(imagePart(input.section.crop));
  parts.push({
    type: "text",
    text: JSON.stringify({
      task: `Rebuild competitor section ${input.section.id} again. The previous attempt did not match the competitor closely enough.`,
      problems: input.problems,
      previousAttempt: input.currentHtml.slice(0, 12_000),
      client: clientBrief(input),
      campaignOffer: input.campaignOffer,
      classSystem: input.design.vocabulary,
      designDirection: input.designDirection || null,
      clientFacts: input.clientFacts.slice(0, 12),
      section: sectionSpec(input.section, slots, input.form),
      outputContract: `{ "sections": [{ "id": "${input.section.id}", "html": "<section …>…</section>", "imageSlots": [] }] }`,
    }),
  });
  const result = await runJson({
    content: parts,
    maxTokens: Math.min(14_000, 4_000 + input.section.wordCount * 10),
    label: `Refining section ${input.section.order + 1}`,
    pass: "polish",
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const row = Array.isArray(result.json?.sections) ? (result.json!.sections as Array<Record<string, unknown>>)[0] : null;
  const html = typeof row?.html === "string" ? row.html : "";
  if (!/<section[\s>]/i.test(html)) return null;
  const cleaned = sanitizeFragment(html, input.section.id);
  return { html: cleaned.html, css: cleaned.css, imageSlots: slotsFrom(row?.imageSlots, slots, input.section.id) };
}

/**
 * Fix design-check findings in one section (Impeccable polish): same layout,
 * same content, only the listed problems changed.
 */
export async function polishBlueprintSection(input: {
  section: BlueprintSection;
  sectionHtml: string;
  findings: string[];
  classSystem: string;
  designDirection?: BlueprintGenerationInput["designDirection"];
  signal?: AbortSignal;
  onProgress?: (info: UnifiedProgressInfo) => void;
}): Promise<{ html: string; css: string } | null> {
  const held = holdForm(input.sectionHtml);
  const parts: ContentPart[] = [];
  if (input.section.crop) parts.push(imagePart(input.section.crop));
  parts.push({
    type: "text",
    text: JSON.stringify({
      task: `Polish section ${input.section.id}. A design check found the problems listed below.`,
      instructions: repairGuide(),
      findings: input.findings,
      image: input.section.crop ? "Image 1: the competitor section this layout follows (layout reference only)." : null,
      classSystem: input.classSystem,
      designDirection: input.designDirection || null,
      sectionHtml: held.html,
      outputContract: `{ "html": "the same <section …>…</section> with the findings fixed" }`,
    }),
  });
  const result = await runJson({
    content: parts,
    maxTokens: Math.min(14_000, 3_000 + Math.ceil(held.html.length / 2.5)),
    label: `Polishing section ${input.section.order + 1}`,
    pass: "polish",
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const html = typeof result.json?.html === "string" ? result.json.html : "";
  if (!/<section[\s>]/i.test(html)) return null;
  // A polish keeps the structure; reject rewrites that rebuilt the section.
  const tags = (h: string) => (h.match(/<[a-z][a-z0-9]*\b/gi) || []).length;
  const before = tags(held.html);
  if (Math.abs(tags(html) - before) > Math.max(6, before * 0.25)) return null;
  const cleaned = sanitizeFragment(html, input.section.id);
  return { html: held.restore(cleaned.html), css: cleaned.css };
}
