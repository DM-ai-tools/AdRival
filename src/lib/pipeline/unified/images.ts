import type { BrandColors, GeneratedLandingImage } from "../../types";
import { generateGptImage2, hasRunwayKey, type GptImage2Ratio } from "../../runway/client";
import { OPENAI_IMAGE_MODEL, generateOpenAIImage, hasOpenAIImageKey, isOpenAIQuotaError } from "../../openai/images";
import { buildImagePrompt, readSlotSurroundings, type ImageContext, type SlotSurroundings } from "./imagePrompt";
import { planImageBriefs } from "./imageBriefs";
import { checkLandingImage, redrawInstructions } from "./imageQa";
import {
  applyImageSlotsToHtml,
  placeholderDataUri,
  type UnifiedImageReport,
  type UnifiedImageSlot,
} from "./contract";

function asRatio(value: string): GptImage2Ratio {
  const allowed: GptImage2Ratio[] = [
    "2048:880",
    "1920:1088",
    "1920:1280",
    "1920:1440",
    "1920:1536",
    "1920:1920",
    "1536:1920",
    "1440:1920",
    "1280:1920",
    "1088:1920",
    "auto",
  ];
  return (allowed.includes(value as GptImage2Ratio) ? value : "1920:1088") as GptImage2Ratio;
}

/**
 * Which service draws the images: OpenAI's GPT Image 2 when OPENAI_API_KEY is
 * set (or IMAGE_PROVIDER=openai), Runway otherwise. IMAGE_PROVIDER=runway
 * forces Runway.
 */
export function imageProvider(): "openai" | "runway" | null {
  const forced = process.env.IMAGE_PROVIDER?.trim().toLowerCase();
  if (forced === "runway") return hasRunwayKey() ? "runway" : null;
  if (hasOpenAIImageKey()) return "openai";
  return hasRunwayKey() ? "runway" : null;
}

/** Draw one image and return it as a data URI to embed in the page. */
export async function renderLandingImage(input: {
  slot: Pick<UnifiedImageSlot, "id" | "purpose" | "prompt" | "aspectRatio" | "alt" | "medium">;
  context: ImageContext;
  surroundings?: SlotSurroundings | null;
  revision?: string | null;
  competitorId: string;
  signal?: AbortSignal;
}): Promise<{ dataUri: string; provider: "openai" | "runway"; model: string; taskId: string | null; finalPrompt: string }> {
  const provider = imageProvider();
  if (!provider) throw new Error("No image service is configured.");
  const finalPrompt = buildImagePrompt({
    scene: input.slot.prompt,
    purpose: input.slot.purpose,
    alt: input.slot.alt,
    aspect: input.slot.aspectRatio,
    context: input.context,
    surroundings: input.surroundings,
    medium: input.slot.medium || null,
    revision: input.revision,
  });
  if (provider === "openai") {
    const result = await generateOpenAIImage({
      prompt: finalPrompt,
      aspect: input.slot.aspectRatio,
      quality: "medium",
      operation: "openai.images.landing_page",
      signal: input.signal,
    });
    return {
      dataUri: `data:${result.mime};base64,${result.buffer.toString("base64")}`,
      provider,
      model: result.model,
      taskId: null,
      finalPrompt,
    };
  }
  const result = await generateGptImage2({
    promptText: finalPrompt,
    ratio: asRatio(input.slot.aspectRatio),
    quality: "medium",
    competitorId: input.competitorId,
    imageId: input.slot.id,
  });
  return { dataUri: `data:image/png;base64,${result.buffer.toString("base64")}`, provider, model: "gpt_image_2", taskId: result.taskId, finalPrompt };
}

function imageRecord(
  slot: UnifiedImageSlot,
  state: GeneratedLandingImage["slotState"],
  publicUrl = "",
  taskId: string | null = null,
  made: { provider: string; model: string } | null = null,
): GeneratedLandingImage {
  const now = new Date().toISOString();
  return {
    id: slot.id,
    label: slot.purpose,
    kind: /hero|background/i.test(slot.purpose) ? "hero" : "content",
    prompt: slot.prompt,
    ratio: slot.aspectRatio,
    publicUrl,
    runwayTaskId: taskId,
    width: slot.width || null,
    height: slot.height || null,
    createdAt: now,
    updatedAt: now,
    slotState: state,
    medium: slot.medium || null,
    provider: made?.provider || imageProvider() || "none",
    model: made?.model || (imageProvider() === "openai" ? OPENAI_IMAGE_MODEL : "gpt_image_2"),
  };
}

const IMAGE_CONCURRENCY = 3;

function isCreditFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not enough credits|not have enough credits|insufficient credits|no remaining credits/i.test(message) || isOpenAIQuotaError(err);
}

/** Generate illustrative slots. Factual slots are never invented. Placeholders preserve layout when credits run out. */
export async function executeImageSlots(input: {
  html: string;
  slots: UnifiedImageSlot[];
  colors: BrandColors;
  competitorId: string;
  previous?: GeneratedLandingImage[];
  /** Who the page is for: used to write each image prompt. */
  context?: ImageContext;
  /** Briefs of images already on the page, so new ones do not repeat them. */
  existingBriefs?: string[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, note: string) => void;
}): Promise<{ html: string; report: UnifiedImageReport }> {
  const context: ImageContext = { ...(input.context || {}), colors: input.context?.colors || input.colors };
  const surroundings = readSlotSurroundings(input.html);
  const illustrative = [...input.slots]
    .filter((slot) => slot.kind === "illustrative")
    .sort((a, b) => a.priority - b.priority);
  const resolved = new Map<string, string>();
  const images: GeneratedLandingImage[] = [];
  let skippedCredits = 0;
  let failed = 0;
  let completed = 0;
  let placeholders = 0;
  let creditsExhausted = false;
  const total = illustrative.length;

  let done = 0;
  const results = new Array<GeneratedLandingImage | null>(illustrative.length).fill(null);
  // Art direction: plan every image that still has to be drawn, together, so
  // each one fits its own card or section and the page never repeats itself.
  const toDraw = illustrative.filter(
    (slot) => !input.previous?.some((image) => image.id === slot.id && image.prompt === slot.prompt && image.publicUrl.startsWith("data:image/")),
  );
  const briefs =
    toDraw.length && imageProvider() && !input.signal?.aborted
      ? await planImageBriefs({
          slots: toDraw,
          surroundings,
          context,
          existingBriefs: [
            ...(input.existingBriefs || []),
            ...(input.previous || []).filter((image) => image.slotState === "ready" || image.slotState === "reused").map((image) => image.prompt),
          ],
          signal: input.signal,
        })
      : new Map();
  for (let i = 0; i < illustrative.length; i += 1) {
    const planned = briefs.get(illustrative[i].id);
    if (planned) illustrative[i] = { ...illustrative[i], prompt: planned.brief, medium: planned.medium };
  }

  const runOne = async (index: number) => {
    const slot = illustrative[index];
    const cached = input.previous?.find(
      (image) => image.id === slot.id && image.prompt === slot.prompt && image.publicUrl.startsWith("data:image/"),
    );
    if (cached) {
      resolved.set(slot.id, cached.publicUrl);
      results[index] = { ...cached, slotState: "reused", reused: true, updatedAt: new Date().toISOString() };
      completed += 1;
      return;
    }
    if (creditsExhausted || !imageProvider() || input.signal?.aborted) {
      const placeholder = placeholderDataUri(slot, input.colors);
      resolved.set(slot.id, placeholder);
      results[index] = imageRecord(slot, "failed", placeholder);
      placeholders += 1;
      skippedCredits += 1;
      return;
    }
    try {
      let made = await renderLandingImage({
        slot,
        context,
        surroundings: surroundings.get(slot.id) || null,
        competitorId: input.competitorId,
        signal: input.signal,
      });
      // Check for painted text or distortions; redraw once, keep the cleaner one.
      const check = await checkLandingImage(made.dataUri, input.signal);
      if (check && !check.clean && !input.signal?.aborted) {
        try {
          const again = await renderLandingImage({
            slot,
            context,
            surroundings: surroundings.get(slot.id) || null,
            revision: redrawInstructions(check.problems),
            competitorId: input.competitorId,
            signal: input.signal,
          });
          const second = await checkLandingImage(again.dataUri, input.signal);
          if (!second || second.clean || second.problems.length <= check.problems.length) made = again;
        } catch (err) {
          if (isCreditFailure(err)) creditsExhausted = true;
        }
      }
      resolved.set(slot.id, made.dataUri);
      results[index] = imageRecord(slot, "ready", made.dataUri, made.taskId, made);
      completed += 1;
    } catch (err) {
      console.warn(`[images] ${slot.id} failed:`, err instanceof Error ? err.message.slice(0, 200) : err);
      if (isCreditFailure(err)) creditsExhausted = true;
      const placeholder = placeholderDataUri(slot, input.colors);
      resolved.set(slot.id, placeholder);
      results[index] = imageRecord(slot, "failed", placeholder);
      placeholders += 1;
      if (creditsExhausted) skippedCredits += 1;
      else failed += 1;
    } finally {
      done += 1;
      input.onProgress?.(done, total, `Image ${done} of ${total}`);
    }
  };
  // Three at a time: each image is a separate provider render.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_CONCURRENCY, illustrative.length) }, async () => {
      while (cursor < illustrative.length) {
        const index = cursor++;
        await runOne(index);
      }
    }),
  );
  images.push(...results.filter((r): r is GeneratedLandingImage => Boolean(r)));
  input.onProgress?.(total, total, placeholders ? "Page ready with image placeholders" : "Images complete");
  return {
    html: applyImageSlotsToHtml(input.html, resolved),
    report: {
      planned: total,
      completed,
      skippedCredits,
      failed,
      placeholders,
      images,
    },
  };
}

/** A src that is still a stand-in: our placeholder SVG, a 1x1 GIF, or nothing. */
function isPlaceholderSrc(src: string): boolean {
  if (!src || /^data:image\/gif/i.test(src)) return true;
  if (!/^data:image\/svg\+xml;base64,/i.test(src)) return false;
  try {
    return Buffer.from(src.slice(src.indexOf(",") + 1), "base64").toString("utf8").includes("data-adr-placeholder");
  } catch {
    return false;
  }
}

/**
 * Image slots the writer added beyond the planned ones, still showing a
 * placeholder. They get a brief from their alt text so "Generate missing
 * images" can fill them too.
 */
export function unplannedPlaceholderSlots(html: string, known: Set<string>): UnifiedImageSlot[] {
  const out: UnifiedImageSlot[] = [];
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bdata-adrival-slot="([^"]+)"/i)?.[1];
    if (!id || known.has(id) || out.some((s) => s.id === id)) continue;
    const src = tag.match(/\ssrc="([^"]*)"/i)?.[1] || "";
    if (!isPlaceholderSrc(src)) continue;
    const alt = (tag.match(/\balt="([^"]*)"/i)?.[1] || "").trim();
    out.push({
      id,
      sectionId: id,
      purpose: alt || "Supporting image for this section",
      prompt: alt ? `Photographic scene: ${alt}.` : "A realistic photograph that supports this section of the page.",
      aspectRatio: "1920:1440",
      alt,
      kind: "illustrative",
      priority: 100 + out.length,
    });
  }
  return out;
}

/** Records for unplanned slots left as placeholders, so the page lists them as missing. */
export function placeholderRecords(slots: UnifiedImageSlot[]): GeneratedLandingImage[] {
  return slots.map((slot) => imageRecord(slot, "failed"));
}
