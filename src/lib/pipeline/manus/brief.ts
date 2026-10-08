import type { BrandColors, BusinessProfile, LandingPageOfferAnalysis } from "../../types";
import { STYLE_DIRECTION_LABEL, styleGuide, type StyleDirection } from "../skills/playbook";
import { familiesInText } from "../offerServiceFocus";

/**
 * The brief for the design agent. It carries the same rules the built-in
 * pipeline follows (generateBlueprint.ts SYSTEM, header/form/image rules and
 * the skills/recreate playbook), written for an agent that browses, codes and
 * checks its own work instead of filling our class system.
 */

export type ManusBriefInput = {
  competitorName: string;
  competitorUrl: string;
  clientUrl: string;
  clientName: string;
  keyword: string;
  /** Every keyword the user searched with, and the category they picked. */
  searchKeywords: string[];
  selectedCategory: string | null;
  profile: BusinessProfile | null;
  brandColors: BrandColors | null;
  pageAnalysis: LandingPageOfferAnalysis | null;
  styleDirection: StyleDirection;
  userFeedback: string | null;
  /** Images the user attached that the page must use (sent with the task as files). */
  userAssets?: Array<{ name: string; caption: string }>;
};

/** The file the agent must attach. */
export const MANUS_HTML_FILENAME = "index.html";

/** Most generated photos per page. */
const IMAGE_BUDGET = 6;

/** What the agent reports back once the task finishes (Manus structured output subset). */
export const MANUS_RESULT_SCHEMA = {
  type: "object",
  properties: {
    html_filename: { type: "string", description: "File name of the attached final HTML page, e.g. index.html" },
    summary: { type: "string", description: "Two or three sentences on what was built" },
    sections: {
      type: "array",
      description: "Every competitor section, top to bottom, and how it was rebuilt",
      items: {
        type: "object",
        properties: {
          competitor_section: { type: "string" },
          rebuilt_as: { type: "string" },
          layout_matches: { type: "boolean" },
        },
        required: ["competitor_section", "rebuilt_as", "layout_matches"],
        additionalProperties: false,
      },
    },
    brand: {
      type: "object",
      properties: {
        logo_source: { type: "string", description: "Where the client's logo came from" },
        colours: { type: "array", items: { type: "string" }, description: "Hex colours used, from the client's site" },
        fonts: { type: "array", items: { type: "string" } },
        colour_map: {
          type: "array",
          description: "Each colour role on the page and the client-site element it was measured from",
          items: {
            type: "object",
            properties: {
              role: { type: "string", description: "e.g. primary button, secondary button, highlight band, header, footer, card, link, heading" },
              hex: { type: "string" },
              measured_from: { type: "string", description: "The client-site element and page it was read from" },
            },
            required: ["role", "hex", "measured_from"],
            additionalProperties: false,
          },
        },
      },
      required: ["logo_source", "colours", "fonts", "colour_map"],
      additionalProperties: false,
    },
    verification: {
      type: "object",
      properties: {
        desktop_compared: { type: "boolean" },
        mobile_compared: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["desktop_compared", "mobile_compared", "notes"],
      additionalProperties: false,
    },
    images: {
      type: "array",
      description: "Every photo or illustration on the page (not logos or icons)",
      items: {
        type: "object",
        properties: {
          section: { type: "string" },
          source: { type: "string", enum: ["user_supplied", "client_website", "generated"] },
          description: { type: "string" },
        },
        required: ["section", "source", "description"],
        additionalProperties: false,
      },
    },
    unresolved: {
      type: "array",
      items: { type: "string" },
      description: "Anything the client must still supply or check (missing proof, facts, contact details)",
    },
  },
  required: ["html_filename", "summary", "sections", "brand", "verification", "images", "unresolved"],
  additionalProperties: false,
} as const;

export type ManusResult = {
  html_filename: string;
  summary: string;
  sections: Array<{ competitor_section: string; rebuilt_as: string; layout_matches: boolean }>;
  brand: {
    logo_source: string;
    colours: string[];
    fonts: string[];
    colour_map?: Array<{ role: string; hex: string; measured_from: string }>;
  };
  verification: { desktop_compared: boolean; mobile_compared: boolean; notes: string };
  images?: Array<{ section: string; source: "user_supplied" | "client_website" | "generated"; description: string }>;
  unresolved: string[];
};

function list(items: Array<string | null | undefined>, max = 12): string {
  const clean = items.map((s) => String(s || "").trim()).filter(Boolean).slice(0, max);
  return clean.length ? clean.map((s) => `- ${s}`).join("\n") : "- (none found yet — read the client website)";
}

function clientSection(input: ManusBriefInput): string {
  const p = input.profile;
  const loc = p?.locations?.find((l) => l.isPrimary) || p?.locations?.[0] || null;
  const assets = p?.brandAssets || null;
  const c = input.brandColors;
  return `## The client (whose page this becomes)
- Name: ${input.clientName}
- Website: ${input.clientUrl}
- Industry: ${p?.industry || "read from the website"}${p?.subIndustry ? ` / ${p.subIndustry}` : ""}
- What they do: ${p?.description || "read from the website"}
- Audience: ${p?.targetAudience || "read from the website"}
- Location: ${loc ? [loc.suburb, loc.city, loc.region, loc.countryCode].filter(Boolean).join(", ") : "read from the website"}
- Campaign keyword: ${input.keyword}

Services / products (from an earlier analysis — confirm on the website):
${list(p?.offerings || [])}

Brand palette guessed by an earlier automatic scan (often wrong: it can come from the logo or an image). Use it only if the site cannot be read; the colours measured on the client's own buttons, bands and tiles always win (see "Colours"):
${c ? `- primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}, background ${c.background}, text ${c.text}` : "- (not found — sample the colours from the website)"}
Logo found earlier: ${assets?.logoUrl || "(not found — take it from the website header)"}
Phones: ${(assets?.phones || []).slice(0, 3).join(", ") || "(read from the website)"}
Emails: ${(assets?.emails || []).slice(0, 3).join(", ") || "(read from the website)"}
Menu links on the client site:
${list((assets?.navLinks || []).map((l) => `${l.label}: ${l.href}`), 10)}`;
}

/** Readable names for the service families offerServiceFocus.ts recognises. */
const FAMILY_LABEL: Record<string, string> = {
  google_ads: "Google Ads (PPC)",
  social_ads: "social media ads",
  seo: "SEO",
  web: "web design",
  email: "email marketing",
  dental: "dental care",
  car_finance: "car finance",
  home_loans: "home loans",
  business_finance: "business finance",
};

export type PageServiceFocus = {
  /** The service the page sells, e.g. "SEO". */
  service: string;
  /** Service families (offerServiceFocus.ts ids) the page must name. */
  families: string[];
  searchKeywords: string[];
  competitorHeadline: string | null;
  competitorCta: string | null;
  competitorOffer: string | null;
  competitorPromises: string[];
};

/**
 * The one service the rebuilt page is about: what the user searched for and
 * what the competitor's page sells. The searched service wins when both are
 * named; the competitor's when the keywords name none.
 */
export function pageServiceFocus(input: ManusBriefInput): PageServiceFocus {
  const offer = input.pageAnalysis?.offer || null;
  const keywords = Array.from(new Set([input.keyword, ...input.searchKeywords].map((k) => k.trim()).filter(Boolean)));
  const searched = familiesInText([...keywords, input.selectedCategory || ""].join(" "));
  const onPage = familiesInText(
    [offer?.headline, offer?.primaryOffer, offer?.cta, input.pageAnalysis?.summary].filter(Boolean).join(" "),
  );
  const shared = searched.filter((f) => onPage.includes(f));
  const families = shared.length ? shared : searched.length ? searched : onPage.slice(0, 1);
  const service = families.length
    ? families.map((f) => FAMILY_LABEL[f] || f).join(" / ")
    : input.selectedCategory || keywords[0] || offer?.primaryOffer || "the competitor's service";
  return {
    service,
    families,
    searchKeywords: keywords,
    competitorHeadline: offer?.headline || null,
    competitorCta: offer?.cta || null,
    competitorOffer: offer?.primaryOffer || null,
    competitorPromises: (offer?.uniqueValueProps || []).slice(0, 6),
  };
}

function focusSection(input: ManusBriefInput): string {
  const f = pageServiceFocus(input);
  return `## The page's service (most important rule after the hard rules)
This page sells **${f.service}**. That is the service the user searched for (keywords: ${f.searchKeywords.join(", ") || "n/a"}${input.selectedCategory ? `; category: ${input.selectedCategory}` : ""}) and the service the competitor's page sells.
- Every element is about ${f.service}: the hero headline and lead, every call-to-action button, the offer, the cards, steps, FAQs, the form and the closing section. A visitor who searched for "${f.searchKeywords[0] || f.service}" must see ${f.service} named in the hero headline or the line under it.
- Do NOT switch the page to the client's other services or to the client's general positioning, even if the client's home page leads with them. Mention other services only where the competitor's page does, in the same proportion.
- The client's USPs and brand voice apply as they relate to ${f.service}.

The competitor's key lines (match their MEANING and service exactly; never their wording):
- Hero headline: ${f.competitorHeadline ? `"${f.competitorHeadline}"` : "(read it on the page)"}
- Main offer: ${f.competitorOffer ? `"${f.competitorOffer}"` : "(read it on the page)"}
- Call to action: ${f.competitorCta ? `"${f.competitorCta}"` : "(read it on the page)"}
${f.competitorPromises.length ? `- Promises: ${f.competitorPromises.map((p) => `"${p}"`).join("; ")}\n` : ""}
Your hero headline makes the same promise about ${f.service}; your call to action makes the same offer (for example, a free ${f.service} audit becomes the client's free ${f.service} audit, a strategy call stays a strategy call). Before building, write a short table for yourself: competitor line → your line, and check each pair names the same service and makes the same point.`;
}

function assetLines(input: ManusBriefInput): string {
  return (input.userAssets || [])
    .map((a) => `- ${a.name}${a.caption ? `: ${a.caption}` : " (no note: judge from the image what it shows)"}`)
    .join("\n");
}

/** The user's own images: they replace generated or competitor-style imagery wherever they fit. */
function userAssetsSection(input: ManusBriefInput): string {
  if (!input.userAssets?.length) return "";
  return `## Images the user supplied (must be used)
The user attached ${input.userAssets.length} image${input.userAssets.length === 1 ? "" : "s"} for this page:
${assetLines(input)}
- Use every one of them in the page, in the section where it fits best by its note and content: stats or results graphics in the results/proof section, product photos where the competitor shows products or in the hero, team photos in the about/team section, certificates or badges in the trust section. If no section fits, place it where the competitor shows a comparable image.
- Use them instead of generated images. Do not change what they show; you may crop and resize them to the competitor's frame and aspect ratio. Keep product photos sharp and uncropped where possible.
- Write the copy around them truthfully: figures in a stats image may be quoted in the text, and product names in the notes may be used.
- Embed each as a data URI in ${MANUS_HTML_FILENAME}. List any image you could not place under "unresolved" with the reason.

`;
}

function competitorSection(input: ManusBriefInput): string {
  const a = input.pageAnalysis;
  const offer = a?.offer;
  const sections = a?.pageArchitecture?.sections || [];
  return `## The competitor page (layout and design source)
- Advertiser: ${input.competitorName}
- Landing page: ${input.competitorUrl}

Its offer (for the offer TYPE and call-to-action CONCEPT only — never reuse the wording):
- Main offer: ${offer?.primaryOffer || "n/a"}
- Call to action: ${offer?.cta || "n/a"}
- Pricing shown: ${offer?.pricing || "none"}
- Guarantees: ${(offer?.guarantees || []).join("; ") || "none"}

Sections an earlier analysis saw (a cross-check list; the live page in your browser is the source of truth):
${sections.length ? sections.map((s, i) => `${i + 1}. ${s.name} — ${s.purpose}`).join("\n") : "- (not available — list them yourself)"}`;
}

/** The full brief, attached to the task as brief.md. */
export function buildManusBrief(input: ManusBriefInput): string {
  const style = styleGuide(input.styleDirection);
  return `# Landing page rebuild brief

## The job
Rebuild the COMPETITOR's landing page for a different business, the CLIENT.
The result should look as identical to the competitor's page as possible: the same sections, layout, sizes, spacing, visual design language and the same message in every heading and paragraph. Only the brand changes: the client's logo, colours, fonts, wording (same meaning, different words, in the client's brand voice), images, proof logos, links and contact details.
The page should also FEEL like the competitor's: its animations, interactions and distinctive visual effects are part of the design to recreate (see "Motion and distinctive design").
Deliver ONE self-contained HTML file named \`${MANUS_HTML_FILENAME}\`, attached to your final message. "Self-contained" means one file, not a static-looking page: it can carry all the CSS and JavaScript the effects need.

## Tools to use
- Firecrawl connector: use it to scrape the client's website whenever your browser misses something: the logo files, the client/partner logos shown on the site, social links, photos and contact details. Scrape the home page and the client's other relevant pages too (about, clients, case studies, portfolio, partners, contact; map the site to find them).
- OpenAI connector: only for an image spot the user's images and the client's website cannot fill, create a new photo with the gpt-image-2 model (rules under "Images" below) and embed it as a data URI. Many pages need no generated images at all.

${input.userFeedback ? `## The user's requests (follow these first, within the hard rules)\n${input.userFeedback}\n\n` : ""}${userAssetsSection(input)}${focusSection(input)}

${competitorSection(input)}

${clientSection(input)}

## How to work (do every step)
1. Open the competitor page in a real browser at 1440px wide. Scroll to the bottom so lazy content loads, dismiss cookie banners, then take a full-page screenshot and one screenshot per section. Do the same at 390px wide.
2. Write down every section from top to bottom, including the header and the footer: section type, number of columns and their ratio, number of cards/items/steps/questions, which side the image sits, text alignment (left or centred), background (plain, tinted, dark, brand colour, gradient or full-width photo), heading sizes and weights, spacing (tight or generous), button shape and style, icons, dividers, logo strips, and the form (fields, number of steps, position). Header: logo position, number of menu items, what sits on each side (phone, address, button). Footer: present or not, columns, how slim.
3. Measure the competitor with getComputedStyle for each section: font sizes, weights, line heights and letter spacing of headings, leads, body and buttons; container max widths; section padding; gaps between columns and cards; card padding and border radius; image sizes; each section's height. Reproduce these numbers; only colours and fonts swap to the client's (adjust sizes slightly if the client's font runs wider, so lines break in similar places).
4. Open the client website (browser first, Firecrawl for anything the browser misses). Collect: the sharpest logo file (see "Logo"), the client/partner logos it shows (see "Proof logo strip"), the client's colour map (see "Colours": the measured colours of its buttons, bands, tiles, header and footer), the fonts, the brand voice (how the site talks), the USPs, real services, facts, contact details, menu links, social links, and photos that suit the page.
5. Write the copy for the client (rules below), element by element against the competitor's copy.
6. Build the HTML page section by section in the competitor's order.
7. Check it visually (below). Fix every difference you find and check again.
8. Attach \`${MANUS_HTML_FILENAME}\` to your final message.

## Keep from the competitor
- Every section, in the same order: none merged, none dropped, none added (except a legally needed footer line).
- Each section's layout: columns and ratio, number of cards/items, media side, alignment, background type, the order of elements inside it and its visual weight.
- The message: every heading, lead, card, step, FAQ, testimonial slot and button makes the same point as the competitor's, rephrased for the client (see "Writing the copy").
- The amount of content: a similar word count per element and the same number of cards, steps, questions and list items.
- Logo strips: a strip or grid of client, partner, platform or media logos stays in the same position, layout, size and treatment (see "Proof logo strip").
- The typography hierarchy (how big the headline is next to the lead and body, weight contrast, how many lines the headline takes), spacing rhythm, button style, card style, dividers, icon placement and image framing/aspect ratios.
- The header arrangement: same logo position and band, and on each side the same kinds of items in the same order. A menu only if the competitor has one. At most one filled button in the header.
- The footer shape: if the competitor has no footer or a slim one, do the same.
- The form: same position, same number of steps and a similar number and type of fields, adapted to what the client's customers would be asked.
- The campaign's offer type and call-to-action concept.

## Replace with the client's
- Every word: the same meaning in different words, in the client's brand voice (see "Writing the copy").
- Colours and fonts: the client's colour map and fonts throughout (see "Colours"). Keep the competitor's light/dark rhythm in the client's colours.
- Logo: only the client's real logo, never redrawn or retyped as text (see "Logo").
- Images: never reuse the competitor's photos, people or graphics (see "Images").
- Proof logos: the client's own client/partner logos (see "Proof logo strip").
- Links: menu and footer links go to the client's real pages. Call-to-action buttons go to the page's form (#anchor) or the client's real contact page. Phone links use tel:, email links use mailto:. No dead "#" links.
- Contact details: only the client's real phone, email and address. Never invent them; if one is missing, put the call-to-action button in its place.

## Colours
The page's colours come from how the client's own website colours each kind of element, measured on the live site, not guessed from the logo, a photo or the palette above.
1. Build the client's colour map. On the client's home page and one or two inner pages (services, products, contact), read the computed styles (background-color, color, border-color, and the hover state) of:
   - primary buttons / main call-to-action buttons (fill, text, border, hover) and secondary or outline buttons;
   - coloured bands and highlight strips (for example a rating or trust bar, announcement bar, stats strip), tiles, cards and badges: background, text, divider and icon colours;
   - header, navigation and footer backgrounds and text; links; headings and body text; form fields and focus colours.
   Take screenshots of those elements and check the measured values against what you see (a button that looks blue is blue on the page).
2. Map roles from the competitor to the client: wherever the competitor uses a colour for a role, use the client's colour for the SAME role. The competitor's primary button gets the client's primary button colours (fill, text, hover); its coloured bands, tiles and strips get the client's band/tile colours; its header, footer, cards, badges, links and headings get the client's colours for those.
3. Use the exact hex values you measured, including the client's text colour on each of its buttons and bands. Do not take button or band colours from the logo or a photo, and do not invent a new accent. If the client's site uses a role's colour only rarely (for example one red sale badge), do not promote it to the main button colour.
4. If the client's site has no element for a role, use the closest role it does have (for example its link or heading colour for an accent), and check contrast.
5. Report the map in "brand.colour_map": each role, its hex value and the client-site element you measured it from.

## Logo
- It must be crisp. Use the SVG when the site has one (inline <svg>, .svg file, or an SVG inside the header link). Otherwise use the largest raster version: check srcset, data-src, retina (@2x/@3x) files, the logo in the site's structured data or og:image if it is the logo, and Firecrawl's branding/logo output. Never use a favicon, a thumbnail or a screenshot crop.
- Embed the original file bytes as a data URI. Never upscale: show a raster logo at no more than half its natural pixel width (sharp on retina screens), set only its height (or width) so it keeps its aspect ratio, sized like the competitor's logo.
- It must read on its background: use the variant made for that background (light/dark), or the header band colour the client's own site uses behind it.
- In the visual check, zoom to 200%: if the logo looks soft or pixelated, find a better file.

## Motion and distinctive design
- While studying the competitor, watch how it moves: load it fresh, scroll slowly top to bottom, hover buttons, cards, images and menu items, open menus, tabs and FAQs, and wait on carousels. Record every animation and interaction: entrance and scroll-reveal effects, counters that count up, sliders, carousels, marquee/ticker logo strips, parallax, sticky or shrinking headers, hover lifts, zooms and colour shifts, animated gradients or backgrounds, background videos, typing or rotating words, progress bars, accordions, tabs, modals, and any other effect that makes the page feel unique.
- Read their timing from the page: durations, delays, easing, stagger, scroll trigger points (computed styles, CSS animations and transitions, and the scripts that drive them).
- Recreate each one in the same section, with the same trigger, direction, timing and feel, in the client's colours. Distinctive visual design (unusual shapes, layered or angled sections, glass or blur effects, decorative patterns or SVG graphics, 3D tilts, custom cursors, gradient meshes) is recreated the same way: the same look and feel, drawn fresh in the client's colours, never copied artwork, logos or illustrations.
- Write the effects in vanilla CSS and JavaScript inside the file. If an effect really needs a library (for example a slider or a complex timeline animation), load it from a public CDN (cdnjs, jsDelivr or unpkg) with a pinned version.
- Content never depends on motion: every element is visible if JavaScript fails, and everything still works with prefers-reduced-motion (show the end state instead of animating). Keep animations smooth: transform and opacity, no layout jank.
- Loops that duplicate items for a seamless marquee or carousel mark the copies aria-hidden="true".
- Add no motion or effects the competitor does not have.

## Proof logo strip
- If the competitor shows logos of its clients, partners, platforms, accreditations or media mentions, the rebuild has that section too, in the same place, with the same layout (row, grid or carousel), a similar count, the same size and the same treatment (greyscale or colour, on a band or plain).
- Fill it with the logos the client shows on its own website: scrape the home page and its clients, case studies, portfolio, about and partners pages with Firecrawl, including carousels, lazy-loaded images (data-src) and CSS background images. Use the original files, embedded as data URIs, each with alt "<brand> logo".
- If the client's site has fewer logos than the competitor, show the ones it has in the same layout. Only if it has none at all, use the platform or accreditation badges it shows (for example Google Partner, Meta Business Partner); if it has none of those either, keep the strip's position with the client's real service areas or platforms as text badges. Never use the competitor's logos or logos the client does not show.

## Images
For every spot where the competitor shows a photo, product shot or illustration, take the image from the first source that has a suitable one:
1. Images the user supplied (see "Images the user supplied", when present).
2. The client's own website: photos, product shots, team, office, project and portfolio images on the home page and its other pages (services, about, products, gallery, case studies, blog). Find them with the browser and the Firecrawl connector, including lazy-loaded images (data-src, srcset) and CSS backgrounds, and use the largest version. Skip icons, logos, tiny thumbnails, stock-looking banners with text baked in, and anything that does not fit the section's message.
3. Only when neither has a suitable image for that spot: create a new one with the OpenAI connector (model gpt-image-2), in the competitor's aspect ratio, a realistic scene that fits the client's industry and the section's message. At most ${IMAGE_BUDGET} generated images per page; generating none is fine when the first two sources cover the page.
Rules for every image:
- Each photo appears ONCE on the page. Never reuse the same image in two sections or two cards, even resized or cropped differently. If you run out of suitable images, generate a distinct one for that spot (within the limit), or else build that spot the way the competitor would look without a photo (for example a solid brand-colour panel) rather than repeating an image. Only the client's logo may appear more than once (header and footer).
- Generated images must not contain text, logos, brand names, UI screenshots or watermarks, and no recognisable real people.
- Embed every image as a data URI (compress photos to JPEG or WebP, about 1600px on the long side) so the page is self-contained.
- Report every image in "images" with its section and source.

## Hard rules
- Never name the competitor or reuse their brand, product or people names anywhere (text, alt text, file names, comments, meta tags).
- Never copy their sentences: no 4 or more consecutive words from their copy (except the campaign keyword and generic service names). Keep the meaning, change the words (see "Writing the copy").
- Never invent statistics, percentages, customer counts, client names, awards, reviews, testimonials, ratings, certifications or people. If a competitor element rests on proof the client cannot back, keep the element and its point, and back it with the client's real fact or USP instead (its own numbers, guarantees, how the work is done). Use the client's real testimonials from its website when it has them. List what is missing under "unresolved".
- Finish every sentence. No placeholders, no lorem ipsum, no "[Client Name]", no "coming soon".
- No emoji, no exclamation spam.
- The form submits with client-side validation and a success message only (no external service). Put the HTML comment \`<!-- CRM: connect form submission here -->\` where submission would be wired.
- Do not deploy, publish or create a hosted website or web app. Deliver the page as one HTML file (it can include all the CSS and JavaScript its effects need).

## Quality floor
- Body text at least 16px; nothing under 14px except fine print. Paragraph lines 45-75 characters wide.
- Text and buttons meet WCAG AA contrast (4.5:1 body, 3:1 large text). No grey text on coloured bands. Every button label is readable on its fill; a button over a photo gets a scrim or a solid style.
- Primary call-to-action labels fit on one line at desktop (2-5 words). One label per intent across the page: the primary action says the same thing in the header, hero and closing section.
- One h1 (the hero), then h2 per section and h3 inside cards, in order. Lists are ul/ol. FAQs use details/summary unless the competitor's FAQ is clearly always open.
- Meaningful alt text written for the client; decorative images alt="". The logo's alt is "<client name> logo". Icon-only controls get aria-label.
- One corner-radius system, one accent colour, no cards inside cards. Motion matches the competitor's (see "Motion and distinctive design"); respect prefers-reduced-motion.
- The hero reads at a glance: headline at most 2 lines at desktop, one supporting line, calls to action visible without scrolling.
- No overlapping text, ever: headline line-height at least 1.1 (1.15 or more for large display sizes), no negative margins, transforms or absolute positioning on text, letter-spacing no tighter than the competitor's, and long words wrap instead of spilling. Large headings use clamp() so they shrink on narrower screens.
- Fully responsive: no horizontal scrolling at 390px, columns stack in a sensible order, tap targets at least 44px.

## Do not look AI-generated (unless the competitor clearly does the same thing in the same place: then recreate it, as "Motion and distinctive design" says)
- No gradient text, no thick coloured stripe on one side of cards, no glowing shadows or neon outlines, no purple-to-cyan washes.
- No fake product UI built from divs (fake dashboards, chat windows, terminals). No hand-drawn decorative SVG illustrations.
- Eyebrow labels at most in one of every three sections, and only where the competitor has one. Step numbers only for real sequences.
- No "→" on every button, no "Fast · Local · Trusted" strings, no section numbers, scroll cues or photo credits.
- No em dashes or en dashes in visible text; use a full stop, comma, colon or brackets, and a plain hyphen for ranges.
- No buzzwords: elevate, seamless, unleash, unlock, empower, revolutionise, next-gen, game-changer, cutting-edge, world-class, delve, supercharge, "in today's fast-paced world".
- No single highlighted word in a headline, no fake-precise numbers, no generic names (John Doe, Acme).

## Writing the copy
- Work element by element against the competitor's copy: for each heading, lead, paragraph, card, step, FAQ, testimonial slot and button, write the client's version that makes the SAME point (the same promise, angle, benefit, objection or call to action) with the same structure and a similar length, in different words.
- Read each competitor line next to yours: a reader must recognise the same message. Example: competitor "Stop wasting money on ads that don't convert" → client "Turn the ad spend you already have into enquiries" keeps the point (fix wasted spend); "We build beautiful websites" would not.
- Write in the client's brand voice (the tone of its own website) and keep its USPs: where the competitor names its own differentiator, say the client's equivalent differentiator in the same place.
- Stay on the page's service (see "The page's service"). Use the client's real facts, location and audience for that service; adapt competitor-specific details (names, numbers, products) to the client's true ones.
- Active voice. Buttons keep the competitor's call-to-action intent in the client's words.
- Numerals for counts. Match the competitor's capitalisation style (sentence case vs title case vs all caps).
- Re-read every visible string before delivering and rewrite anything vague or awkward.

## Style direction: ${STYLE_DIRECTION_LABEL[input.styleDirection]}
${style ? `${style}\n(Our own pipeline uses a CSS class system; apply the intent of these rules in your own CSS.)` : "Match the client's brand: the client's colours, fonts and visual tone inside the competitor's layout."}
Order of priority when rules disagree: the hard rules, then the competitor's layout, then the client's brand and this style direction, then the quality and copy rules.

## Visual check before delivering (mandatory)
Open your finished ${MANUS_HTML_FILENAME} in the browser at 1440px and 390px, take full-page screenshots, and compare them with the competitor's screenshots section by section, side by side:
- Same number of sections in the same order; each with the same columns, card count, media side, alignment, background type, and a height within about 10% of the competitor's at 1440px.
- Font sizes, spacing and widths match your getComputedStyle measurements of the competitor.
- Header and footer match the competitor's arrangement. Every logo strip the competitor has is there, filled with the client's logos.
- The client's logo shows, is readable, and is sharp at 200% zoom. No competitor logo, name or photo appears anywhere: search the HTML source for the competitor's name and domain and remove any hit.
- Each heading and lead says the same thing as the competitor's counterpart, in different words, about the same service. The hero headline (or the line under it) names the page's service, and every call to action makes the competitor's offer for that service.
- Only the client's colours and fonts are used, by role: put a screenshot of the client site's buttons and coloured bands next to yours; the primary buttons, secondary buttons, highlight bands and tiles must use the same colours as the client's own. Headings, body text and buttons are aligned the way the competitor's are.
- Every photo appears once: no image is repeated in another section or card (only the logo may repeat).
- No overlapping or clipped text at 1440, 1280, 1024, 768 and 390px (check the hero headline especially). No broken images, no placeholder text, no dead links, no horizontal scrolling on mobile, readable contrast everywhere.
- The form works: required fields validate and the success message shows.
- Motion matches: scroll, hover and wait on your page next to the competitor's; each animation and interaction runs in the same section with the same feel, without jank or console errors, and the page still reads fully with reduced motion.
Fix every problem and check again until both widths match the competitor.

## Delivery
- One file, \`${MANUS_HTML_FILENAME}\`: complete HTML document with inline CSS and JS. Images either embedded as data URIs or as absolute https URLs from the client's own website. Google Fonts links and pinned CDN libraries (cdnjs, jsDelivr, unpkg) for effects are fine. No relative paths to other files.
- Attach it to your final message. Report the sections, brand sources, what you checked and anything unresolved.
- If something is unclear, decide yourself by following this brief. Ask a question only if you are truly blocked; an assistant answers for the user.`;
}

/** The task's opening message. The full rules travel in the attached brief. */
export function buildManusTaskMessage(input: ManusBriefInput): string {
  return `Rebuild a competitor's landing page for my client, then check it visually and deliver one self-contained HTML file.

Competitor landing page (copy its structure, layout and design language): ${input.competitorUrl}
Client website (use its logo, colours, fonts, facts, links and contact details): ${input.clientUrl}
Client: ${input.clientName}
The page sells: ${pageServiceFocus(input).service} (what the user searched for: ${pageServiceFocus(input).searchKeywords.join(", ")}). Headline, call to action and content stay on this service, matching the competitor's.
Style: ${STYLE_DIRECTION_LABEL[input.styleDirection]}
${input.userFeedback ? `User's requests: ${input.userFeedback.slice(0, 1500)}\n` : ""}${input.userAssets?.length ? `The user attached ${input.userAssets.length} image${input.userAssets.length === 1 ? "" : "s"} the page must use (${input.userAssets.map((a) => a.name).join(", ")}); see "Images the user supplied" in brief.md.\n` : ""}
The attached brief.md has every rule. Read it completely before you start and follow it exactly:
- make the page as identical to the competitor as possible: every section in order, the same layout, measured sizes and spacing, card counts, alignment, background types and logo strips
- every heading and paragraph says the same thing as the competitor's, in different words and the client's brand voice
- use the client's sharpest logo, its own client/partner logos, fonts, links and contact details (use the Firecrawl connector when the browser misses something)
- colour every button, band, tile, header and footer with the colours the client's own site uses for that same kind of element (measure them on the live site), not colours from the logo or a guessed palette
- images: the user's images first, then the client website's own photos; create new ones with the OpenAI connector (gpt-image-2) only for spots those cannot fill. Never use the same image twice
- never copy the competitor's wording, names or images, and never invent facts, reviews or numbers
- recreate the competitor's animations, interactions and distinctive effects the same way (scroll, hover and wait on its page to find them)
- compare your page with the competitor at 1440px and 390px (no overlapping text at any width) and fix every difference before delivering
- do not deploy or publish anything

Attach the final page as ${MANUS_HTML_FILENAME}.`;
}

/** A change request on a page the agent already delivered. */
export function buildManusEditMessage(request: string): string {
  return `The user wants these changes to the page you delivered:

${request}

Apply them to your latest ${MANUS_HTML_FILENAME}. Keep everything else exactly as it is, and keep following brief.md. Re-check the changed parts in the browser at 1440px and 390px, then attach the complete updated ${MANUS_HTML_FILENAME}. Do not deploy or publish anything.`;
}

/** What the question-answering model knows about the job. */
export function buildAnswerContext(input: ManusBriefInput): string {
  const c = input.brandColors;
  const focus = pageServiceFocus(input);
  return `Job: rebuild the competitor landing page ${input.competitorUrl} for the client ${input.clientName} (${input.clientUrl}).
The page sells ${focus.service} (the user's search: ${focus.searchKeywords.join(", ")}). Headline, CTA and every section stay on ${focus.service}, making the same promise and offer as the competitor's (headline "${focus.competitorHeadline || "n/a"}", CTA "${focus.competitorCta || "n/a"}"), never the client's other services.
Goal: the page as identical to the competitor as possible. Keep: every section in order, each section's layout, columns, card counts, media side, alignment, background type, measured font sizes and spacing, header arrangement, footer shape, logo strips, form position and step count, offer type and CTA concept, and the same message in every heading and paragraph (rephrased, in the client's brand voice, keeping the client's USPs).
Replace with the client's: the wording, colours and fonts, its sharpest real logo (SVG or largest file, never upscaled), its own client/partner logos for any logo strip (scraped with the Firecrawl connector), images (the user's images first, then the client website's own photos, and only for spots those cannot fill new ones made with the OpenAI connector's gpt-image-2 model, without text, at most ${IMAGE_BUDGET}; each image used once; embedded as data URIs), links, phone, email and address.
Never: name the competitor, copy 4+ consecutive words of its copy, reuse its images, invent statistics/testimonials/awards/reviews/people/contact details, use placeholders, deploy or publish anything.
Form: client-side validation and a success message only, with a CRM comment where submission would be wired.
Motion: recreate the competitor's animations, interactions and distinctive effects (scroll reveals, counters, sliders, marquees, hover effects, sticky header, parallax and so on) with the same trigger, timing and feel, in vanilla CSS/JS or a pinned CDN library; content visible without JavaScript; prefers-reduced-motion respected; add no effects the competitor lacks.
Deliverable: one self-contained ${MANUS_HTML_FILENAME} attached to the final message (inline CSS/JS; images as data URIs or absolute https URLs from the client's site).
Verification: compare with the competitor at 1440px and 390px and fix differences before delivering.
Style direction: ${STYLE_DIRECTION_LABEL[input.styleDirection]}.
Client industry: ${input.profile?.industry || "unknown"}. Services: ${(input.profile?.offerings || []).slice(0, 8).join(", ") || "see website"}.
Colours: measured by role on the client's live site (its buttons, bands, tiles, header, footer), and mapped role for role onto the competitor's layout; never taken from the logo or a photo. An earlier automatic guess (often wrong) was ${c ? `primary ${c.primary}, secondary ${c.secondary}, accent ${c.accent}` : "not available"}.
Known logo: ${input.profile?.brandAssets?.logoUrl || "take it from the client's site header"}.
${input.userFeedback ? `User's requests: ${input.userFeedback}` : ""}
${input.userAssets?.length ? `The user supplied images the page must use (embedded as data URIs, in the best-fitting sections, instead of generated images):\n${assetLines(input)}` : ""}`.trim();
}
