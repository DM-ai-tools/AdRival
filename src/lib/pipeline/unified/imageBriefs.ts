import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import { IMAGE_MEDIUMS, colourName, type ImageContext, type ImageMedium, type SlotSurroundings } from "./imagePrompt";

/**
 * Art direction for all the images on a page, planned together in one short
 * call: each image gets a subject taken from its own card or section, and a
 * medium. Sibling images (cards in one grid) share a medium so the grid looks
 * designed, but never repeat a subject; across the page, "person at a laptop"
 * appears at most once.
 */

export type ImageBrief = { medium: ImageMedium; brief: string };

const SYSTEM = `You are the art director for a business landing page. You plan every image on the page together so each one is specific to what it sits next to, and the page never repeats itself.

RULES
- Each image shows what ITS card or section is about: the service, the outcome, the moment or the object that represents it. Read cardHeading and cardText first, then the section.
- Across the whole page, at most ONE image may show a person at a computer, laptop or phone. Prefer people doing the real-world part of the work (a workshop at a whiteboard, a site visit, a meeting with a customer, hands-on craft), or no people at all.
- Images in the same group (same grid of cards) share one medium, one lighting set-up and one background treatment, and each shows a clearly different subject. A good grid of services is often a set of conceptual still-life objects or 3D renders (a compass for strategy, a magnifying glass over a paper map for search, a megaphone for paid ads, a fountain pen and notebook for content, a set of building blocks for web design), each on the same brand-tinted backdrop.
- Hero and large section images are usually photographs of the client's real world: their customers, their place, their work.
- Mediums: "photo" (people or places, documentary style), "still-life" (studio photograph of objects), "3d-render" (clean modern 3D objects), "illustration" (flat vector illustration). Use "illustration" only for abstract ideas that are hard to photograph.
- Never ask for text, letters, numbers, logos, brand names, charts, dashboards, user interfaces or readable screens. Any screen is off, blank or turned away.
- No stock clichés: handshakes, pointing at graphs, headset call-centre smiles, thumbs up, lightbulb-over-head.
- Write each brief as 2-3 concrete sentences: the subject, what is happening or how the objects are arranged, the setting or backdrop.

Return ONLY JSON: { "images": [ { "id": "...", "medium": "photo" | "still-life" | "3d-render" | "illustration", "brief": "..." } ] } with one entry for every image id.`;

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

function shapeOf(aspect: string | null | undefined): string {
  const m = String(aspect || "").match(/(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/);
  const r = m ? Number(m[1]) / Number(m[2]) : 1.5;
  return r >= 1.2 ? "landscape" : r > 0.85 ? "square" : "portrait";
}

/** Plan briefs for the given slots. Returns an empty map if planning fails; callers fall back to the writer's scene. */
export async function planImageBriefs(input: {
  slots: Array<{ id: string; prompt: string; alt?: string | null; purpose?: string | null; aspectRatio?: string | null }>;
  surroundings: Map<string, SlotSurroundings>;
  context: ImageContext;
  /** Images already on the page (e.g. when filling only a few), so new ones do not repeat them. */
  existingBriefs?: string[];
  signal?: AbortSignal;
}): Promise<Map<string, ImageBrief>> {
  const out = new Map<string, ImageBrief>();
  if (!input.slots.length || !process.env.ANTHROPIC_API_KEY) return out;
  const c = input.context;
  const payload = {
    client: {
      name: c.clientName || null,
      industry: c.industry || null,
      services: c.services || [],
      location: c.location || null,
      audience: c.audience || null,
      brandColours: [colourName(c.colors?.primary), colourName(c.colors?.accent)].filter(Boolean),
    },
    alreadyOnThePage: (input.existingBriefs || []).slice(0, 12),
    images: input.slots.map((slot) => {
      const s = input.surroundings.get(slot.id);
      return {
        id: slot.id,
        shape: shapeOf(slot.aspectRatio),
        place: s?.isHero ? "hero" : s?.cardHeading ? "card in a grid" : "section",
        group: s?.group || slot.id,
        groupSize: s?.groupSize || 1,
        sectionHeading: s?.heading || null,
        sectionText: s?.text || null,
        cardHeading: s?.cardHeading || null,
        cardText: s?.cardText || null,
        writerIdea: slot.prompt.slice(0, 300),
        alt: slot.alt || slot.purpose || null,
      };
    }),
  };
  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: getAnthropicModel(),
        max_tokens: Math.min(6000, 600 + input.slots.length * 350),
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const json = extractJson(text);
    const rows = Array.isArray(json?.images) ? (json!.images as Array<Record<string, unknown>>) : [];
    for (const row of rows) {
      const id = String(row.id || "");
      const brief = String(row.brief || "").trim();
      const medium = String(row.medium || "") as ImageMedium;
      if (!id || brief.length < 20 || !input.slots.some((s) => s.id === id)) continue;
      out.set(id, { medium: (IMAGE_MEDIUMS as readonly string[]).includes(medium) ? medium : "photo", brief: brief.slice(0, 900) });
    }
  } catch (err) {
    console.warn("[images] art direction failed; using the writer's scenes", err instanceof Error ? err.message.slice(0, 160) : err);
  }
  return out;
}
