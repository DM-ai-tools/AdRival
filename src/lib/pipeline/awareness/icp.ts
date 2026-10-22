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
});

const SYSTEM = `You write an ideal customer profile (ICP) for one specific service, aimed at one stage of market awareness (Eugene Schwartz).
Stages:
- unaware: does not know they have a problem; reacts to stories, identity, curiosity.
- problem_aware: feels the pain, does not know solutions exist.
- solution_aware: knows solutions exist, does not know this one.
- product_aware: knows this business, needs proof, comparison, objection handling.
- most_aware: ready to buy, needs the offer, price, deal or urgency.
Rules:
- Be specific to the business's offerings, positioning, target audience and market. No generic marketing filler.
- Write for the requested stage: what this reader already knows and what they say out loud at that stage.
- saysOutLoud: first-person phrases this person would actually say, in their own words.
- Avoid angles the listed competitor pages already take; suggestedAngle must be a different, open angle.
- Each list has at most ${MAX_ITEMS} short items. Use null for demographics you cannot support.
Return only JSON: {"painPoints":[],"demographics":{"ageRange":null,"role":null,"budget":null,"location":null,"other":null},"psychographics":[],"saysOutLoud":[],"interests":[],"hopesAndDesires":[],"stageNotes":"how this stage thinks and what they know","suggestedAngle":"one sentence"}`;

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
  call?: JsonCaller;
}): Promise<IcpContent> {
  if (!icpProfileReady(input.profile)) throw new Error("Add your business website first");
  const call = input.call ?? completeJson;
  const p = input.profile;
  const user = JSON.stringify(
    {
      stage: input.stage,
      business: {
        name: p.businessName,
        industry: p.industry,
        subIndustry: p.subIndustry ?? null,
        description: p.description,
        offerings: p.offerings,
        positioningSummary: p.positioningSummary,
        targetAudience: p.targetAudience ?? null,
        market: p.primaryMarketCountry ?? null,
        locations: (p.locations ?? []).slice(0, 5),
      },
      searchKeywords: input.keywords.slice(0, 20),
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
