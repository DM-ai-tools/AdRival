import sharp from "sharp";
import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";

/**
 * Look at the logo candidates found on the client's website and pick the one
 * that is the business's own logo. Websites often mark screenshots, client
 * logos and partner badges as "logo"; one of those in the header is the most
 * visible mistake a rebuilt page can make.
 */

const SYSTEM = `You check logo images for a business website. You are shown numbered candidate images and the business name. Pick the image that is THIS business's own logo (wordmark, logomark or both).

Reject: screenshots of websites, shops or apps; photos; other companies' logos (clients, partners, platforms, awards, payment or social icons); generic icons; images where the logo is only a small part of a larger picture.

Return ONLY JSON: { "pick": <candidate number or null>, "onDark": true | false, "reason": "short reason" }. "onDark" is true when the logo is light-coloured and needs a dark background to be seen.`;

/** A candidate as Claude can read it: PNG for SVG, a small JPEG or PNG otherwise. */
async function toVisionImage(dataUri: string): Promise<{ media: "image/png" | "image/jpeg"; data: string } | null> {
  const m = dataUri.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  if (/icon|x-icon/.test(mime)) return null;
  try {
    const raw = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
    // Transparent logos go on a mid grey so both light and dark marks stay visible.
    const png = await sharp(raw, { density: 144 })
      .resize({ width: 480, height: 240, fit: "inside", withoutEnlargement: false })
      .flatten({ background: "#9CA3AF" })
      .png()
      .toBuffer();
    return { media: "image/png", data: png.toString("base64") };
  } catch {
    return null;
  }
}

export type LogoPick = { index: number | null; onDark: boolean; reason: string };

/**
 * Returns the index of the business's own logo among `candidates` (data URIs),
 * null when none of them is, or undefined when the check could not run.
 */
export async function pickBrandLogo(input: {
  candidates: string[];
  businessName: string;
  businessUrl: string;
  signal?: AbortSignal;
}): Promise<LogoPick | undefined> {
  if (!process.env.ANTHROPIC_API_KEY || !input.candidates.length) return undefined;
  const images = await Promise.all(input.candidates.slice(0, 6).map(toVisionImage));
  const content: Array<Record<string, unknown>> = [];
  const shown: number[] = [];
  images.forEach((image, i) => {
    if (!image) return;
    shown.push(i);
    content.push({ type: "text", text: `Candidate ${shown.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: image.media, data: image.data } });
  });
  if (!shown.length) return undefined;
  content.push({ type: "text", text: `Business: ${input.businessName} (${input.businessUrl}). Which candidate is its own logo?` });
  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: getAnthropicModel(),
        max_tokens: 300,
        system: SYSTEM,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: content as any }],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { pick?: unknown; onDark?: unknown; reason?: unknown };
    const pick = typeof json.pick === "number" && json.pick >= 1 && json.pick <= shown.length ? shown[json.pick - 1] : null;
    return { index: pick, onDark: Boolean(json.onDark), reason: String(json.reason || "").slice(0, 200) };
  } catch (err) {
    console.warn("[logo] check failed", err instanceof Error ? err.message.slice(0, 160) : err);
    return undefined;
  }
}
