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

  for (let index = 0; index < illustrative.length; index += 1) {
    const slot = illustrative[index];
    input.onProgress?.(index, total, `Image ${index + 1} of ${total}`);
    const cached = input.previous?.find(
      (image) => image.id === slot.id && image.prompt === slot.prompt && image.publicUrl.startsWith("data:image/"),
    );
    if (cached) {
      resolved.set(slot.id, cached.publicUrl);
      images.push({ ...cached, slotState: "reused", reused: true, updatedAt: new Date().toISOString() });
      completed += 1;
      continue;
    }
    if (creditsExhausted || !hasRunwayKey()) {
      const placeholder = placeholderDataUri(slot);
      resolved.set(slot.id, placeholder);
      images.push(imageRecord(slot, "failed", placeholder));
      placeholders += 1;
      skippedCredits += 1;
      continue;
    }
    try {
      const brandHint = `Brand palette primary ${input.colors.primary}, secondary ${input.colors.secondary}, accent ${input.colors.accent}. No text, logos, watermarks, or readable words in the image.`;
      const result = await generateGptImage2({
        promptText: `${slot.prompt}\n\n${brandHint}`,
        ratio: asRatio(slot.aspectRatio),
        quality: "medium",
        competitorId: input.competitorId,
        imageId: slot.id,
      });
      const src = `data:image/png;base64,${result.buffer.toString("base64")}`;
      resolved.set(slot.id, src);
      images.push(imageRecord(slot, "ready", src, result.taskId));
      completed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isCreditFailure(message)) creditsExhausted = true;
      const placeholder = placeholderDataUri(slot);
      resolved.set(slot.id, placeholder);
      images.push(imageRecord(slot, "failed", placeholder));
      placeholders += 1;
      if (creditsExhausted) skippedCredits += 1;
      else failed += 1;
    }
  }
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
