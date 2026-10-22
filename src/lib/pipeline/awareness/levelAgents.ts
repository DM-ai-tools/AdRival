import { z } from "zod";
import type {
  AudienceLevel,
  AwarenessFocus,
  AwarenessStage,
  PageLevels,
  SectionLevel,
} from "../../types";
import { isCreditError } from "../../accounting/errors";
import { evidenceWords, pageCoverage } from "../evidence";
import { completeJson, type JsonCaller } from "../llmJson";

export type BlockLevel = {
  heading: string;
  audienceLevel: AudienceLevel;
  awarenessStage: AwarenessStage;
};
export type LevelsResult = { levels: PageLevels; blocks: BlockLevel[] };

const MAX_BLOCKS = 24;
const MIN_EVIDENCE_COVERAGE = 0.8;

const audienceValues = ["newbie", "intermediate", "advanced", "unclear"] as const;
const stageValues = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
  "unclear",
] as const;

const audienceSchema = z.object({
  audienceLevel: z.enum(audienceValues),
  reason: z.string().default(""),
  evidence: z.string().nullish(),
});
const awarenessSchema = z.object({
  awarenessStage: z.enum(stageValues),
  awarenessFocus: z.enum(["only_problem", "only_solution", "balanced"]).nullish(),
  reason: z.string().default(""),
  evidence: z.string().nullish(),
  blocks: z
    .array(
      z.object({
        heading: z.string(),
        audienceLevel: z.enum(audienceValues).catch("unclear"),
        awarenessStage: z.enum(stageValues).catch("unclear"),
      }),
    )
    .default([]),
});

const AUDIENCE_SYSTEM = `You are the audience-level agent. Decide how much the reader of this landing page is assumed to already know about the topic, from the page copy alone.
Levels:
- newbie: plain language, explains basics, avoids jargon, assumes the reader is new to the topic.
- intermediate: uses common industry terms without explaining them, assumes working familiarity.
- advanced: dense jargon, acronyms, benchmarks or technical depth, assumes expert knowledge.
- unclear: the copy gives no signal. Use this whenever you cannot quote real evidence.
Quote an exact passage (25 words or fewer) copied verbatim from visiblePageText that justifies the level.
Return only JSON: {"audienceLevel":"newbie|intermediate|advanced|unclear","reason":"one sentence","evidence":"exact quote or null"}`;

const AWARENESS_SYSTEM = `You are the awareness-stage agent, using the five stages of market awareness from Eugene Schwartz. Decide what the page copy assumes the reader already knows, from the copy alone.
Stages:
- unaware: the reader does not know they have a problem; copy leads with a story, identity or curiosity.
- problem_aware: the reader knows the pain but not that solutions exist; copy leads with the problem.
- solution_aware: the reader knows solutions exist but not this product; copy leads with the kind of result or method.
- product_aware: the reader knows this product but is not yet convinced; copy leads with proof, comparison, features and objections.
- most_aware: the reader is ready to buy; copy leads with the offer, price, deal or urgency.
- unclear: the copy gives no signal. Use this whenever you cannot quote real evidence.
Also set awarenessFocus: "only_problem" if the page talks only about the problem, "only_solution" if only about the solution, "balanced" if both, null if unclear.
Quote an exact passage (25 words or fewer) copied verbatim from visiblePageText for the page-level label.
Also label each heading block in headingOutline (at most ${MAX_BLOCKS}) with an audienceLevel and awarenessStage, using "unclear" when there is no signal.
Return only JSON: {"awarenessStage":"...","awarenessFocus":"only_problem|only_solution|balanced|null","reason":"one sentence","evidence":"exact quote or null","blocks":[{"heading":"...","audienceLevel":"...","awarenessStage":"..."}]}`;

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

async function runAgent<T>(
  call: JsonCaller,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T | null> {
  try {
    return schema.parse(parseJson(await call(system, user)));
  } catch (err) {
    if (isCreditError(err)) throw err;
    console.error(`[levels] ${label} agent failed`, err);
    return null;
  }
}

function groundedEvidence(evidence: string | null | undefined, words: Set<string>): string | null {
  const quote = evidence?.trim();
  if (!quote) return null;
  return pageCoverage(quote, words) >= MIN_EVIDENCE_COVERAGE ? quote : null;
}

export async function analyzeLevels(input: {
  headingOutline: Array<{ level: number; text: string; snippet: string }>;
  heroCandidates: string[];
  visibleText: string;
  call?: JsonCaller;
}): Promise<LevelsResult> {
  const call = input.call ?? completeJson;
  const words = new Set(evidenceWords(input.visibleText));
  const user = JSON.stringify(
    {
      heroCandidates: input.heroCandidates,
      headingOutline: input.headingOutline.slice(0, MAX_BLOCKS),
      visiblePageText: input.visibleText.slice(0, 12000),
    },
    null,
    2,
  );

  const [aud, awa] = await Promise.all([
    runAgent(call, AUDIENCE_SYSTEM, user, audienceSchema, "audience"),
    runAgent(call, AWARENESS_SYSTEM, user, awarenessSchema, "awareness"),
  ]);

  // A failed awareness agent is an outage, not an "unclear" label: throw so the
  // page stays unlabelled and can be retried. An audience-only failure keeps
  // the awareness result and marks the audience unclear.
  if (!awa) throw new Error("Awareness agent failed; page left unlabelled");

  const audEvidence = aud ? groundedEvidence(aud.evidence, words) : null;
  const audOk = aud && aud.audienceLevel !== "unclear" && audEvidence;
  const awaEvidence = awa ? groundedEvidence(awa.evidence, words) : null;
  const awaOk = awa && awa.awarenessStage !== "unclear" && awaEvidence;

  const levels: PageLevels = {
    audienceLevel: audOk ? aud.audienceLevel : "unclear",
    audienceReason: aud?.reason ?? "",
    audienceEvidence: audOk ? audEvidence : null,
    awarenessStage: awaOk ? awa.awarenessStage : "unclear",
    awarenessFocus: awaOk ? ((awa.awarenessFocus as AwarenessFocus | null | undefined) ?? null) : null,
    awarenessReason: awa?.reason ?? "",
    awarenessEvidence: awaOk ? awaEvidence : null,
    sectionLevels: [],
  };
  const blocks = ((awa?.blocks ?? []) as BlockLevel[]).slice(0, MAX_BLOCKS);
  return { levels, blocks };
}

export function attachSectionLevels(
  sections: Array<{ name: string; summary: string; keyElements?: string[] }>,
  blocks: BlockLevel[],
  page: Pick<PageLevels, "audienceLevel" | "awarenessStage">,
): SectionLevel[] {
  return sections.map((section) => {
    const haystack = [section.summary, ...(section.keyElements ?? [])].join("\n").toLowerCase();
    const block = blocks.find((b) => {
      const heading = b.heading.trim().toLowerCase();
      return heading.length > 0 && haystack.includes(heading);
    });
    return {
      sectionName: section.name,
      audienceLevel: block?.audienceLevel ?? page.audienceLevel,
      awarenessStage: block?.awarenessStage ?? page.awarenessStage,
    };
  });
}
