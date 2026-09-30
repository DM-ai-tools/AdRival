import * as cheerio from "cheerio";

/**
 * Prompts for landing-page photographs, written the way OpenAI's image guide
 * recommends: say what the image is for, describe the scene concretely, give
 * composition, lighting and style, then list what must not appear. One shared
 * art direction keeps every image on the page looking like one shoot.
 */

export type ImageContext = {
  clientName?: string | null;
  industry?: string | null;
  services?: string[];
  location?: string | null;
  audience?: string | null;
  colors?: { primary?: string | null; secondary?: string | null; accent?: string | null } | null;
};

export type SlotSurroundings = {
  heading: string | null;
  text: string | null;
  isHero: boolean;
  /** The image sits behind text (hero or background band). */
  behindText: boolean;
};

const clip = (t: string | null | undefined, n: number) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** What the section around each slot says, read from the page itself. */
export function readSlotSurroundings(html: string): Map<string, SlotSurroundings> {
  const out = new Map<string, SlotSurroundings>();
  if (!html) return out;
  const $ = cheerio.load(html);
  const firstSection = $("main section, body section").first();
  $("img[data-adrival-slot]").each((_, el) => {
    const img = $(el);
    const id = img.attr("data-adrival-slot");
    if (!id) return;
    const section = img.closest("section");
    const scope = section.length ? section : img.parent();
    const heading = scope.find("h1, h2, h3").first().text() || null;
    const text = scope.find("p").first().text() || null;
    const isHero = section.length > 0 && section.is(firstSection);
    const cls = `${img.attr("class") || ""} ${img.parent().attr("class") || ""}`;
    const behindText = /background|backdrop|cover|bg/i.test(cls) || (isHero && !img.closest(".adr-split, .adr-media, .adr-card").length);
    out.set(id, { heading: clip(heading, 140) || null, text: clip(text, 260) || null, isHero, behindText });
  });
  return out;
}

/** A plain colour name for a hex, so the prompt never shows hex codes the model might paint as text. */
export function colourName(hex: string | null | undefined): string | null {
  const m = String(hex || "").replace("#", "").match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.12) return l > 0.85 ? "white" : l < 0.18 ? "near-black" : l < 0.5 ? "charcoal grey" : "light grey";
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  const tone = l < 0.25 ? "deep " : l > 0.72 ? "pale " : "";
  const name =
    h < 15 || h >= 345 ? "red" :
    h < 40 ? "orange" :
    h < 65 ? "yellow" :
    h < 100 ? "lime green" :
    h < 160 ? "green" :
    h < 190 ? "teal" :
    h < 215 ? "sky blue" :
    h < 250 ? "blue" :
    h < 285 ? "violet" :
    h < 320 ? "purple" : "pink";
  return `${tone}${name}`;
}

function orientation(aspect: string | null | undefined): string {
  const m = String(aspect || "").match(/(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/);
  const r = m ? Number(m[1]) / Number(m[2]) : 1.5;
  if (r >= 2) return "wide panoramic landscape";
  if (r >= 1.2) return "landscape";
  if (r > 0.85) return "square";
  return "portrait";
}

/** The art direction every image on the page shares. */
export function artDirection(context: ImageContext): string {
  const accents = [colourName(context.colors?.primary), colourName(context.colors?.accent)]
    .filter((c, i, a): c is string => Boolean(c) && a.indexOf(c) === i)
    .join(" and ");
  return [
    "Editorial commercial photography, shot on a full-frame camera with a 35mm or 50mm lens",
    "soft natural daylight, gentle contrast, true-to-life colours and realistic skin and material textures",
    accents ? `small, natural touches of ${accents} in props, clothing or the environment (do not tint the whole image)` : null,
    "clean, uncluttered backgrounds with a modern, premium, trustworthy feel",
  ]
    .filter(Boolean)
    .join("; ");
}

export function buildImagePrompt(input: {
  scene: string;
  purpose?: string | null;
  alt?: string | null;
  aspect?: string | null;
  context: ImageContext;
  surroundings?: SlotSurroundings | null;
  revision?: string | null;
}): string {
  const c = input.context;
  const where = input.surroundings;
  const business = [
    c.industry
      ? /\b(business|agency|company|firm|practice|clinic|studio|store|shop|service|services)$/i.test(c.industry.trim())
        ? `a ${c.industry.trim().toLowerCase()}`
        : `a ${c.industry.trim().toLowerCase()} business`
      : "a professional services business",
    c.clientName ? `called ${c.clientName}` : null,
    c.services?.length ? `offering ${c.services.slice(0, 4).join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const lines = [
    `A photograph for the website of ${business}.`,
    input.purpose ? `Where it appears: ${clip(input.purpose, 160)}.` : null,
    // The section's words are context only: quoted headings get painted onto screens.
    where?.heading || where?.text
      ? `Context only (never write these words anywhere in the image): the section is about ${[where?.heading, where?.text].filter(Boolean).join(". ").toLowerCase()}`
      : null,
    `Scene: ${clip(input.scene, 900)}`,
    c.location ? `Setting: ${c.location}, so architecture, light and people fit that place.` : null,
    c.audience ? `The people shown should feel like the business's customers or team: ${clip(c.audience, 160)}.` : null,
    `Composition: ${orientation(input.aspect)} frame. ${
      where?.behindText
        ? "The image sits behind a headline, so keep the main subject to one side and leave a calm, low-detail area for text."
        : "One clear subject with a simple background, framed so it still reads when cropped slightly."
    }${where?.isHero ? " This is the first image visitors see: make it confident and inviting." : ""}`,
    `Style: ${artDirection(c)}.`,
    input.revision ? `Changes requested for this version: ${clip(input.revision, 600)}` : null,
    "Screens, documents and whiteboards are blank, softly out of focus or turned away from the camera.",
    "Do not include: any text, letters, numbers, logos, brand names, watermarks, signage with words, screens showing readable content, or charts; no competitor branding; no stock-photo clichés (handshakes, pointing at graphs, headset call-centre smiles, thumbs up); no distorted hands or faces.",
  ];
  return lines.filter(Boolean).join("\n");
}

/** Image context from the client's business profile. */
export function imageContextFromProfile(
  profile: {
    businessName?: string | null;
    industry?: string | null;
    subIndustry?: string | null;
    offerings?: string[] | null;
    targetAudience?: string | null;
    locations?: Array<{ label?: string | null; city?: string | null; region?: string | null; isPrimary?: boolean }> | null;
  } | null | undefined,
  extra: { clientName?: string | null; colors?: ImageContext["colors"] } = {},
): ImageContext {
  const primary = profile?.locations?.find((l) => l.isPrimary) || profile?.locations?.[0] || null;
  const location = primary ? [primary.city || primary.label, primary.region].filter(Boolean).join(", ") : null;
  return {
    clientName: extra.clientName || profile?.businessName || null,
    industry: profile?.subIndustry || profile?.industry || null,
    services: (profile?.offerings || []).slice(0, 6),
    location: location || null,
    audience: profile?.targetAudience || null,
    colors: extra.colors || null,
  };
}
