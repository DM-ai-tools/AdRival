import { isCreditError } from "../accounting/errors";
import { getDirectOpenAIClient } from "../openrouter/openaiCompat";
import type { BusinessProfile, LookupCoreOfferLadder } from "../types";
import {
  INDUSTRY_SOPS,
  resolveIndustrySop,
  type IndustrySop,
} from "./industrySops";

export type GuardrailMode = "enforce" | "override";

export interface GuardrailOverride {
  /** When true, SOP excludes are relaxed and seekCompetitors steers acceptance */
  enabled: boolean;
  /** What the user wants to look for instead / in addition */
  seekCompetitors?: string | null;
  /** Extra free-text instructions */
  notes?: string | null;
}

export interface GuardrailContext {
  industry?: string | null;
  subIndustry?: string | null;
  offerings?: string[] | null;
  description?: string | null;
  selectedCategory?: string | null;
  searchKeywords?: string[] | null;
  override?: GuardrailOverride | null;
  /** Skip all SOP checks */
  skip?: boolean;
}

export interface GuardrailDecision {
  ok: boolean;
  reason: string;
  source: "skip" | "override_pass" | "heuristic" | "llm" | "sop";
  sopId: string;
}

function compile(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, "i"));
}

function haystack(parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join("\n").slice(0, 4000);
}

function matchesAny(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    if (re.test(text)) return re.source;
  }
  return null;
}

export function buildGuardrailContext(input: {
  businessProfile?: BusinessProfile | null;
  selectedCategoryLabel?: string | null;
  searchKeywords?: string[] | null;
  override?: GuardrailOverride | null;
  skipGuardrails?: boolean;
}): GuardrailContext {
  const p = input.businessProfile;
  return {
    industry: p?.industry || null,
    subIndustry: p?.subIndustry || null,
    offerings: p?.offerings || null,
    description: p?.description || null,
    selectedCategory: input.selectedCategoryLabel || null,
    searchKeywords: input.searchKeywords || p?.competitorKeywords || null,
    override: input.override || null,
    skip: Boolean(input.skipGuardrails),
  };
}

export function getSopForContext(ctx: GuardrailContext): IndustrySop {
  return resolveIndustrySop({
    industry: ctx.industry,
    subIndustry: ctx.subIndustry,
    offerings: ctx.offerings,
    description: ctx.description,
    selectedCategory: ctx.selectedCategory,
  });
}

/**
 * Fast competitor check — heuristics only (no network).
 * Call this on every candidate; only escalate borderline cases to LLM if needed.
 */
export function guardCompetitorHeuristic(
  ctx: GuardrailContext,
  candidate: {
    pageName: string;
    adText?: string | null;
    landingPageUrl?: string | null;
    services?: string[] | null;
    llmReason?: string | null;
  },
): GuardrailDecision {
  const sop = getSopForContext(ctx);
  if (ctx.skip) {
    return {
      ok: true,
      reason: "Guardrails skipped by user",
      source: "skip",
      sopId: sop.id,
    };
  }

  const text = haystack([
    candidate.pageName,
    candidate.adText,
    candidate.landingPageUrl,
    ...(candidate.services || []),
    candidate.llmReason,
  ]);

  // Override mode: still block obvious junk unless user explicitly seeks it
  if (ctx.override?.enabled) {
    const seek = (ctx.override.seekCompetitors || "").toLowerCase();
    const notes = (ctx.override.notes || "").toLowerCase();
    const wantsTools = /tool|saas|software|white[- ]?label|platform/.test(
      `${seek} ${notes}`,
    );
    const wantsCourses = /course|podcast|masterclass|academy|coaching/.test(
      `${seek} ${notes}`,
    );
    const reject = compile(
      sop.competitorRejectPatterns.filter((p) => {
        if (wantsTools && /saas|software|tool|white|platform|extension/i.test(p))
          return false;
        if (wantsCourses && /course|podcast|masterclass|bootcamp|academy/i.test(p))
          return false;
        return true;
      }),
    );
    const hit = matchesAny(text, reject);
    if (hit && !wantsTools && !wantsCourses) {
      // soft: if override has seek text, prefer LLM only for borderline — pass heuristic
      if (seek.length > 8) {
        return {
          ok: true,
          reason: `Override seek: ${ctx.override.seekCompetitors}`,
          source: "override_pass",
          sopId: sop.id,
        };
      }
      return {
        ok: false,
        reason: `SOP exclude (${sop.label}): matched /${hit}/`,
        source: "heuristic",
        sopId: sop.id,
      };
    }
    return {
      ok: true,
      reason: seek
        ? `Override active — seeking: ${ctx.override.seekCompetitors}`
        : "Override active",
      source: "override_pass",
      sopId: sop.id,
    };
  }

  const hit = matchesAny(text, compile(sop.competitorRejectPatterns));
  if (hit) {
    return {
      ok: false,
      reason: `Industry SOP (${sop.label}) rejected competitor: matched /${hit}/`,
      source: "heuristic",
      sopId: sop.id,
    };
  }

  return {
    ok: true,
    reason: `Passed ${sop.label} competitor SOP`,
    source: "sop",
    sopId: sop.id,
  };
}

/**
 * Fast offer-ladder check — heuristics only.
 */
export function guardOfferLadderHeuristic(
  ctx: GuardrailContext,
  ladder: {
    coreOffer: string;
    details?: string | null;
    cta?: string | null;
    adOffers?: Array<{ offer?: string; hook?: string; sampleCopy?: string | null }>;
  },
): GuardrailDecision {
  const sop = getSopForContext(ctx);
  if (ctx.skip) {
    return {
      ok: true,
      reason: "Guardrails skipped",
      source: "skip",
      sopId: sop.id,
    };
  }

  const text = haystack([
    ladder.coreOffer,
    ladder.details,
    ladder.cta,
    ...(ladder.adOffers || []).flatMap((a) => [
      a.offer,
      a.hook,
      a.sampleCopy,
    ]),
  ]);

  if (ctx.override?.enabled) {
    const seek = `${ctx.override.seekCompetitors || ""} ${ctx.override.notes || ""}`.toLowerCase();
    const allowCourses = /course|podcast|masterclass|academy/.test(seek);
    const patterns = compile(
      sop.offerRejectPatterns.filter((p) => {
        if (allowCourses && /course|podcast|masterclass|bootcamp/i.test(p))
          return false;
        return true;
      }),
    );
    const hit = matchesAny(text, patterns);
    if (hit && !allowCourses) {
      return {
        ok: false,
        reason: `SOP exclude offer: /${hit}/`,
        source: "heuristic",
        sopId: sop.id,
      };
    }
    return {
      ok: true,
      reason: "Override active for offers",
      source: "override_pass",
      sopId: sop.id,
    };
  }

  const hit = matchesAny(text, compile(sop.offerRejectPatterns));
  if (hit) {
    return {
      ok: false,
      reason: `Industry SOP (${sop.label}) rejected offer ladder: matched /${hit}/`,
      source: "heuristic",
      sopId: sop.id,
    };
  }

  // Keyword relevance: if we have service keywords, require at least a weak overlap
  // unless education SOP (courses may be the product).
  const keywords = (ctx.searchKeywords || [])
    .map((k) => k.toLowerCase().trim())
    .filter((k) => k.length >= 3)
    .slice(0, 12);
  if (keywords.length && sop.id !== "education") {
    const lower = text.toLowerCase();
    const hitKw = keywords.some((k) => lower.includes(k));
    const offeringHit = (ctx.offerings || []).some((o) =>
      lower.includes(String(o).toLowerCase().slice(0, 24)),
    );
    if (!hitKw && !offeringHit) {
      // Soft fail only when clearly promotional media
      if (/podcast|masterclass|online course|bootcamp/i.test(text)) {
        return {
          ok: false,
          reason: "Offer looks like media/education, not the service keywords",
          source: "heuristic",
          sopId: sop.id,
        };
      }
    }
  }

  return {
    ok: true,
    reason: `Passed ${sop.label} offer SOP`,
    source: "sop",
    sopId: sop.id,
  };
}

export function filterOfferLaddersWithGuardrail<T extends LookupCoreOfferLadder>(
  ctx: GuardrailContext,
  ladders: T[],
): { kept: T[]; rejected: Array<{ ladder: T; reason: string }> } {
  const kept: T[] = [];
  const rejected: Array<{ ladder: T; reason: string }> = [];
  for (const ladder of ladders) {
    const d = guardOfferLadderHeuristic(ctx, ladder);
    if (d.ok) kept.push(ladder);
    else rejected.push({ ladder, reason: d.reason });
  }
  // Re-rank
  return {
    kept: kept.map((l, i) => ({ ...l, rank: i + 1 })),
    rejected,
  };
}

/**
 * Optional LLM check for borderline competitors (used sparingly).
 * Prefer heuristics; only call when override seeks something unusual
 * or heuristic is inconclusive and caller opts in.
 */
export async function guardCompetitorLlm(
  ctx: GuardrailContext,
  candidate: {
    pageName: string;
    adText?: string | null;
  },
): Promise<GuardrailDecision | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const sop = getSopForContext(ctx);
  try {
    const client = getDirectOpenAIClient();
    const completion = await client.chat.completions.create({
      model: process.env.OFFERS_OPENAI_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 180,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a competitor-relevance guardrail for industry SOPs.
Industry SOP: ${sop.label}
Include: ${sop.includeCompetitorTypes.join("; ")}
Exclude: ${sop.excludeCompetitorTypes.join("; ")}
Guidance: ${sop.llmGuidance}
${
  ctx.override?.enabled
    ? `User override seek: ${ctx.override.seekCompetitors || "(none)"}. Notes: ${ctx.override.notes || "(none)"}. Prefer the override when explicit.`
    : "Enforce SOP strictly."
}
Return JSON: { "ok": boolean, "reason": string }`,
        },
        {
          role: "user",
          content: JSON.stringify({
            clientIndustry: ctx.industry,
            keywords: ctx.searchKeywords?.slice(0, 8),
            competitorName: candidate.pageName,
            adText: (candidate.adText || "").slice(0, 1200),
          }),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as { ok?: boolean; reason?: string };
    return {
      ok: Boolean(parsed.ok),
      reason: parsed.reason || (parsed.ok ? "LLM pass" : "LLM reject"),
      source: "llm",
      sopId: sop.id,
    };
  } catch (err) {
    if (isCreditError(err)) throw err;
    return null;
  }
}

export function listIndustrySopSummaries() {
  return INDUSTRY_SOPS.map((s) => ({
    id: s.id,
    label: s.label,
    includeCompetitorTypes: s.includeCompetitorTypes,
    excludeCompetitorTypes: s.excludeCompetitorTypes,
    excludeOfferTypes: s.excludeOfferTypes,
  }));
}
