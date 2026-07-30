import fs from "fs";
import path from "path";
import RunwayML, { TaskFailedError } from "@runwayml/sdk";

export type GptImage2Ratio =
  | "2048:880"
  | "1920:1088"
  | "1920:1280"
  | "1920:1440"
  | "1920:1536"
  | "1920:1920"
  | "1536:1920"
  | "1440:1920"
  | "1280:1920"
  | "1088:1920"
  | "auto";

export type RunwayImageResult = {
  taskId: string;
  outputUrl: string;
  localPath: string;
  publicUrl: string;
  buffer: Buffer;
};

export function hasRunwayKey(): boolean {
  return Boolean(process.env.RUNWAYML_API_SECRET?.trim());
}

export function getAppOrigin(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (process.env.VERCEL_URL?.trim()) {
    return `https://${process.env.VERCEL_URL.trim().replace(/\/$/, "")}`;
  }
  return "http://localhost:3000";
}

function getClient(): RunwayML {
  const apiKey = process.env.RUNWAYML_API_SECRET?.trim();
  if (!apiKey) {
    throw new Error("RUNWAYML_API_SECRET is not set");
  }
  return new RunwayML({ apiKey });
}

/**
 * Map a slot's pixel aspect toward the nearest 1K-tier GPT Image 2 ratio.
 * Falls back to `auto` when dimensions are unknown.
 */
export function pickGptImage2Ratio(
  width?: number | null,
  height?: number | null,
): GptImage2Ratio {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (w <= 0 || h <= 0) return "auto";
  const r = w / h;
  if (r >= 1.9) return "2048:880";
  if (r >= 1.55) return "1920:1088";
  if (r >= 1.35) return "1920:1280";
  if (r >= 1.15) return "1920:1440";
  if (r >= 0.95) return "1920:1920";
  if (r >= 0.8) return "1536:1920";
  if (r >= 0.65) return "1440:1920";
  if (r >= 0.5) return "1280:1920";
  return "1088:1920";
}

/**
 * Generate one image with GPT Image 2 and persist it under public/generated.
 * @see https://docs.dev.runwayml.com/api/#tag/Start-generating/paths/~1v1~1text_to_image/post
 */
export async function generateGptImage2(input: {
  promptText: string;
  ratio?: GptImage2Ratio;
  quality?: "low" | "medium" | "high" | "auto";
  referenceImageUri?: string | null;
  competitorId: string;
  imageId: string;
}): Promise<RunwayImageResult> {
  const client = getClient();
  const promptText = input.promptText.trim().slice(0, 32000);
  if (!promptText) throw new Error("promptText is required");

  const referenceImages =
    input.referenceImageUri &&
    (input.referenceImageUri.startsWith("http") ||
      input.referenceImageUri.startsWith("data:image/")) &&
    input.referenceImageUri.length < 5_500_000
      ? [{ uri: input.referenceImageUri, tag: "compimg" as const }]
      : undefined;

  try {
    const task = await client.textToImage
      .create({
        model: "gpt_image_2",
        promptText: referenceImages
          ? `${promptText}\n\nUse @compimg only as loose composition/layout reference — replace all subjects, branding, and identity with the described brand scene.`
          : promptText,
        ratio: input.ratio || "auto",
        quality: input.quality || "medium",
        outputCount: 1,
        background: "opaque",
        ...(referenceImages ? { referenceImages } : {}),
      })
      .waitForTaskOutput({ timeout: 5 * 60 * 1000 });

    const outputUrl = task.output?.[0];
    if (!outputUrl) {
      throw new Error("Runway returned no image output");
    }

    const res = await fetch(outputUrl);
    if (!res.ok) {
      throw new Error(`Failed to download Runway output (${res.status})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const dir = path.join(
      process.cwd(),
      "public",
      "generated",
      input.competitorId,
    );
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${input.imageId}.png`;
    const localPath = path.join(dir, filename);
    fs.writeFileSync(localPath, buffer);

    const publicUrl = `${getAppOrigin()}/generated/${encodeURIComponent(input.competitorId)}/${encodeURIComponent(filename)}?v=${Date.now()}`;

    return {
      taskId: task.id,
      outputUrl,
      localPath,
      publicUrl,
      buffer,
    };
  } catch (err) {
    if (err instanceof TaskFailedError) {
      const details = err.taskDetails as { failure?: string; failureCode?: string } | undefined;
      throw new Error(
        `Runway image generation failed: ${details?.failure || details?.failureCode || err.message}`,
      );
    }
    throw err;
  }
}
