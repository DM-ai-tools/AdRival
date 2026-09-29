import type { BrandColors, GeneratedLandingImage } from "../../types";
import { generateGptImage2, hasRunwayKey, type GptImage2Ratio } from "../../runway/client";
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

function imageRecord(
  slot: UnifiedImageSlot,
  state: GeneratedLandingImage["slotState"],
  publicUrl = "",
  taskId: string | null = null,
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
    provider: "runway",
    model: "gpt_image_2",
  };
}

const IMAGE_CONCURRENCY = 3;

function isCreditFailure(message: string): boolean {
  return /not enough credits|not have enough credits|insufficient credits|no remaining credits/i.test(message);
}

/** Generate illustrative slots. Factual slots are never invented. Placeholders preserve layout when credits run out. */
export async function executeImageSlots(input: {
  html: string;
  slots: UnifiedImageSlot[];
  colors: BrandColors;
  competitorId: string;
  previous?: GeneratedLandingImage[];
  onProgress?: (done: number, total: number, note: string) => void;
}): Promise<{ html: string; report: UnifiedImageReport }> {
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
    if (creditsExhausted || !hasRunwayKey()) {
      const placeholder = placeholderDataUri(slot, input.colors);
      resolved.set(slot.id, placeholder);
      results[index] = imageRecord(slot, "failed", placeholder);
      placeholders += 1;
      skippedCredits += 1;
      return;
    }
    try {
      const brandHint = `Brand palette primary ${input.colors.primary}, secondary ${input.colors.secondary}, accent ${input.colors.accent}. No text, logos, watermarks, or readable words in the image.`;
      const result = await generateGptImage2({
        promptText: `${slot.prompt}

${brandHint}`,
        ratio: asRatio(slot.aspectRatio),
        quality: "medium",
        competitorId: input.competitorId,
        imageId: slot.id,
      });
      const src = `data:image/png;base64,${result.buffer.toString("base64")}`;
      resolved.set(slot.id, src);
      results[index] = imageRecord(slot, "ready", src, result.taskId);
      completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCreditFailure(message)) creditsExhausted = true;
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
