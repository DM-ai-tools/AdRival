import sharp from "sharp";
import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";

/**
 * Look at a generated image before it goes on the page. Image models still
 * paint words (often garbled) onto labels, screens and floating cards, and
 * sometimes distort hands and faces. A flagged image is drawn once more with
 * the problems named.
 */

const SYSTEM = `You check AI-generated photos before they go on a business website. Look closely, including small areas, screens, signs, clothing, papers and any floating labels or cards.

Report:
- "text": any visible writing: words, letters, numbers, labels, tags, chips, badges, captions, logos, watermarks, readable or garbled pseudo-text, app or website screens with content.
- "defects": distorted or extra fingers, hands or limbs, warped faces, melted or impossible objects, obvious AI artefacts.

Return ONLY JSON: { "text": true | false, "defects": true | false, "problems": ["short, specific description of each problem and where it is"] }`;

export type ImageCheck = { clean: boolean; problems: string[] };

/** Returns null when the check could not run (the image is then used as is). */
export async function checkLandingImage(dataUri: string, signal?: AbortSignal): Promise<ImageCheck | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const m = dataUri.match(/^data:image\/[a-z+.-]+;base64,(.+)$/i);
  if (!m) return null;
  try {
    const small = await sharp(Buffer.from(m[1], "base64"))
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const response = await getAnthropicClient().messages.create(
      {
        model: getAnthropicModel(),
        max_tokens: 400,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: small.toString("base64") } },
              { type: "text", text: "Check this image." },
            ],
          },
        ],
      },
      { timeout: 90_000, ...(signal ? { signal } : {}) },
    );
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { text?: unknown; defects?: unknown; problems?: unknown };
    const problems = Array.isArray(json.problems) ? json.problems.map(String).filter(Boolean).slice(0, 6) : [];
    const flagged = Boolean(json.text) || Boolean(json.defects);
    return { clean: !flagged, problems: flagged && !problems.length ? ["visible text or defects"] : problems };
  } catch (err) {
    console.warn("[images] check failed", err instanceof Error ? err.message.slice(0, 160) : err);
    return null;
  }
}

/** Instructions for the second attempt, naming what was wrong with the first. */
export function redrawInstructions(problems: string[]): string {
  return `The previous version had these problems: ${problems.join("; ")}. Draw the scene again with absolutely no writing anywhere (no labels, chips, cards, screens with content, signs or logos) and natural, correct anatomy.`;
}
