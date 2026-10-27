import { z } from "zod";
import type {
  AudienceLevel,
  AwarenessStage,
  BusinessProfile,
  IcpContent,
  IcpRecord,
} from "../../types";
import { isCreditError } from "../../accounting/errors";
import { completeJson, type JsonCaller } from "../llmJson";
import { LOOKUP_RECREATE_PREFIX } from "../lookupRecreateBridge";

const MAX_ITEMS = 8;

export function icpProfileReady(profile: BusinessProfile | null | undefined): boolean {
  if (!profile) return false;
  const offerings = (profile.offerings ?? []).filter((o) => o?.trim());
  return offerings.length > 0 || Boolean(profile.targetAudience?.trim());
}

const list = z
  .array(z.string())
  .default([])
  .transform((a) => a.map((s) => s.trim()).filter(Boolean).slice(0, MAX_ITEMS));
const nullable = z
  .string()
  .nullish()
  .transform((v) => v?.trim() || null);

const icpSchema = z.object({
  painPoints: list,
  demographics: z
    .object({
      ageRange: nullable,
      role: nullable,
      budget: nullable,
      location: nullable,
      other: nullable,
    })
    .default({ ageRange: null, role: null, budget: null, location: null, other: null }),
  psychographics: list,
  saysOutLoud: list,
  interests: list,
  hopesAndDesires: list,
  stageNotes: z.string().default("").transform((v) => v.trim()),
  suggestedAngle: z.string().default("").transform((v) => v.trim()),
  persona: z.string().nullish().transform((v) => v?.trim() || undefined),
  triggers: list.optional().transform((a) => (a?.length ? a : undefined)),
  objections: list.optional().transform((a) => (a?.length ? a : undefined)),
});

const SYSTEM = `You write an ideal customer profile (ICP) for ONE specific service, aimed at ONE stage of market awareness (Eugene Schwartz).
Stages:
- unaware: does not know they have a problem; reacts to stories, identity, curiosity.
- problem_aware: feels the pain, does not know solutions exist.
- solution_aware: knows solutions exist, does not know this one.
- product_aware: knows this business, needs proof, comparison, objection handling.
- most_aware: ready to buy, needs the offer, price, deal or urgency.

The input gives you serviceFocus (the exact service being sold, taken from the user's search keywords), the business, and the closest competitor page for this stage. Treat serviceFocus as the product. Everything you write must be about the person who would buy THAT service, not about the business's industry in general.

Rules:
- Be concrete. Name real situations, numbers, tools, deadlines and money (for example a monthly ad spend, a cost per lead, a failed agency, a specific platform) that fit the service and market. A reader should be able to tell which service this ICP is for without seeing the title.
- Banned filler, never write anything like: "struggling to attract new customers", "wants to grow", "values growth and success", "stay competitive", "reliable partner", "overwhelmed by options", "wasting money" with no detail. If a line could describe any business service, rewrite it until it could only describe this one.
- Pain points are specific situations with a cost or consequence, not feelings.
- demographics.role is a real job title or situation (owner of a 5-person trades business), not "business owner". Give an ageRange, budget and location whenever the market data supports a reasonable estimate.
- saysOutLoud: first-person sentences in the buyer's own words, with the vocabulary this person actually uses at this stage (an unaware reader does not say the service name; a most-aware one asks about price and start date).
- triggers: the event that made them look right now. objections: what makes them hesitate to buy this service.
- Write for the requested stage: what this reader already knows and what they do not.
- Avoid angles the listed competitor pages already take; suggestedAngle must be one open angle, one sentence, usable as a landing-page headline direction.
- userNotes, when present, are facts from the business owner about their real customer. They outrank your assumptions: reflect every one of them in the relevant sections, and never contradict them.
- Use the market country for spelling, currency and local detail. Use null for demographics you cannot support.
- Each list has at most ${MAX_ITEMS} short items; aim for 5 to 7 strong ones, not filler to reach the maximum.
Return only JSON: {"persona":"one sentence: who this person is","painPoints":[],"demographics":{"ageRange":null,"role":null,"budget":null,"location":null,"other":null},"psychographics":[],"saysOutLoud":[],"triggers":[],"objections":[],"interests":[],"hopesAndDesires":[],"stageNotes":"how this stage thinks and what they know","suggestedAngle":"one sentence"}`;

function parseJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("no JSON object");
  }
}

export async function generateIcp(input: {
  profile: BusinessProfile;
  stage: Exclude<AwarenessStage, "unclear">;
  keywords: string[];
  competitorPages: Array<{
    brand: string;
    headline: string | null;
    awarenessStage: AwarenessStage;
    audienceLevel: AudienceLevel;
  }>;
  /** The completed page closest to this stage; shows how the market already speaks to it. */
  basePage?: {
    brand: string;
    headline: string | null;
    primaryOffer: string | null;
    cta: string | null;
  } | null;
  /** The user's own corrections and details about their customer. */
  userNotes?: string | null;
  call?: JsonCaller;
}): Promise<IcpContent> {
  if (!icpProfileReady(input.profile)) throw new Error("Add your business website first");
  const call = input.call ?? completeJson;
  const p = input.profile;
  const user = JSON.stringify(
    {
      stage: input.stage,
      serviceFocus: input.keywords.slice(0, 6),
      business: {
        name: p.businessName,
        industry: p.industry,
        subIndustry: p.subIndustry ?? null,
        description: p.description,
        offerings: p.offerings,
        positioningSummary: p.positioningSummary,
        targetAudience: p.targetAudience ?? null,
        businessModel: p.businessModel ?? null,
        serviceDelivery: p.serviceDelivery ?? null,
        services: (p.categories ?? []).map((c) => c.label).filter(Boolean).slice(0, 12),
        market: p.primaryMarketCountry ?? null,
        locations: (p.locations ?? []).slice(0, 5),
      },
      searchKeywords: input.keywords.slice(0, 20),
      userNotes: input.userNotes?.trim() || null,
      closestCompetitorPageForThisStage: input.basePage ?? null,
      competitorPagesAlreadyUsedAngles: input.competitorPages.slice(0, 20),
    },
    null,
    2,
  );
  try {
    const icp = icpSchema.parse(parseJson(await call(SYSTEM, user)));
    if (
      !icp.painPoints.length ||
      !icp.saysOutLoud.length ||
      !icp.hopesAndDesires.length ||
      !icp.suggestedAngle ||
      !icp.stageNotes
    ) {
      throw new Error("empty ICP");
    }
    return icp;
  } catch (err) {
    if (isCreditError(err)) throw err;
    throw new Error("Could not build the customer profile. Try again.");
  }
}

export function icpBelongsToRun(icp: Pick<IcpRecord, "source">, runId: string): boolean {
  if (icp.source.kind === "search") return icp.source.id === runId;
  return runId === LOOKUP_RECREATE_PREFIX + icp.source.id;
}
