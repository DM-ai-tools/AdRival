import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import {
  assembleUnifiedHtml,
  parseBodyBatch,
  parseHeroPass,
  parseUnifiedResponse,
  type BodySectionFragment,
  type UnifiedGenerationResponse,
} from "./contract";
import {
  buildBodyBatchBrief,
  buildDeterministicSpine,
  buildHeroBrief,
  parseUnifiedBriefPayload,
  splitBriefSections,
  type UnifiedBrief,
} from "./brief";

const SYSTEM = `You are a senior front-end developer and conversion copywriter rebuilding landing pages.

You CLONE the competitor's VISUAL STRUCTURE from any attached screenshots (section order, hero composition, media placement, CTA placement, density) AND their CAMPAIGN OFFER TYPE (primaryOffer + CTA concept from campaignOffer). You DISCARD their identity, colours, type, verbatim copy, claims, testimonials, and imagery — then restyle with the CLIENT brand tokens.

Hard limits:
- Screenshots (when attached) are authoritative for layout. Do NOT invent a generic agency/SaaS landing-page template.
- Never reproduce the competitor logo, wordmark, mascot, or brand assets (including SVG redraws).
- Never copy or closely paraphrase competitor sentences.
- Never invent statistics, named clients, awards, testimonials, or people.
- campaignOffer is mandatory for hero badge, headline angle, service focus, and primary CTA.
- clientFacts are supporting evidence only — they must not override campaignOffer.
- Use ONLY the brand brief / asset registry for identity, claims, destinations, and logos.
- Put colours, radii, shadows, and fonts in :root CSS variables; no scattered raw hex later.
- Prefer compact CSS. Avoid huge utility dumps.
- Company logo must use src="{{ADRIVAL_IDENTITY_LOGO}}" with data-logo-role="company".
- Proof logos only from proofLogos with data-logo-role="proof".
- Illustrative slots: empty img with data-adrival-slot and a transparent 1x1 data URI; prompts say "no logos, no readable text".
- Return ONE JSON object matching the outputContract for the current pass. Keep responses short and complete.`;

export type UnifiedPassId = "spine" | "hero" | "body" | "assemble" | "polish" | "compact";

export type UnifiedProgressInfo = {
  chars: number;
  pass: UnifiedPassId;
  label: string;
  batchIndex?: number;
  batchCount?: number;
};

function clampTokens(desired: number): number {
  const fromEnv = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || "");
  const envCap =
    Number.isFinite(fromEnv) && fromEnv >= 4000
      ? Math.floor(fromEnv)
      : 24_000;
  return Math.min(desired, envCap);
}

type StreamedMessage = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
};

type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
        data: string;
      };
    };

async function streamUnifiedMessage(input: {
  model: string;
  maxTokens: number;
  content: ContentPart[];
  onProgress?: (info: { chars: number }) => void;
  signal?: AbortSignal;
}): Promise<StreamedMessage> {
  if (input.signal?.aborted) {
    const err = new Error("Recreation stopped");
    err.name = "AbortError";
    throw err;
  }
  const client = getAnthropicClient();
  const stream = client.messages.stream(
    {
      model: input.model,
      max_tokens: input.maxTokens,
      system: SYSTEM,
      messages: [{ role: "user", content: input.content }],
    },
    input.signal ? { signal: input.signal } : undefined,
  );
  let chars = 0;
  let lastEmit = 0;
  stream.on("text", (delta: string) => {
    chars += delta.length;
    const now = Date.now();
    if (now - lastEmit >= 8_000) {
      lastEmit = now;
      try {
        input.onProgress?.({ chars });
      } catch {
        /* ignore */
      }
    }
  });
  const message = await stream.finalMessage();
  if (chars > 0) {
    try {
      input.onProgress?.({ chars });
    } catch {
      /* ignore */
    }
  }
  return message as StreamedMessage;
}

function textFromMessage(message: StreamedMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text || "" : "")).join("\n");
}

function buildUserContent(active: UnifiedBrief, instruction: string): ContentPart[] {
  const content: ContentPart[] = [];
  // Prefer fold + full-page when available for accurate section replication.
  for (const tile of active.imageTiles.slice(0, 2)) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: tile.mediaType,
        data: tile.data,
      },
    });
  }
  content.push({
    type: "text",
    text: `${active.text}\n\n${instruction}`,
  });
  return content;
}

function tryParseFull(raw: string): UnifiedGenerationResponse | null {
  try {
    return parseUnifiedResponse(raw);
  } catch {
    return null;
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("Recreation stopped");
    err.name = "AbortError";
    throw err;
  }
}

/** Body sections in small batches so every inventory section is generated. */
const BODY_BATCH_SIZE = 3;

export async function generateUnifiedPage(
  brief: UnifiedBrief,
  options?: {
    compactBrief?: UnifiedBrief | null;
    onProgress?: (info: UnifiedProgressInfo) => void;
    signal?: AbortSignal;
  },
): Promise<{
  response: UnifiedGenerationResponse;
  rawLength: number;
  model: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Content generation is not configured. Contact your administrator.");
  }
  const model = getAnthropicModel();
  console.info(`[unified] lean multipass generate model=${model}`);

  const emit = (info: UnifiedProgressInfo) => {
    try {
      options?.onProgress?.(info);
    } catch {
      /* ignore */
    }
  };

  const runPass = async (input: {
    brief: UnifiedBrief;
    pass: UnifiedPassId;
    label: string;
    maxTokens: number;
    instruction: string;
    batchIndex?: number;
    batchCount?: number;
  }) => {
    assertNotAborted(options?.signal);
    emit({
      chars: 0,
      pass: input.pass,
      label: input.label,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
    });
    console.info(
      `[unified] pass=${input.pass} max_tokens=${clampTokens(input.maxTokens)} briefChars=${input.brief.text.length} images=${input.brief.imageTiles.length}`,
    );
    const completion = await streamUnifiedMessage({
      model,
      maxTokens: clampTokens(input.maxTokens),
      content: buildUserContent(input.brief, input.instruction),
      signal: options?.signal,
      onProgress: ({ chars }) =>
        emit({
          chars,
          pass: input.pass,
          label: `${input.label}${chars ? ` · ${Math.max(1, Math.round(chars / 1000))}k chars` : ""}`,
          batchIndex: input.batchIndex,
          batchCount: input.batchCount,
        }),
    });
    return { raw: textFromMessage(completion), stopReason: completion.stop_reason };
  };

  const payload = parseUnifiedBriefPayload(brief);
  const imageBudget = Math.min(Number(payload.imageBudget) || 1, 1);
  const { bodySections: bodyPlan } = splitBriefSections(payload);

  // ——— Pass A: deterministic spine (no Claude call) ———
  emit({ chars: 0, pass: "spine", label: "Design spine (local tokens)" });
  const spine = buildDeterministicSpine(brief);

  // ——— Pass B: Hero + chrome (screenshot) — single attempt ———
  const heroBrief = buildHeroBrief(brief, spine.css);
  const heroResult = await runPass({
    brief: heroBrief,
    pass: "hero",
    label: "Hero + fold chrome",
    maxTokens: 12_000,
    instruction: heroBrief.imageTiles.length
      ? "Pass B. Clone the attached competitor screenshot(s) for header + hero. REQUIRED JSON: { headerHtml, heroHtml, footerHtml, imageSlots, title, description }. headerHtml = logo + ONLY destinationRegistry.nav (short menu labels, never headlines/slogans) + one CTA. footerHtml = competitor-shaped multi-column footer with destinationRegistry.footer. Include the single lead form when competitorSections has kind=form."
      : "Pass B. No screenshot — clone campaignOffer + hero. REQUIRED JSON: { headerHtml, heroHtml, footerHtml, imageSlots, title, description }. headerHtml = logo + destinationRegistry.nav + CTA. footerHtml = full multi-column footer.",
  });
  let hero = (() => {
    try {
      return parseHeroPass(heroResult.raw);
    } catch (err) {
      console.warn("[unified] hero parse failed", err);
      return null;
    }
  })();
  // One cheap retry only if completely unusable (no screenshot on retry to save vision cost).
  if (!hero) {
    const retryBrief = { ...heroBrief, imageTiles: [] as UnifiedBrief["imageTiles"] };
    const retry = await runPass({
      brief: retryBrief,
      pass: "hero",
      label: "Hero (text retry)",
      maxTokens: 10_000,
      instruction:
        "RETRY Pass B. Return JSON with headerHtml (<header> logo+nav+CTA), heroHtml (<section>), REQUIRED footerHtml (<footer> multi-column), and at most 1 imageSlot. No invented ratings.",
    });
    hero = parseHeroPass(retry.raw);
  }
  if (!hero) {
    throw new Error("Hero pass failed to produce usable header/hero HTML.");
  }

  // ——— Pass C: body sections in batches covering the full inventory ———
  const bodyFragments: BodySectionFragment[] = [];
  const allWarnings = [...hero.warnings];
  const allUnresolved = [...hero.unresolvedRequirements];
  let usedSlots = hero.imageSlots.length;
  let bodyRawChars = 0;

  const runBodyBatch = async (
    batch: typeof bodyPlan,
    batchIndex: number,
    batchCount: number,
  ) => {
    if (!batch.length) return;
    const remaining = Math.max(0, imageBudget - usedSlots);
    const batchBrief = buildBodyBatchBrief({
      base: brief,
      spineCss: spine.css,
      batchSections: batch as Array<Record<string, unknown>>,
      priorSectionSummaries: bodyFragments.map((s) => ({ id: s.id, heading: s.heading })),
      heroHeading: hero!.title || null,
      remainingImageBudget: remaining,
      batchIndex,
      batchCount,
    });
    // Attach full-page screenshot so body sections match competitor layout.
    if (brief.imageTiles.length) {
      batchBrief.imageTiles = brief.imageTiles.slice(0, 2);
    }
    const from = batchIndex * BODY_BATCH_SIZE + 1;
    const to = batchIndex * BODY_BATCH_SIZE + batch.length;
    const label = `Body sections (${from}–${to} of ${bodyPlan.length})`;
    let batchRaw = await runPass({
      brief: batchBrief,
      pass: "body",
      label,
      maxTokens: 18_000,
      instruction:
        "Pass C. Use attached competitor screenshot(s) to clone each section's layout AND content density. Return JSON { sections: [{ id, html, heading, purpose, imageSlots }] }. One entry for EVERY competitorSections id — never omit. Each html is a <section> fragment only. Match columns/media/density from the screenshot. Keep card/list copy as long as the competitor (do not thin to one short line). Compact CSS. Use lockedCss variables only. Include the single form only for the section that has kind=form — build it from competitorForm fields, never a 3-field template.",
      batchIndex,
      batchCount,
    });
    bodyRawChars += batchRaw.raw.length;
    let parsedBatch = (() => {
      try {
        return parseBodyBatch(batchRaw.raw);
      } catch {
        return null;
      }
    })();
    if (!parsedBatch) {
      console.warn(`[unified] body batch ${batchIndex + 1} parse failed; retrying once`);
      batchRaw = await runPass({
        brief: batchBrief,
        pass: "body",
        label: `${label} (retry)`,
        maxTokens: 12_000,
        instruction:
          "RETRY Pass C. Return ONLY JSON { sections: [{ id, html, heading, purpose, imageSlots }] } with one compact <section> per requested id.",
        batchIndex,
        batchCount,
      });
      bodyRawChars += batchRaw.raw.length;
      parsedBatch = parseBodyBatch(batchRaw.raw);
    }
    const returnedIds = new Set(parsedBatch.sections.map((s) => s.id));
    for (const section of parsedBatch.sections) {
      if (bodyFragments.some((existing) => existing.id === section.id)) continue;
      bodyFragments.push(section);
      usedSlots += section.imageSlots.length;
    }
    allWarnings.push(...parsedBatch.warnings);
    allUnresolved.push(...parsedBatch.unresolvedRequirements);
    const missingInBatch = batch
      .map((s) => String((s as { id?: string }).id || ""))
      .filter((id) => id && !returnedIds.has(id));
    if (missingInBatch.length) {
      allWarnings.push(
        `Body batch ${batchIndex + 1} omitted section ids: ${missingInBatch.join(", ")}.`,
      );
    }
  };

  if (bodyPlan.length) {
    const batchCount = Math.max(1, Math.ceil(bodyPlan.length / BODY_BATCH_SIZE));
    for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
      const batch = bodyPlan.slice(
        batchIndex * BODY_BATCH_SIZE,
        (batchIndex + 1) * BODY_BATCH_SIZE,
      );
      await runBodyBatch(batch, batchIndex, batchCount);
    }

    // Fill-in pass for any sections still missing after the main batches.
    const haveIds = new Set(bodyFragments.map((s) => s.id));
    const missing = bodyPlan.filter(
      (s) => String((s as { id?: string }).id || "") && !haveIds.has(String((s as { id?: string }).id)),
    );
    if (missing.length) {
      allWarnings.push(
        `Retrying ${missing.length} missing body section(s): ${missing
          .map((s) => (s as { id?: string }).id)
          .join(", ")}.`,
      );
      await runBodyBatch(missing, batchCount, batchCount + 1);
    }
  }

  const finalHave = new Set(bodyFragments.map((s) => s.id));
  const stillMissing = bodyPlan
    .map((s) => String((s as { id?: string }).id || ""))
    .filter((id) => id && !finalHave.has(id));
  if (stillMissing.length) {
    allUnresolved.push(
      `Sections not generated after retries: ${stillMissing.join(", ")}.`,
    );
  }

  // ——— Pass D: Deterministic assemble (no polish call) ———
  emit({ chars: 0, pass: "assemble", label: "Assembling page" });
  assertNotAborted(options?.signal);
  let assembled = assembleUnifiedHtml({
    spine,
    hero,
    bodySections: bodyFragments,
    imageBudget,
  });
  assembled = {
    ...assembled,
    warnings: [
      ...assembled.warnings,
      ...allWarnings,
      "Continuity polish skipped to conserve generation budget.",
    ],
    unresolvedRequirements: [...assembled.unresolvedRequirements, ...allUnresolved],
  };

  if (!assembled.html || !/<\/html>/i.test(assembled.html)) {
    throw new Error("The page could not be assembled from the generated sections.");
  }

  return {
    response: assembled,
    rawLength: heroResult.raw.length + bodyRawChars,
    model,
  };
}

/** Thrown when a full-page repair hits the output limit. Callers should keep the assembled page. */
export class UnifiedRepairIncompleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnifiedRepairIncompleteError";
  }
}

export async function repairUnifiedPage(input: {
  html: string;
  defects: string[];
  briefText?: string;
  signal?: AbortSignal;
}): Promise<{ response: UnifiedGenerationResponse; model: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Content generation is not configured. Contact your administrator.");
  }
  const model = getAnthropicModel();
  const completion = await streamUnifiedMessage({
    model,
    maxTokens: clampTokens(24_000),
    signal: input.signal,
    content: [{
      type: "text",
      text: `Repair this landing page. Keep correct content and unaffected sections. Preserve :root tokens, logo roles, and layout variety. Return the complete document — do not stop mid-tag.
Defects to fix:
${input.defects.slice(0, 8).map((item, index) => `${index + 1}. ${item}`).join("\n")}

Current HTML:
${input.html.slice(0, 28_000)}

Return JSON with a complete repaired HTML document ending in </html>.`,
    }],
  });
  const raw = textFromMessage(completion);
  const parsed = tryParseFull(raw);
  if (!parsed || !/<\/html>/i.test(parsed.html || "")) {
    throw new UnifiedRepairIncompleteError(
      completion.stop_reason === "max_tokens"
        ? "The repair response was truncated before the page was complete."
        : "The repair response could not be parsed as a complete page.",
    );
  }
  return { response: parsed, model };
}
