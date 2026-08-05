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

const MAX_REF_CHARS = 5_500_000;

/** Runway GPT Image 2 rejects SVG references (image/svg+xml). */
function isSvgUri(uri: string): boolean {
  const u = uri.trim().toLowerCase();
  if (!u) return false;
  if (u.startsWith("data:image/svg")) return true;
  if (/^data:image\/svg\+xml/i.test(uri)) return true;
  if (/\.svg(\?|#|$)/i.test(u)) return true;
  // base64 SVG data URIs sometimes omit the mime subtype clearly
  if (u.startsWith("data:") && /<svg|%3csvg/i.test(uri.slice(0, 400))) return true;
  return false;
}

/**
 * Accept only raster image URIs Runway can use as referenceImages.
 * SVG / empty / oversized → null (generate without that reference).
 */
export function usableRefUri(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const u = uri.trim();
  if (!u) return null;
  if (isSvgUri(u)) return null;
  if (u.startsWith("data:image/") && u.length < MAX_REF_CHARS) {
    // Only common raster mime types
    if (!/^data:image\/(png|jpe?g|webp|gif|avif|bmp)/i.test(u)) return null;
    return u;
  }
  if (u.startsWith("http") && u.length < MAX_REF_CHARS) {
    // Don't send bare .svg HTTP URLs — Runway fetches and rejects them
    if (/\.svg(\?|#|$)/i.test(u)) return null;
    return u;
  }
  return null;
}

/**
 * Fetch a remote logo into a data URI so Runway can always read it
 * (avoids localhost / auth / hotlink failures).
 * Returns null for SVG logos — Runway cannot use SVG as referenceImages.
 */
export async function logoUrlToReferenceUri(
  logoUrl: string | null | undefined,
): Promise<string | null> {
  const raw = (logoUrl || "").trim();
  if (!raw) return null;
  if (isSvgUri(raw)) return null;
  if (raw.startsWith("data:image/")) {
    return usableRefUri(raw);
  }
  if (!/^https?:\/\//i.test(raw)) return null;
  try {
    const res = await fetch(raw, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; AdRival/1.0; +https://adrival.app)",
        accept: "image/png,image/jpeg,image/webp,image/*,*/*",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || buf.length > 4_500_000) return null;
    let mime = (res.headers.get("content-type") || "").split(";")[0].trim();
    const head = buf.toString("utf8", 0, 240);
    if (/svg/i.test(mime) || /<svg/i.test(head) || /\.svg(\?|#|$)/i.test(raw)) {
      // SVG cannot be a Runway reference — skip rather than 400 the whole slot
      return null;
    }
    if (!/^image\//i.test(mime)) {
      if (/\.jpe?g(\?|#|$)/i.test(raw)) mime = "image/jpeg";
      else if (/\.webp(\?|#|$)/i.test(raw)) mime = "image/webp";
      else if (/\.gif(\?|#|$)/i.test(raw)) mime = "image/gif";
      else mime = "image/png";
    }
    if (!/^image\/(png|jpe?g|webp|gif|avif|bmp)/i.test(mime)) return null;
    const dataUri = `data:${mime};base64,${buf.toString("base64")}`;
    return dataUri.length < MAX_REF_CHARS ? dataUri : null;
  } catch {
    return null;
  }
}

/**
 * Generate one image with GPT Image 2 and persist it under public/generated.
 * @see https://docs.dev.runwayml.com/api/#tag/Start-generating/paths/~1v1~1text_to_image/post
 */
export async function generateGptImage2(input: {
  promptText: string;
  ratio?: GptImage2Ratio;
  quality?: "low" | "medium" | "high" | "auto";
  /** Competitor/layout composition reference */
  referenceImageUri?: string | null;
  /** Brand logo — reproduced exactly when signage/branding appears */
  logoReferenceUri?: string | null;
  competitorId: string;
  imageId: string;
}): Promise<RunwayImageResult> {
  const client = getClient();
  const promptText = input.promptText.trim().slice(0, 32000);
  if (!promptText) throw new Error("promptText is required");

  // Never pass SVG (or other unsupported) URIs — Runway 400s the whole request
  const logoUri = usableRefUri(input.logoReferenceUri);
  const compUri = usableRefUri(input.referenceImageUri);

  const referenceImages: Array<{ uri: string; tag: string }> = [];
  if (logoUri) referenceImages.push({ uri: logoUri, tag: "brandlogo" });
  if (compUri && compUri !== logoUri) {
    referenceImages.push({ uri: compUri, tag: "compimg" });
  }

  const promptParts = [promptText];
  if (logoUri) {
    promptParts.push(
      "BRAND LOGO: Use @brandlogo as the EXACT company logo whenever any logo, wordmark, or wall signage appears. Reproduce its geometry, colors, and lettering faithfully. Do not invent a different logo, do not alter the wordmark, and do not use competitor branding.",
    );
  } else {
    promptParts.push(
      "Do not invent company logos or wordmarks. No watermarks, no fake UI chrome.",
    );
  }
  if (compUri) {
    promptParts.push(
      "Use @compimg only as loose composition/layout reference — replace people, scene, and any competitor branding with the described brand scene.",
    );
  }

  const promptFinal = promptParts.join("\n\n").slice(0, 32000);
  const basePayload = {
    model: "gpt_image_2" as const,
    promptText: promptFinal,
    ratio: input.ratio || "auto",
    quality: input.quality || "medium",
    outputCount: 1,
    background: "opaque" as const,
  };

  async function runCreate(refs: Array<{ uri: string; tag: string }>) {
    return client.textToImage
      .create({
        ...basePayload,
        ...(refs.length ? { referenceImages: refs as any } : {}),
      })
      .waitForTaskOutput({ timeout: 5 * 60 * 1000 });
  }

  try {
    let task;
    try {
      task = await runCreate(referenceImages);
    } catch (firstErr) {
      const msg =
        firstErr instanceof Error ? firstErr.message : String(firstErr);
      // Bad reference (SVG/mime) → retry once with no references so slots still generate
      if (
        referenceImages.length &&
        /Unsupported Content-Type|referenceImages|Validation of body failed|svg\+xml/i.test(
          msg,
        )
      ) {
        console.warn(
          "[runway] referenceImages rejected — retrying without refs",
          msg.slice(0, 180),
        );
        task = await runCreate([]);
      } else {
        throw firstErr;
      }
    }

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
