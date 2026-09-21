import { getAnthropicClient, getAnthropicModel } from "../../anthropic/client";
import { parseUnifiedResponse, type UnifiedGenerationResponse } from "./contract";
import type { UnifiedBrief } from "./brief";

const SYSTEM = `You are a senior front-end developer and conversion copywriter rebuilding landing pages.

You CLONE the competitor's VISUAL STRUCTURE from any attached Firecrawl screenshots (section order, hero composition, media placement, CTA placement, density) AND their CAMPAIGN OFFER TYPE (primaryOffer + CTA concept from campaignOffer). You DISCARD their identity, colours, type, verbatim copy, claims, testimonials, and imagery — then restyle with the CLIENT brand tokens.

Hard limits:
- Screenshots (when attached) are authoritative for layout. Do NOT invent a generic agency/SaaS landing-page template.
- Never reproduce the competitor logo, wordmark, mascot, or brand assets (including SVG redraws).
- Never copy or closely paraphrase competitor sentences.
- Never invent statistics, named clients, awards, testimonials, or people.
- campaignOffer is mandatory for hero badge, headline angle, service focus, and primary CTA.
- clientFacts are supporting evidence only — they must not override campaignOffer.
- Use ONLY the brand brief / asset registry for identity, claims, destinations, and logos.
- Put colours, radii, shadows, and fonts in :root CSS variables; no scattered raw hex later.
- Prefer compact CSS. Avoid huge utility dumps. Finish a complete </html> inside valid JSON.
- Company logo must use identityLogo src with data-logo-role="company" and object-fit:contain.
- Proof logos only from proofLogos with data-logo-role="proof".
- Illustrative slots: empty img with data-adrival-slot and a transparent 1x1 data URI; prompts say "no logos, no readable text".
- Return ONE JSON object matching the outputContract. The html string must be complete.`;

function maxOutputTokens(): number {
  const fromEnv = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || "");
  // Claude Sonnet 4/5 support large outputs; default high enough for full landing HTML.
  if (Number.isFinite(fromEnv) && fromEnv >= 8000) return Math.min(Math.floor(fromEnv), 64000);
  return 64000;
}

type StreamedMessage = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
};

type ContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
        data: string;
      };
    };

async function streamUnifiedMessage(input: {
  model: string;
  maxTokens: number;
  content: ContentPart[];
}): Promise<StreamedMessage> {
  const client = getAnthropicClient();
  const stream = client.messages.stream({
    model: input.model,
    max_tokens: input.maxTokens,
    system: SYSTEM,
    messages: [{ role: "user", content: input.content }],
  });
  const message = await stream.finalMessage();
  return message as StreamedMessage;
}

function textFromMessage(message: StreamedMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text || "" : "")).join("\n");
}

function buildUserContent(active: UnifiedBrief): ContentPart[] {
  const content: ContentPart[] = [];
  // One fold screenshot is enough for layout guidance and keeps generation fast.
  for (const tile of active.imageTiles.slice(0, 1)) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: tile.mediaType,
        data: tile.data,
      },
    });
  }
  content.push({
    type: "text",
    text: `${active.text}

${
  active.imageTiles.length
    ? "The image above is a Firecrawl above-the-fold screenshot. Clone its hero/CTA/nav rhythm — do not invent a generic template."
    : "No screenshot attached; still clone competitorSections + campaignOffer and avoid a stock template."
}
Obey campaignOffer for the hero CTA and primary offer — rewrite for the client brand.
Use :root tokens and the provided identity logo data URI when present.
Max ${active.compact ? 2 : 3} imageSlots. Return valid JSON with a complete </html> before stopping.`,
  });
  return content;
}

function tryParse(raw: string): UnifiedGenerationResponse | null {
  try {
    return parseUnifiedResponse(raw);
  } catch {
    return null;
  }
}

export async function generateUnifiedPage(
  brief: UnifiedBrief,
  options?: { compactBrief?: UnifiedBrief | null },
): Promise<{
  response: UnifiedGenerationResponse;
  rawLength: number;
  model: string;
}> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Anthropic is not configured. Set ANTHROPIC_API_KEY to generate the page.");
  }
  const model = getAnthropicModel();
  const maxTokens = maxOutputTokens();

  const runOnce = async (active: UnifiedBrief) =>
    streamUnifiedMessage({
      model,
      maxTokens,
      content: buildUserContent(active),
    });

  let completion = await runOnce(brief);
  let raw = textFromMessage(completion);
  let parsed = tryParse(raw);

  const needsCompact =
    !parsed ||
    completion.stop_reason === "max_tokens";

  if (needsCompact) {
    console.warn(
      `[unified] ${
        completion.stop_reason === "max_tokens"
          ? "generation truncated"
          : "JSON parse failed"
      }; retrying with compact brief (no screenshots)`,
    );
    const compactBrief: UnifiedBrief =
      options?.compactBrief || {
        ...brief,
        compact: true,
        imageTiles: [],
        text: `COMPACT MODE: fewer sections, shorter CSS, still clone campaignOffer + section order. Finish valid JSON with complete </html>.\n${brief.text.slice(0, 28_000)}`,
      };
    completion = await runOnce({
      ...compactBrief,
      compact: true,
      imageTiles: [],
    });
    raw = textFromMessage(completion);
    parsed = tryParse(raw);
  }

  if (!parsed) {
    if (completion.stop_reason === "max_tokens") {
      throw new Error(
        "The model response was truncated before the page was complete. Try regenerating, or set ANTHROPIC_MAX_OUTPUT_TOKENS higher.",
      );
    }
    throw new Error("The model response JSON could not be parsed. The page was not marked complete.");
  }

  return {
    response: parsed,
    rawLength: raw.length,
    model,
  };
}

export async function repairUnifiedPage(input: {
  html: string;
  defects: string[];
  briefText?: string;
}): Promise<{ response: UnifiedGenerationResponse; model: string }> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("Anthropic is not configured. Set ANTHROPIC_API_KEY to repair the page.");
  }
  const model = getAnthropicModel();
  const completion = await streamUnifiedMessage({
    model,
    maxTokens: maxOutputTokens(),
    content: [{
      type: "text",
      text: `Repair this landing page. Keep correct content and unaffected sections. Preserve :root tokens, logo roles, and layout variety.
Defects to fix:
${input.defects.map((item, index) => `${index + 1}. ${item}`).join("\n")}
${input.briefText ? `\nOriginal brief constraints (abridged):\n${input.briefText.slice(0, 6000)}` : ""}

Current HTML:
${input.html.slice(0, 60000)}

Return the same JSON outputContract with a complete repaired HTML document.`,
    }],
  });
  const raw = textFromMessage(completion);
  const parsed = tryParse(raw);
  if (!parsed) {
    if (completion.stop_reason === "max_tokens") {
      throw new Error("The repair response was truncated before the page was complete.");
    }
    throw new Error("The model response JSON could not be parsed. The page was not marked complete.");
  }
  return { response: parsed, model };
}
