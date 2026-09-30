import * as cheerio from "cheerio";

/**
 * Prompts for landing-page images, written the way OpenAI's image guide
 * recommends: say what the image is for, describe the subject concretely,
 * give composition, medium and style, then list what must not appear. The
 * subject and medium of each image come from the page's art direction
 * (imageBriefs.ts); the style for each medium is shared across the page.
 */

/** photo: people or places; still-life: studio shot of objects; 3d-render; illustration. */
export const IMAGE_MEDIUMS = ["photo", "still-life", "3d-render", "illustration"] as const;
export type ImageMedium = (typeof IMAGE_MEDIUMS)[number];

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
  /** The card the image sits in, when it is one of several cards. */
  cardHeading?: string | null;
  cardText?: string | null;
  /** Images that sit side by side (one grid of cards) share a group. */
  group?: string;
  groupSize?: number;
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
    // The card the image belongs to: the nearest wrapper below the section
    // that has its own heading (a card, list item or column).
    let card: ReturnType<typeof $> | null = null;
    for (let node = img.parent(); node.length && !node.is("section, main, body"); node = node.parent()) {
      if (node.find("h2, h3, h4, h5").length) {
        card = node;
        break;
      }
    }
    const inCard = Boolean(card && section.length && !card.is(section) && card.find("img[data-adrival-slot]").length === 1);
    const cardHeading = inCard ? card!.find("h2, h3, h4, h5").first().text() : null;
    const cardText = inCard ? card!.find("p").first().text() : null;
    // Siblings: the other slot images in the same parent grid.
    const grid = inCard ? card!.parent() : null;
    const groupSize = grid ? grid.find("img[data-adrival-slot]").length : 1;
    const sectionId = section.attr("data-section-id") || section.attr("id") || "page";
    out.set(id, {
      heading: clip(heading, 140) || null,
      text: clip(text, 260) || null,
      cardHeading: clip(cardHeading, 120) || null,
      cardText: clip(cardText, 260) || null,
      group: groupSize > 1 ? `${sectionId}-grid` : id,
      groupSize,
      isHero,
      behindText,
    });
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

/** The style for a medium, shared by every image of that medium on the page. */
export function artDirection(context: ImageContext, medium: ImageMedium = "photo"): string {
  const colours = [colourName(context.colors?.primary), colourName(context.colors?.accent)].filter(
    (c, i, a): c is string => Boolean(c) && a.indexOf(c) === i,
  );
  const accents = colours.join(" and ");
  const main = colours[0] || "neutral";
  switch (medium) {
    case "still-life":
      return [
        "Studio still-life photography: the objects arranged with intent on a seamless backdrop",
        `backdrop a soft, desaturated tint of ${main}${colours[1] ? `, with ${colours[1]} as a small accent object or detail` : ""}`,
        "soft directional key light with gentle shadows, shallow depth of field, crisp material detail",
        "minimal, premium, modern; plenty of empty space around the subject",
      ].join("; ");
    case "3d-render":
      return [
        "Clean modern 3D render: soft studio lighting, smooth matte and frosted-glass materials, subtle ambient occlusion",
        `a colour palette built from ${accents || "calm neutrals"} with soft neutrals, on a plain gradient backdrop in a muted tint of ${main}`,
        "simple, friendly forms, one clear focal object, generous empty space; premium product-design look, not cartoonish",
      ].join("; ");
    case "illustration":
      return [
        "Modern flat vector illustration with a few simple shapes and soft grain",
        `limited palette of ${accents || "two calm colours"} with warm neutrals, on a plain light background`,
        "clear focal subject, friendly and professional, no outlines-heavy clip-art look",
      ].join("; ");
    default:
      return [
        "Editorial documentary photography, shot on a full-frame camera with a 35mm or 50mm lens",
        "soft natural light, gentle contrast, true-to-life colours and realistic skin and material textures",
        accents ? `small, natural touches of ${accents} in props, clothing or the environment (do not tint the whole image)` : null,
        "real, candid moments rather than posed smiles; clean, uncluttered backgrounds",
      ]
        .filter(Boolean)
        .join("; ");
  }
}

export function buildImagePrompt(input: {
  scene: string;
  purpose?: string | null;
  alt?: string | null;
  aspect?: string | null;
  context: ImageContext;
  surroundings?: SlotSurroundings | null;
  medium?: ImageMedium | null;
  revision?: string | null;
}): string {
  const c = input.context;
  const where = input.surroundings;
  const medium: ImageMedium = input.medium || "photo";
  const kind =
    medium === "still-life" ? "A studio still-life photograph" : medium === "3d-render" ? "A 3D render" : medium === "illustration" ? "An illustration" : "A photograph";
  const peopleMedium = medium === "photo";
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
    `${kind} for the website of ${business}.`,
    input.purpose ? `Where it appears: ${clip(input.purpose, 160)}.` : null,
    // The page's words are context only: quoted headings get painted onto screens.
    where?.cardHeading || where?.heading || where?.text
      ? `Context only (never write these words anywhere in the image): ${
          where?.cardHeading ? `it illustrates ${[where.cardHeading, where.cardText].filter(Boolean).join(": ").toLowerCase()}, in a section about ` : "the section is about "
        }${[where?.heading, where?.cardHeading ? null : where?.text].filter(Boolean).join(". ").toLowerCase()}`
      : null,
    `Subject: ${clip(input.scene, 900)}`,
    peopleMedium && c.location ? `Setting: ${c.location}, so architecture, light and people fit that place.` : null,
    peopleMedium && c.audience ? `Any people shown should feel like the business's customers or team: ${clip(c.audience, 160)}.` : null,
    `Composition: ${orientation(input.aspect)} frame. ${
      where?.behindText
        ? "The image sits behind a headline, so keep the main subject to one side and leave a calm, low-detail area for text."
        : "One clear subject with a simple background, framed so it still reads when cropped slightly."
    }${where?.isHero ? " This is the first image visitors see: make it confident and inviting." : ""}`,
    `Style: ${artDirection(c, medium)}.`,
    input.revision ? `Changes requested for this version: ${clip(input.revision, 600)}` : null,
    "Screens, documents and whiteboards are blank, softly out of focus or turned away from the camera.",
    where?.groupSize && where.groupSize > 1
      ? "It sits in a row of cards with matching images, so keep the subject centred, similar in scale and on the same kind of background."
      : null,
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
