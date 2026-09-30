import OpenAI from "openai";
import { meterProviderCall, type ReportedUsage } from "@/lib/accounting/meter";
import { USD_MICROS } from "@/lib/accounting/units";

/**
 * Images from OpenAI's Image API (POST /v1/images/generations) with GPT Image 2.
 *
 * Model: `gpt-image-2` (override with OPENAI_IMAGE_MODEL). Sizes: any
 * width x height with both sides multiples of 16, longest side at most 3840,
 * aspect ratio at most 3:1 and 655,360 to 8,294,400 pixels in total; the
 * classic 1024x1024, 1536x1024 and 1024x1536 always work. The response
 * carries the image as base64 (data[0].b64_json) plus token usage.
 *
 * @see https://developers.openai.com/api/docs/models/gpt-image-2
 * @see https://developers.openai.com/api/docs/guides/image-generation
 */

export const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL?.trim() || "gpt-image-2";

/** List prices for gpt-image-2, USD per 1M tokens (OpenAI pricing page). */
const GPT_IMAGE_2_PRICE = { textInput: 5, imageInput: 8, imageOutput: 30 };

export function hasOpenAIImageKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

let client: OpenAI | null = null;

function imagesClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  // Renders take 20 seconds to a couple of minutes; retry network blips once.
  client ||= new OpenAI({ apiKey, timeout: 240_000, maxRetries: 1 });
  return client;
}

const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
/** About 1.6 megapixels: sharp on a laptop screen, quick and inexpensive to render. */
const TARGET_PIXELS = 1536 * 1024;
const MAX_EDGE = 2048;

const round16 = (n: number) => Math.max(16, Math.round(n / 16) * 16);

/**
 * A size for the slot's aspect ratio ("1920:1280", "16:9" or 1.5), inside
 * GPT Image 2's limits: sides in multiples of 16, ratio at most 3:1.
 */
export function imageSizeFor(aspect: string | number | null | undefined): { width: number; height: number } {
  let ratio = 1.5;
  if (typeof aspect === "number" && Number.isFinite(aspect) && aspect > 0) ratio = aspect;
  else if (typeof aspect === "string") {
    const m = aspect.match(/(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/i);
    if (m && Number(m[2]) > 0) ratio = Number(m[1]) / Number(m[2]);
  }
  ratio = Math.min(3, Math.max(1 / 3, ratio));
  let width = round16(Math.sqrt(TARGET_PIXELS * ratio));
  let height = round16(width / ratio);
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  width = round16(width * scale);
  height = round16(height * scale);
  while (width * height < MIN_PIXELS) {
    width += 16;
    height = round16(width / ratio);
  }
  while (width * height > MAX_PIXELS) {
    width -= 16;
    height = round16(width / ratio);
  }
  // Rounding to 16 can nudge an extreme shape just past 3:1.
  while (width / height > 3) height += 16;
  while (height / width > 3) width += 16;
  return { width, height };
}

/** The always-supported size closest to a ratio, for a retry if a custom size is refused. */
function presetFor(ratio: number): "1536x1024" | "1024x1536" | "1024x1024" {
  if (ratio >= 1.2) return "1536x1024";
  if (ratio <= 0.83) return "1024x1536";
  return "1024x1024";
}

type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
};

function extractImageUsage(model: string) {
  return (result: OpenAI.Images.ImagesResponse): ReportedUsage => {
    const usage = (result as { usage?: ImageUsage }).usage;
    const text = usage?.input_tokens_details?.text_tokens ?? usage?.input_tokens ?? 0;
    const imageIn = usage?.input_tokens_details?.image_tokens ?? 0;
    const out = usage?.output_tokens ?? 0;
    const cost =
      /^gpt-image-2(?!\.)/.test(model) && usage
        ? Math.round(
            ((text * GPT_IMAGE_2_PRICE.textInput + imageIn * GPT_IMAGE_2_PRICE.imageInput + out * GPT_IMAGE_2_PRICE.imageOutput) /
              1_000_000) *
              USD_MICROS,
          )
        : null;
    return {
      usage: {
        requests: 1,
        images: result.data?.length || 1,
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
      providerRequestId: null,
      reportedCostUsdMicros: cost,
    };
  };
}

export type OpenAIImageResult = {
  /** JPEG bytes. */
  buffer: Buffer;
  mime: "image/jpeg";
  width: number;
  height: number;
  model: string;
};

/** A refused size, as opposed to a refused prompt or a billing problem. */
function isSizeError(err: unknown): boolean {
  return err instanceof OpenAI.BadRequestError && /size/i.test(err.message);
}

/**
 * Render one image. Throws OpenAI's typed errors (e.g. RateLimitError for a
 * spent quota, BadRequestError for a refused prompt); callers decide whether
 * to fall back to a placeholder.
 */
export async function generateOpenAIImage(input: {
  prompt: string;
  aspect?: string | number | null;
  quality?: "low" | "medium" | "high" | "auto";
  operation?: string;
  signal?: AbortSignal;
}): Promise<OpenAIImageResult> {
  const prompt = input.prompt.trim().slice(0, 32_000);
  if (!prompt) throw new Error("An image prompt is required.");
  const model = OPENAI_IMAGE_MODEL;
  const { width, height } = imageSizeFor(input.aspect ?? null);

  const render = (size: string) =>
    meterProviderCall(
      {
        provider: "openai",
        model,
        endpoint: "/v1/images/generations",
        operation: input.operation || "openai.images.generate",
        extractUsage: extractImageUsage(model),
      },
      () =>
        imagesClient().images.generate(
          {
            model,
            prompt,
            n: 1,
            // Custom sizes are valid for GPT Image 2; the SDK's type lists only presets.
            size: size as OpenAI.Images.ImageGenerateParams["size"],
            quality: input.quality || "medium",
            output_format: "jpeg",
            output_compression: 82,
            moderation: "auto",
          },
          input.signal ? { signal: input.signal } : undefined,
        ),
    );

  let response: OpenAI.Images.ImagesResponse;
  let finalWidth = width;
  let finalHeight = height;
  try {
    response = await render(`${width}x${height}`);
  } catch (err) {
    if (!isSizeError(err)) throw err;
    const preset = presetFor(width / height);
    [finalWidth, finalHeight] = preset.split("x").map(Number);
    response = await render(preset);
  }
  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error("The image service returned no image.");
  return { buffer: Buffer.from(b64, "base64"), mime: "image/jpeg", width: finalWidth, height: finalHeight, model };
}

/** Spent quota or billing limits: stop asking for more images this run. */
export function isOpenAIQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /insufficient_quota|exceeded your current quota|billing_hard_limit|billing hard limit|account is not active/i.test(message);
}
