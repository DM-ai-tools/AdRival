import OpenAI from "openai";
import { z } from "zod";
import { getDirectOpenAIClient } from "../openrouter/openaiCompat";
import {
  getLookupAds,
  getLookupJob,
  isLookupJobSuppressed,
  saveLookupJob,
} from "../db";
import type {
  FunnelStage,
  LookupAdRecord,
  LookupCoreOfferLadder,
  LookupJob,
  LookupOfferAdLeaf,
  LookupOffersReport,
  LookupServiceOfferingNode,
  LookupUniqueAdCreative,
  LookupUniqueLandingPage,
  LookupUniqueOfferLine,
  OfferTicketTier,
} from "../types";
import { analyzeLookupAdLandingPage } from "./landingPageAnalysis";
import {
  cheapLocationFromText,
  resolveAndMatchCompetitorLocation,
} from "./competitorLocation";
import {
  extractAdHook,
  landingPageMatchKey,
  preferDestinationUrl,
} from "./sameLandingPageAds";
import {
  buildGuardrailContext,
  filterOfferLaddersWithGuardrail,
} from "../guardrails";

function getOffersLlmClient(): {
  client: OpenAI;
  model: string;
} | null {
  // Offers dashboard uses direct OpenAI (not OpenRouter).
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) {
    return {
      client: getDirectOpenAIClient(),
      model: process.env.OFFERS_OPENAI_MODEL?.trim() || "gpt-4o-mini",
    };
  }
  return null;
}

const MAX_LP_TO_ANALYZE = 8;
const MAX_CREATIVE_CLUSTERS = 40;
const LP_CONCURRENCY = 2;

type OffersProgressHook = (update: {
  phase: string;
  done: number;
  total: number;
  currentName?: string | null;
  message: string;
  pct: number;
}) => void;

const offerProgressHooks = new Map<string, OffersProgressHook>();

function normalizeCopy(title: string, body: string): string {
  return `${title || ""}\n${body || ""}`
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

function fingerprint(s: string): string {
  return s.slice(0, 160);
}

function heuristicOffer(
  title?: string | null,
  body?: string | null,
  cta?: string | null,
): string {
  const blob = `${title || ""} ${body || ""}`.replace(/\s+/g, " ").trim();
  const price =
    blob.match(
      /(?:\$|₹|£|€|AUD\s*|USD\s*)\s?\d[\d,]*(?:\.\d+)?(?:\s*\/\s*(?:mo|month|yr|year))?/i,
    )?.[0] || null;
  const free = /\b(free\s+(?:audit|consult|quote|trial|assessment)|complimentary)\b/i.exec(
    blob,
  )?.[0];
  const bits = [free, price, cta].filter(Boolean);
  if (bits.length) return bits.join(" · ");
  if (blob.length >= 20) return blob.slice(0, 140) + (blob.length > 140 ? "…" : "");
  return cta || "See ad creative";
}

function heuristicFunnelStage(
  title?: string | null,
  body?: string | null,
  cta?: string | null,
  offer?: string | null,
): FunnelStage {
  const blob = `${title || ""} ${body || ""} ${cta || ""} ${offer || ""}`.toLowerCase();
  if (
    /\b(buy now|shop now|order now|get started|apply now|book a call|book now|claim offer|limited time|last chance|checkout|sign up today|enroll)\b/i.test(
      blob,
    )
  ) {
    return "BOFU";
  }
  if (
    /\b(free audit|free consult|free quote|demo|webinar|case study|assessment|quiz|comparison|how it works|speak to|talk to|schedule)\b/i.test(
      blob,
    )
  ) {
    return "MOFU";
  }
  if (
    /\b(tips|guide|learn|discover|awareness|ebook|checklist|what is|why you|mistakes|ideas|inspiration)\b/i.test(
      blob,
    )
  ) {
    return "TOFU";
  }
  if (/\b(free)\b/i.test(blob) && !/\b(buy|order|checkout)\b/i.test(blob)) {
    return "TOFU";
  }
  return "unknown";
}

function heuristicService(
  title?: string | null,
  body?: string | null,
  offer?: string | null,
): string | null {
  const blob = `${title || ""} ${body || ""} ${offer || ""}`.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\b(car loan|vehicle finance|auto loan)\b/i, "Car / vehicle finance"],
    [/\b(home loan|mortgage|refinanc)\b/i, "Home loans"],
    [/\b(business loan|commercial loan|equipment finance)\b/i, "Business finance"],
    [/\b(google ads|ppc|paid search)\b/i, "Google Ads"],
    [/\b(seo|search engine)\b/i, "SEO"],
    [/\b(social media|facebook ads|meta ads|instagram ads)\b/i, "Social ads"],
    [/\b(dental|implants|invisalign|teeth|orthodont)\b/i, "Dental"],
    [/\b(loan|finance|lending)\b/i, "Lending / finance"],
  ];
  for (const [re, label] of rules) {
    if (re.test(blob)) return label;
  }
  return null;
}

function heuristicTicketTier(
  offer?: string | null,
  pricing?: string | null,
  cta?: string | null,
): OfferTicketTier {
  const blob = `${offer || ""} ${pricing || ""} ${cta || ""}`.toLowerCase();
  if (/\b(free|complimentary|\$0|lead magnet|checklist|ebook|guide)\b/i.test(blob)) {
    return "low";
  }
  if (
    /\b(enterprise|custom quote|premium|retainer|high[- ]ticket|\$\s?[1-9]\d{3,})\b/i.test(
      blob,
    )
  ) {
    return "high";
  }
  if (/\b(\$\s?\d{2,3}|\/mo|\/month|package|starter)\b/i.test(blob)) {
    return "mid";
  }
  return "unknown";
}

function normalizeOfferKey(offer: string): string {
  return offer
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function normalizeServiceKey(service: string): string {
  return service
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type CreativeCluster = {
  id: string;
  key: string;
  ads: LookupAdRecord[];
  title: string;
  body: string;
  cta: string | null;
  landingPageUrl: string | null;
};

function clusterAdCreatives(
  ads: LookupAdRecord[],
  maxClusters = MAX_CREATIVE_CLUSTERS,
): CreativeCluster[] {
  const buckets = new Map<string, CreativeCluster>();
  for (const ad of ads) {
    const key = fingerprint(normalizeCopy(ad.title, ad.body));
    if (!key || key.length < 8) continue;
    const existing = buckets.get(key);
    if (existing) {
      existing.ads.push(ad);
      continue;
    }
    buckets.set(key, {
      id: `c${buckets.size}`,
      key,
      ads: [ad],
      title: ad.title,
      body: ad.body,
      cta: ad.ctaText || null,
      landingPageUrl: ad.landingPageUrl || ad.youtubeUrl || null,
    });
  }
  return [...buckets.values()]
    .sort((a, b) => b.ads.length - a.ads.length)
    .slice(0, maxClusters);
}

type CreativeEnrichment = {
  hook: string;
  offer: string;
  cta: string | null;
  serviceTargeted: string | null;
  funnelStage: FunnelStage;
};

const creativeLlmSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      hook: z.string(),
      offer: z.string(),
      cta: z.string().nullable().optional(),
      serviceTargeted: z.string().nullable().optional(),
      funnelStage: z.enum(["TOFU", "MOFU", "BOFU", "unknown"]).optional(),
    }),
  ),
});

async function enrichCreativeClusters(
  clusters: CreativeCluster[],
): Promise<Map<string, CreativeEnrichment>> {
  const map = new Map<string, CreativeEnrichment>();
  for (const c of clusters) {
    const offer = heuristicOffer(c.title, c.body, c.cta);
    map.set(c.id, {
      hook: extractAdHook(c.title, c.body),
      offer,
      cta: c.cta,
      serviceTargeted: heuristicService(c.title, c.body, offer),
      funnelStage: heuristicFunnelStage(c.title, c.body, c.cta, offer),
    });
  }
  const llm = getOffersLlmClient();
  if (!llm || clusters.length === 0) return map;

  try {
    const completion = await llm.client.chat.completions.create({
      model: llm.model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You analyze advertising creatives for a competitor lookup report.
For each creative cluster extract:
- hook: attention-grabbing opening / pain / curiosity (1 short sentence)
- offer: what they promise or sell (deal, service, price, freebie) — 1 short phrase
- cta: call-to-action button/text if present (or null)
- serviceTargeted: the product/service category being sold (short label)
- funnelStage: TOFU (awareness), MOFU (consideration/lead magnet), BOFU (conversion), or unknown
Keep wording concrete. Do not invent prices not in the copy.
Return JSON: { "items": [{ "id", "hook", "offer", "cta", "serviceTargeted", "funnelStage" }] }`,
        },
        {
          role: "user",
          content: JSON.stringify({
            creatives: clusters.map((c) => ({
              id: c.id,
              title: c.title,
              body: (c.body || "").slice(0, 500),
              cta: c.cta,
              adCount: c.ads.length,
            })),
          }),
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return map;
    const parsed = creativeLlmSchema.safeParse(JSON.parse(match[0]));
    if (!parsed.success) return map;
    for (const item of parsed.data.items) {
      if (!item.id) continue;
      const prev = map.get(item.id);
      const offer = (item.offer || "").trim() || prev?.offer || "—";
      map.set(item.id, {
        hook: (item.hook || "").trim() || prev?.hook || "—",
        offer,
        cta: (item.cta || "").trim() || prev?.cta || null,
        serviceTargeted:
          (item.serviceTargeted || "").trim() || prev?.serviceTargeted || null,
        funnelStage: item.funnelStage || prev?.funnelStage || "unknown",
      });
    }
  } catch (err) {
    console.warn("[lookupOffersReport] creative LLM failed", err);
  }
  return map;
}

function dedupeOfferLines(
  lines: Array<{
    offer: string;
    source: LookupUniqueOfferLine["source"];
    adCount: number;
    urls?: string[];
    sampleHooks?: string[];
    funnelStage?: FunnelStage;
    ticketTier?: OfferTicketTier;
    cta?: string | null;
    pricing?: string | null;
  }>,
): LookupUniqueOfferLine[] {
  const byKey = new Map<string, LookupUniqueOfferLine>();
  for (const line of lines) {
    const offer = (line.offer || "").trim();
    if (!offer || offer === "—" || offer.length < 4) continue;
    const key = normalizeOfferKey(offer);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        offer,
        source: line.source,
        adCount: line.adCount,
        urls: line.urls ? [...line.urls] : undefined,
        sampleHooks: line.sampleHooks ? [...line.sampleHooks] : undefined,
        funnelStage: line.funnelStage,
        ticketTier: line.ticketTier,
        cta: line.cta ?? null,
        pricing: line.pricing ?? null,
      });
      continue;
    }
    prev.adCount += line.adCount;
    if (line.source !== prev.source) prev.source = "both";
    if (line.urls?.length) {
      prev.urls = [...new Set([...(prev.urls || []), ...line.urls])];
    }
    if (line.sampleHooks?.length) {
      prev.sampleHooks = [
        ...new Set([...(prev.sampleHooks || []), ...line.sampleHooks]),
      ].slice(0, 4);
    }
    if (!prev.cta && line.cta) prev.cta = line.cta;
    if (!prev.pricing && line.pricing) prev.pricing = line.pricing;
    if ((!prev.funnelStage || prev.funnelStage === "unknown") && line.funnelStage) {
      prev.funnelStage = line.funnelStage;
    }
    if ((!prev.ticketTier || prev.ticketTier === "unknown") && line.ticketTier) {
      prev.ticketTier = line.ticketTier;
    }
  }
  return [...byKey.values()].sort((a, b) => b.adCount - a.adCount);
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return out;
}

type LpBucket = {
  matchKey: string;
  url: string;
  ads: LookupAdRecord[];
};

function mostCommonDestinationUrl(ads: LookupAdRecord[]): string {
  const counts = new Map<string, number>();
  for (const ad of ads) {
    const url = (ad.landingPageUrl || ad.youtubeUrl || "").trim();
    if (!url) continue;
    counts.set(url, (counts.get(url) || 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || b[0].length - a[0].length,
    )[0]?.[0] ||
    ads[0]?.landingPageUrl ||
    ads[0]?.youtubeUrl ||
    ""
  );
}

function clusterLandingPages(ads: LookupAdRecord[]): LpBucket[] {
  const buckets = new Map<string, LpBucket>();
  for (const ad of ads) {
    const url = ad.landingPageUrl || ad.youtubeUrl || null;
    const key = landingPageMatchKey(url);
    if (!key || !url) continue;
    // Skip ad-library destinations
    if (
      /facebook\.com\/ads\/library|adstransparency\.google|linkedin\.com\/ad-library/i.test(
        key,
      )
    ) {
      continue;
    }
    const existing = buckets.get(key);
    if (existing) {
      existing.ads.push(ad);
      continue;
    }
    buckets.set(key, { matchKey: key, url, ads: [ad] });
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, url: mostCommonDestinationUrl(b.ads) || b.url }))
    .sort((a, b) => b.ads.length - a.ads.length);
}

function creativeToLeaf(
  c: LookupUniqueAdCreative,
  overrides?: Partial<LookupOfferAdLeaf>,
): LookupOfferAdLeaf {
  return {
    creativeId: c.id,
    hook: c.hook,
    offer: c.offer,
    cta: c.cta ?? null,
    serviceTargeted: c.serviceTargeted ?? null,
    funnelStage: c.funnelStage || "unknown",
    adCount: c.adCount,
    sampleAdIds: c.sampleAdIds,
    sampleCopy: c.sampleCopy,
    landingPageUrl: c.landingPageUrl ?? null,
    ...overrides,
  };
}

function attachAdsToPages(
  pages: LookupUniqueLandingPage[],
  creatives: LookupUniqueAdCreative[],
  lpBuckets: LpBucket[],
): LookupUniqueLandingPage[] {
  const creativesByAdId = new Map<string, LookupUniqueAdCreative>();
  for (const c of creatives) {
    for (const id of c.sampleAdIds) creativesByAdId.set(id, c);
  }

  return pages.map((page) => {
    const bucket = lpBuckets.find((b) => b.matchKey === page.matchKey);
    const pageUrl = preferDestinationUrl(bucket?.url || page.url, page.url);
    const seen = new Map<string, LookupOfferAdLeaf>();

    for (const ad of bucket?.ads || []) {
      const creative = creativesByAdId.get(ad.id);
      if (!creative) continue;
      const existing = seen.get(creative.id);
      if (existing) {
        existing.adCount += 1;
        if (!existing.sampleAdIds.includes(ad.id)) {
          existing.sampleAdIds = [...existing.sampleAdIds, ad.id].slice(0, 8);
        }
        continue;
      }
      seen.set(
        creative.id,
        creativeToLeaf(creative, {
          // Always match the parent destination (not the creative's first-seen LP)
          landingPageUrl: pageUrl,
          adCount: 1,
          sampleAdIds: [ad.id],
        }),
      );
    }

    // Fallback: creatives whose destination matchKey equals this page
    if (seen.size === 0) {
      for (const c of creatives) {
        if (!c.landingPageUrl) continue;
        if (landingPageMatchKey(c.landingPageUrl) !== page.matchKey) continue;
        seen.set(
          c.id,
          creativeToLeaf(c, {
            landingPageUrl: pageUrl,
            adCount: c.adCount,
          }),
        );
      }
    }

    const ads = [...seen.values()].sort((a, b) => b.adCount - a.adCount);
    const serviceVotes = new Map<string, number>();
    const funnelVotes: Partial<Record<FunnelStage, number>> = {};
    for (const a of ads) {
      if (a.serviceTargeted) {
        serviceVotes.set(
          a.serviceTargeted,
          (serviceVotes.get(a.serviceTargeted) || 0) + a.adCount,
        );
      }
      const fs = a.funnelStage || "unknown";
      funnelVotes[fs] = (funnelVotes[fs] || 0) + a.adCount;
    }
    const topService =
      [...serviceVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const topFunnel =
      ([...Object.entries(funnelVotes)] as Array<[FunnelStage, number]>)
        .filter(([k]) => k !== "unknown")
        .sort((a, b) => b[1] - a[1])[0]?.[0] ||
      page.funnelStage ||
      heuristicFunnelStage(
        page.headline,
        page.primaryOffer,
        page.cta,
        page.primaryOffer,
      );

    return {
      ...page,
      url: pageUrl,
      adCount: bucket?.ads.length ?? page.adCount,
      ads,
      serviceTargeted: topService || page.serviceTargeted || null,
      funnelStage: topFunnel,
    };
  });
}

function buildServiceNodes(
  pages: LookupUniqueLandingPage[],
  creatives: LookupUniqueAdCreative[],
): LookupServiceOfferingNode[] {
  type Acc = {
    service: string;
    adCount: number;
    funnelStages: Partial<Record<FunnelStage, number>>;
    pages: Map<string, LookupServiceOfferingNode["landingPages"][number]>;
  };
  const byService = new Map<string, Acc>();

  const ensure = (service: string) => {
    const key = normalizeServiceKey(service) || "general";
    const label = service.trim() || "General / unspecified";
    let acc = byService.get(key);
    if (!acc) {
      acc = {
        service: label,
        adCount: 0,
        funnelStages: {},
        pages: new Map(),
      };
      byService.set(key, acc);
    }
    return acc;
  };

  for (const page of pages) {
    const leaves = page.ads || [];
    if (leaves.length === 0) {
      const service = page.serviceTargeted || "General / unspecified";
      const acc = ensure(service);
      acc.adCount += page.adCount;
      const fs = page.funnelStage || "unknown";
      acc.funnelStages[fs] = (acc.funnelStages[fs] || 0) + page.adCount;
      if (!acc.pages.has(page.matchKey)) {
        acc.pages.set(page.matchKey, {
          url: page.url,
          matchKey: page.matchKey,
          adCount: page.adCount,
          primaryOffer: page.primaryOffer ?? null,
          funnelStage: page.funnelStage,
          cta: page.cta ?? null,
          ads: [],
        });
      }
      continue;
    }

    for (const leaf of leaves) {
      const service =
        leaf.serviceTargeted || page.serviceTargeted || "General / unspecified";
      const acc = ensure(service);
      acc.adCount += leaf.adCount;
      const fs = leaf.funnelStage || "unknown";
      acc.funnelStages[fs] = (acc.funnelStages[fs] || 0) + leaf.adCount;
      let lp = acc.pages.get(page.matchKey);
      if (!lp) {
        lp = {
          url: page.url,
          matchKey: page.matchKey,
          adCount: 0,
          primaryOffer: page.primaryOffer ?? null,
          funnelStage: page.funnelStage,
          cta: page.cta ?? null,
          ads: [],
        };
        acc.pages.set(page.matchKey, lp);
      }
      lp.adCount += leaf.adCount;
      if (!lp.ads.some((a) => a.creativeId === leaf.creativeId)) {
        lp.ads.push(leaf);
      }
    }
  }

  for (const c of creatives) {
    if (!c.serviceTargeted) continue;
    const key = normalizeServiceKey(c.serviceTargeted);
    if (byService.has(key)) continue;
    const acc = ensure(c.serviceTargeted);
    acc.adCount += c.adCount;
    const fs = c.funnelStage || "unknown";
    acc.funnelStages[fs] = (acc.funnelStages[fs] || 0) + c.adCount;
  }

  return [...byService.values()]
    .map((acc) => ({
      service: acc.service,
      adCount: acc.adCount,
      landingPageCount: acc.pages.size,
      funnelStages: acc.funnelStages,
      landingPages: [...acc.pages.values()]
        .map((p) => ({
          ...p,
          ads: p.ads.sort((a, b) => b.adCount - a.adCount),
        }))
        .sort((a, b) => b.adCount - a.adCount),
    }))
    .sort((a, b) => b.adCount - a.adCount);
}

const EMPTY_LADDER_MSG = "No value ladder found for this core offer";

/**
 * Build one value ladder per unique landing-page (core) offer.
 * Map relevant ad-copy offers under each core; if none map, mark empty.
 */
async function buildValueLadder(input: {
  adOffers: LookupUniqueOfferLine[];
  lpOffers: LookupUniqueOfferLine[];
  creatives: LookupUniqueAdCreative[];
  pages: LookupUniqueLandingPage[];
}): Promise<{
  ladders: LookupCoreOfferLadder[];
  summary: string | null;
}> {
  // Prefer deduped unique LP offers; fall back to completed page primaryOffers
  const coreSources: Array<{
    offer: string;
    adCount: number;
    cta: string | null;
    pricing: string | null;
    funnelStage: FunnelStage;
    ticketTier: OfferTicketTier;
    landingPageUrl: string | null;
    urls: string[];
  }> = [];

  if (input.lpOffers.length > 0) {
    for (const o of input.lpOffers) {
      if (!normalizeOfferKey(o.offer)) continue;
      coreSources.push({
        offer: o.offer,
        adCount: o.adCount,
        cta: o.cta || null,
        pricing: o.pricing || null,
        funnelStage: o.funnelStage || "unknown",
        ticketTier:
          o.ticketTier || heuristicTicketTier(o.offer, o.pricing, o.cta),
        landingPageUrl: o.urls?.[0] || null,
        urls: o.urls || [],
      });
    }
  } else {
    const byKey = new Map<string, (typeof coreSources)[number]>();
    for (const p of input.pages) {
      if (p.status !== "completed" || !p.primaryOffer) continue;
      const key = normalizeOfferKey(p.primaryOffer);
      if (!key) continue;
      const prev = byKey.get(key);
      if (prev) {
        prev.adCount += p.adCount;
        if (p.url && !prev.urls.includes(p.url)) prev.urls.push(p.url);
        continue;
      }
      byKey.set(key, {
        offer: p.primaryOffer,
        adCount: p.adCount,
        cta: p.cta || null,
        pricing: p.pricing || null,
        funnelStage: p.funnelStage || "unknown",
        ticketTier: heuristicTicketTier(p.primaryOffer, p.pricing, p.cta),
        landingPageUrl: p.url,
        urls: [p.url],
      });
    }
    coreSources.push(...byKey.values());
  }

  const tierRank: Record<OfferTicketTier, number> = {
    low: 1,
    mid: 2,
    high: 3,
    unknown: 2,
  };

  const cores = [...coreSources].sort(
    (a, b) =>
      (tierRank[a.ticketTier] || 2) - (tierRank[b.ticketTier] || 2) ||
      b.adCount - a.adCount,
  );

  const pageMatchKeysForCore = (coreKey: string, urls: string[]) => {
    const keys = new Set<string>();
    for (const p of input.pages) {
      if (!p.primaryOffer) continue;
      if (normalizeOfferKey(p.primaryOffer) === coreKey) {
        keys.add(p.matchKey);
      }
    }
    for (const u of urls) {
      const k = landingPageMatchKey(u);
      if (k) keys.add(k);
    }
    return keys;
  };

  const offerTokens = (s: string) =>
    new Set(
      normalizeOfferKey(s)
        .split(" ")
        .filter((t) => t.length > 2),
    );

  const overlapScore = (a: string, b: string) => {
    const ta = offerTokens(a);
    const tb = offerTokens(b);
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit += 1;
    return hit / Math.max(ta.size, tb.size);
  };

  const ladders: LookupCoreOfferLadder[] = cores.map((core, i) => {
    const coreKey = normalizeOfferKey(core.offer);
    const matchKeys = pageMatchKeysForCore(coreKey, core.urls);
    const seen = new Map<string, LookupOfferAdLeaf>();

    // 1) Ads already attached to matching landing pages
    for (const p of input.pages) {
      if (!matchKeys.has(p.matchKey)) continue;
      for (const leaf of p.ads || []) {
        const id = leaf.creativeId || normalizeOfferKey(leaf.offer);
        const prev = seen.get(id);
        if (prev) {
          prev.adCount += leaf.adCount;
          continue;
        }
        seen.set(id, { ...leaf });
      }
    }

    // 2) Creatives whose destination matches core pages
    for (const c of input.creatives) {
      const cKey = c.landingPageUrl
        ? landingPageMatchKey(c.landingPageUrl)
        : null;
      if (cKey && matchKeys.has(cKey)) {
        const id = c.id;
        if (!seen.has(id)) {
          seen.set(
            id,
            creativeToLeaf(c, {
              landingPageUrl: core.landingPageUrl || c.landingPageUrl || null,
            }),
          );
        }
      }
    }

    // 3) Ad-copy unique offers that semantically relate to this core
    //    (and are not already stronger matches for another core — assigned here if overlap ≥ 0.35)
    for (const line of input.adOffers) {
      const score = overlapScore(core.offer, line.offer);
      if (score < 0.35) continue;
      const id = `line:${normalizeOfferKey(line.offer)}`;
      if (seen.has(id)) continue;
      // Prefer URL overlap when available
      const urlHit = (line.urls || []).some((u) => {
        const k = landingPageMatchKey(u);
        return Boolean(k && matchKeys.has(k));
      });
      if (!urlHit && score < 0.5) continue;
      seen.set(id, {
        creativeId: id,
        hook: line.sampleHooks?.[0] || line.offer,
        offer: line.offer,
        cta: line.cta ?? null,
        serviceTargeted: null,
        funnelStage: line.funnelStage || "unknown",
        adCount: line.adCount,
        sampleAdIds: [],
        sampleCopy: null,
        landingPageUrl: line.urls?.[0] || core.landingPageUrl,
      });
    }

    const adOffers = [...seen.values()].sort((a, b) => b.adCount - a.adCount);
    const empty = adOffers.length === 0;

    return {
      id: `core-vl${i}`,
      rank: i + 1,
      coreOffer: core.offer,
      details: empty
        ? EMPTY_LADDER_MSG
        : `${adOffers.length} mapped ad-copy offer${adOffers.length === 1 ? "" : "s"} supporting this landing-page offer.`,
      cta: core.cta,
      ticketTier: core.ticketTier,
      pricing: core.pricing,
      funnelStage: core.funnelStage,
      landingPageUrl: core.landingPageUrl,
      adCount: core.adCount,
      adOffers,
      emptyMessage: empty ? EMPTY_LADDER_MSG : null,
    };
  });

  // Optional LLM polish: short summary + per-core details (does not change structure)
  let summary: string | null =
    ladders.length === 0
      ? "No value ladder found — analyze landing pages to extract core offers."
      : `${ladders.length} core landing-page offer${ladders.length === 1 ? "" : "s"} with mapped ad-copy ladders.`;

  const ladderLlm = getOffersLlmClient();
  if (ladderLlm && ladders.length > 0) {
    try {
      const completion = await ladderLlm.client.chat.completions.create({
        model: ladderLlm.model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You write short summaries for competitive offer value ladders.
Each ladder already has a fixed coreOffer (landing-page offer) and mapped adOffers.
Return JSON: { "summary": string, "detailsByCoreId": { "<id>": "one sentence" } }.
Do not invent new cores. For cores with empty adOffers, details must say they have no mapped ad-copy ladder.`,
          },
          {
            role: "user",
            content: JSON.stringify({
              ladders: ladders.map((l) => ({
                id: l.id,
                coreOffer: l.coreOffer,
                ticketTier: l.ticketTier,
                adOfferCount: l.adOffers.length,
                sampleAdOffers: l.adOffers.slice(0, 4).map((a) => a.offer),
                empty: Boolean(l.emptyMessage),
              })),
            }),
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content || "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = z
          .object({
            summary: z.string().optional(),
            detailsByCoreId: z.record(z.string()).optional(),
          })
          .safeParse(JSON.parse(match[0]));
        if (parsed.success) {
          if (parsed.data.summary?.trim()) {
            summary = parsed.data.summary.trim();
          }
          const map = parsed.data.detailsByCoreId || {};
          for (const ladder of ladders) {
            const d = map[ladder.id]?.trim();
            if (!d) continue;
            if (ladder.emptyMessage) {
              ladder.details = EMPTY_LADDER_MSG;
            } else {
              ladder.details = d;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[lookupOffersReport] value ladder summary LLM failed", err);
    }
  }

  return { ladders, summary };
}

/**
 * Build unique ad-copy + unique landing-page offers report for a lookup job.
 */
export async function buildLookupOffersReport(
  lookupId: string,
  options?: {
    forceReanalyzePages?: boolean;
    maxLandingPages?: number;
    maxCreativeClusters?: number;
  },
): Promise<LookupOffersReport> {
  const now = new Date().toISOString();
  const ads = getLookupAds(lookupId);
  if (ads.length === 0) {
    return {
      status: "failed",
      createdAt: now,
      updatedAt: now,
      error: "No ads to analyze",
      adsAnalyzed: 0,
      adCopy: { uniqueCreatives: 0, creatives: [], uniqueOffers: [] },
      landingPages: {
        uniqueUrls: 0,
        analyzed: 0,
        failed: 0,
        pages: [],
        uniqueOffers: [],
      },
      services: { uniqueServices: 0, nodes: [] },
      valueLadder: { ladders: [], summary: null },
    };
  }

  // Progress units: creatives(1) + each LP analyzed + ladder(1)
  const lpCap = options?.maxLandingPages ?? MAX_LP_TO_ANALYZE;
  const creativeCap = options?.maxCreativeClusters ?? MAX_CREATIVE_CLUSTERS;
  const lpBucketsPreview = clusterLandingPages(ads);
  const lpWorkCount = Math.min(lpBucketsPreview.length, lpCap);
  const totalUnits = 2 + lpWorkCount; // creatives + LPs + ladder
  let doneUnits = 0;

  const tick = (
    phase: string,
    message: string,
    currentName?: string | null,
    advance = 0,
  ) => {
    if (isLookupJobSuppressed(lookupId)) {
      throw new Error("Stopped by user");
    }
    doneUnits = Math.min(totalUnits, doneUnits + advance);
    reportOffersProgress(lookupId, {
      phase,
      done: doneUnits,
      total: totalUnits,
      currentName: currentName ?? null,
      message,
    });
  };

  tick("creatives", "Clustering & enriching unique ad creatives…", null, 0);

  // Deep location for the looked-up advertiser (deferred from ad fetch)
  try {
    const job = getLookupJob(lookupId);
    if (job && !job.internalOnly) {
      const sample = ads[0];
      const website =
        sample?.landingPageUrl ||
        sample?.domain ||
        sample?.advertiserPageUrl ||
        null;
      const provisional = cheapLocationFromText({
        pageName: job.selectedPage?.name || job.queryName,
        adText: `${sample?.title || ""} ${sample?.body || ""}`,
        landingUrl: website,
        targets: [],
        geoMode: "countrywide",
      });
      const locResult = await resolveAndMatchCompetitorLocation({
        pageName: job.selectedPage?.name || job.queryName,
        website,
        facebookUrl: null,
        linkedinUrl: null,
        geoMode: "countrywide",
        targetLocations: [],
        provisional,
        skipPerplexityIfResolved: provisional.locationStatus === "matched",
      });
      const loc = locResult.location;
      patchLookupJob(job, {
        locationLabel: loc.locationLabel,
        locationCity: loc.locationCity,
        locationSuburb: loc.locationSuburb,
        locationCountry: loc.locationCountry,
        locationStatus: loc.locationStatus,
        locationSource: loc.locationSource,
      });
    }
  } catch (err) {
    console.warn("[lookup-offers] location enrich failed", err);
  }

  // —— Ad copy clusters ——
  const clusters = clusterAdCreatives(ads, creativeCap);
  tick(
    "creatives",
    `Enriching ${clusters.length} unique creatives…`,
    `${clusters.length} creatives`,
    0,
  );
  const enriched = await enrichCreativeClusters(clusters);
  tick(
    "creatives",
    `Creative analysis done · ${clusters.length} clusters`,
    null,
    1,
  );
  const creatives: LookupUniqueAdCreative[] = clusters.map((c) => {
    const hit = enriched.get(c.id);
    return {
      id: c.id,
      hook: hit?.hook || extractAdHook(c.title, c.body),
      offer: hit?.offer || heuristicOffer(c.title, c.body, c.cta),
      sampleCopy: `${c.title}${c.body ? ` — ${c.body.slice(0, 160)}` : ""}`.slice(
        0,
        220,
      ),
      adCount: c.ads.length,
      sampleAdIds: c.ads.map((a) => a.id),
      landingPageUrl: c.landingPageUrl,
      cta: hit?.cta ?? c.cta,
      serviceTargeted: hit?.serviceTargeted ?? null,
      funnelStage: hit?.funnelStage || "unknown",
    };
  });

  const adCopyOffers = dedupeOfferLines(
    creatives.map((c) => ({
      offer: c.offer,
      source: "ad_copy" as const,
      adCount: c.adCount,
      sampleHooks: [c.hook],
      urls: c.landingPageUrl ? [c.landingPageUrl] : undefined,
      funnelStage: c.funnelStage,
      ticketTier: heuristicTicketTier(c.offer, null, c.cta),
      cta: c.cta ?? null,
    })),
  );

  // —— Unique landing pages ——
  const lpBuckets = lpBucketsPreview;
  const toAnalyze = lpBuckets.slice(0, lpCap);
  const skipped = lpBuckets.slice(lpCap);

  tick(
    "landing_pages",
    `Analyzing ${toAnalyze.length} unique landing pages…`,
    toAnalyze[0]?.url || null,
    0,
  );

  let lpFinished = 0;
  const analyzedPages = await mapPool(toAnalyze, LP_CONCURRENCY, async (bucket) => {
    if (isLookupJobSuppressed(lookupId)) {
      throw new Error("Stopped by user");
    }
    const label = bucket.url.replace(/^https?:\/\//i, "").slice(0, 48);
    reportOffersProgress(lookupId, {
      phase: "landing_pages",
      done: 1 + lpFinished,
      total: totalUnits,
      currentName: label,
      message: `Analyzing landing page ${lpFinished + 1}/${Math.max(toAnalyze.length, 1)}: ${label}`,
    });

    const representative =
      bucket.ads.find(
        (a) =>
          a.pageAnalysis?.status === "completed" &&
          a.pageAnalysis.offer?.primaryOffer &&
          !options?.forceReanalyzePages,
      ) || bucket.ads[0];

    const finishOne = <T,>(result: T): T => {
      lpFinished += 1;
      reportOffersProgress(lookupId, {
        phase: "landing_pages",
        done: 1 + lpFinished,
        total: totalUnits,
        currentName: label,
        message: `Landing pages ${lpFinished}/${Math.max(toAnalyze.length, 1)} · ${label}`,
      });
      return result;
    };

    // Reuse completed analysis when available
    if (
      !options?.forceReanalyzePages &&
      representative.pageAnalysis?.status === "completed" &&
      representative.pageAnalysis.offer
    ) {
      const o = representative.pageAnalysis.offer;
      return finishOne({
        url: preferDestinationUrl(
          bucket.url,
          representative.pageAnalysis.analyzedUrl,
        ),
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "completed" as const,
        headline: o.headline ?? null,
        primaryOffer: o.primaryOffer,
        pricing: o.pricing ?? null,
        cta: o.cta ?? null,
        uniqueValueProps: o.uniqueValueProps || [],
        summary: representative.pageAnalysis.summary ?? null,
        error: null,
        sampleAdId: representative.id,
        funnelStage: heuristicFunnelStage(
          o.headline,
          o.primaryOffer,
          o.cta,
          o.primaryOffer,
        ),
      } satisfies LookupUniqueLandingPage);
    }

    try {
      const updated = await analyzeLookupAdLandingPage(representative.id);
      const analysis = updated.pageAnalysis;
      const o = analysis?.offer;
      if (!analysis || analysis.status === "failed" || !o?.primaryOffer) {
        return finishOne({
          url: bucket.url,
          matchKey: bucket.matchKey,
          adCount: bucket.ads.length,
          status: "failed" as const,
          primaryOffer: null,
          error:
            analysis?.error || "Landing page analysis returned no offer",
          sampleAdId: representative.id,
        } satisfies LookupUniqueLandingPage);
      }
      return finishOne({
        url: preferDestinationUrl(bucket.url, analysis.analyzedUrl),
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "completed" as const,
        headline: o.headline ?? null,
        primaryOffer: o.primaryOffer,
        pricing: o.pricing ?? null,
        cta: o.cta ?? null,
        uniqueValueProps: o.uniqueValueProps || [],
        summary: analysis.summary ?? null,
        error: null,
        sampleAdId: representative.id,
        funnelStage: heuristicFunnelStage(
          o.headline,
          o.primaryOffer,
          o.cta,
          o.primaryOffer,
        ),
      } satisfies LookupUniqueLandingPage);
    } catch (err) {
      return finishOne({
        url: bucket.url,
        matchKey: bucket.matchKey,
        adCount: bucket.ads.length,
        status: "failed" as const,
        primaryOffer: null,
        error: err instanceof Error ? err.message : String(err),
        sampleAdId: representative.id,
      } satisfies LookupUniqueLandingPage);
    }
  });

  const skippedPages: LookupUniqueLandingPage[] = skipped.map((b) => ({
    url: b.url,
    matchKey: b.matchKey,
    adCount: b.ads.length,
    status: "skipped",
    primaryOffer: null,
    error: `Skipped (analyzed top ${lpCap} destinations by ad volume)`,
    sampleAdId: b.ads[0]?.id || null,
  }));

  const pages = attachAdsToPages(
    [...analyzedPages, ...skippedPages],
    creatives,
    lpBuckets,
  );
  const lpOffers = dedupeOfferLines(
    pages
      .filter((p) => p.status === "completed" && p.primaryOffer)
      .map((p) => ({
        offer: p.primaryOffer!,
        source: "landing_page" as const,
        adCount: p.adCount,
        urls: [p.url],
        sampleHooks: p.headline ? [p.headline] : undefined,
        funnelStage: p.funnelStage,
        ticketTier: heuristicTicketTier(p.primaryOffer, p.pricing, p.cta),
        cta: p.cta ?? null,
        pricing: p.pricing ?? null,
      })),
  );

  const serviceNodes = buildServiceNodes(pages, creatives);
  doneUnits = 1 + toAnalyze.length;
  tick(
    "ladder",
    "Building offer value ladder…",
    "Value ladder",
    0,
  );
  const ladder = await buildValueLadder({
    adOffers: adCopyOffers,
    lpOffers,
    creatives,
    pages,
  });
  const lookupJob = getLookupJob(lookupId);
  const guardCtx = buildGuardrailContext({
    businessProfile: lookupJob?.businessProfile || null,
    searchKeywords: null,
    skipGuardrails: false,
  });
  const filteredLadders = filterOfferLaddersWithGuardrail(
    guardCtx,
    ladder.ladders,
  );
  const ladderSummary = [
    ladder.summary,
    filteredLadders.rejected.length
      ? `Guardrail removed ${filteredLadders.rejected.length} off-SOP ladder${filteredLadders.rejected.length === 1 ? "" : "s"}.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  tick("ladder", "Offer value ladder ready", null, 1);

  const analyzedCount = pages.filter((p) => p.status === "completed").length;
  const failedCount = pages.filter((p) => p.status === "failed").length;

  const summary = [
    `${ads.length} ads`,
    `${creatives.length} unique creatives`,
    `${adCopyOffers.length} unique ad offers`,
    `${lpBuckets.length} unique landing pages`,
    `${analyzedCount} LPs analyzed`,
    `${serviceNodes.length} services`,
    `${filteredLadders.kept.length} core offer ladders`,
  ].join(" · ");

  return {
    status: "completed",
    createdAt: now,
    updatedAt: new Date().toISOString(),
    error: null,
    summary,
    adsAnalyzed: ads.length,
    adCopy: {
      uniqueCreatives: creatives.length,
      creatives,
      uniqueOffers: adCopyOffers,
    },
    landingPages: {
      uniqueUrls: lpBuckets.length,
      analyzed: analyzedCount,
      failed: failedCount,
      pages,
      uniqueOffers: lpOffers,
    },
    services: {
      uniqueServices: serviceNodes.length,
      nodes: serviceNodes,
    },
    valueLadder: {
      ladders: filteredLadders.kept,
      summary: ladderSummary,
    },
  };
}

function patchLookupJob(job: LookupJob, patch: Partial<LookupJob>) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  saveLookupJob(job);
}

function reportOffersProgress(
  lookupId: string,
  update: {
    phase: string;
    done: number;
    total: number;
    currentName?: string | null;
    message: string;
  },
) {
  const job = getLookupJob(lookupId);
  if (!job) return;
  const pct = Math.min(
    100,
    Math.round((update.done / Math.max(update.total, 1)) * 100),
  );
  patchLookupJob(job, {
    status: "running",
    progress: {
      ...job.progress,
      stage: "analyzing_offers",
      message: update.message,
      offersPhase: update.phase,
      offersDone: update.done,
      offersTotal: update.total,
      offersCurrentName: update.currentName ?? null,
      offersPct: pct,
    },
  });
  offerProgressHooks.get(lookupId)?.({
    phase: update.phase,
    done: update.done,
    total: update.total,
    currentName: update.currentName ?? null,
    message: update.message,
    pct,
  });
}

/**
 * Run after ads are fetched: analyze unique creatives + LPs, persist on the job.
 * Keeps status "running" until the report finishes so the client keeps polling.
 */
export async function runLookupOffersReportPhase(
  lookupId: string,
  options?: {
    force?: boolean;
    /** Final job status after report (default completed if ads exist) */
    finalStatus?: "completed" | "partial";
    maxLandingPages?: number;
    maxCreativeClusters?: number;
    onProgress?: OffersProgressHook;
  },
): Promise<LookupJob | null> {
  const job = getLookupJob(lookupId);
  if (!job) return null;
  if (isLookupJobSuppressed(lookupId)) return job;
  if (options?.onProgress) offerProgressHooks.set(lookupId, options.onProgress);

  try {
    const ads = getLookupAds(lookupId);
    const finalStatus =
      options?.finalStatus || (ads.length > 0 ? "completed" : "partial");

    if (
      !options?.force &&
      job.offersReport?.status === "completed" &&
      job.offersReport.adsAnalyzed === ads.length
    ) {
      patchLookupJob(job, {
        status: finalStatus,
        progress: {
          ...job.progress,
          stage: "done",
          adsFetched: ads.length,
          message:
            job.progress.message ||
            `Loaded ${ads.length} ads · offers report ready.`,
        },
      });
      return getLookupJob(lookupId);
    }

    const pending: LookupOffersReport = {
      status: "pending",
      createdAt: job.offersReport?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
      adsAnalyzed: ads.length,
      adCopy: { uniqueCreatives: 0, creatives: [], uniqueOffers: [] },
      landingPages: {
        uniqueUrls: 0,
        analyzed: 0,
        failed: 0,
        pages: [],
        uniqueOffers: [],
      },
    };

    const lpCap = options?.maxLandingPages ?? MAX_LP_TO_ANALYZE;
    patchLookupJob(job, {
      status: "running",
      offersReport: pending,
      progress: {
        ...job.progress,
        stage: "analyzing_offers",
        adsFetched: ads.length,
        message: `Analyzing ${ads.length} ad copies and unique landing pages for offers…`,
        offersPhase: "starting",
        offersDone: 0,
        offersTotal: Math.max(
          3,
          Math.min(clusterLandingPages(ads).length, lpCap) + 2,
        ),
        offersCurrentName: null,
        offersPct: 2,
      },
    });

    try {
      const report = await buildLookupOffersReport(lookupId, {
        forceReanalyzePages: Boolean(options?.force),
        maxLandingPages: options?.maxLandingPages,
        maxCreativeClusters: options?.maxCreativeClusters,
      });
      const offerCount =
        report.adCopy.uniqueOffers.length +
        report.landingPages.uniqueOffers.length;
      patchLookupJob(job, {
        status: finalStatus,
        offersReport: report,
        progress: {
          ...job.progress,
          stage: "done",
          adsFetched: ads.length,
          message:
            ads.length > 0
              ? `Loaded ${ads.length} ads · ${offerCount} unique offers across creatives & landing pages.`
              : job.progress.message,
          offersPhase: "done",
          offersDone: job.progress.offersTotal || 1,
          offersTotal: job.progress.offersTotal || 1,
          offersCurrentName: null,
          offersPct: 100,
        },
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      patchLookupJob(job, {
        status: finalStatus,
        offersReport: {
          ...pending,
          status: "failed",
          updatedAt: new Date().toISOString(),
          error: message,
        },
        progress: {
          ...job.progress,
          stage: "done",
          adsFetched: ads.length,
          message: `Loaded ${ads.length} ads · offers analysis failed: ${message}`,
        },
      });
    }

    return getLookupJob(lookupId);
  } finally {
    offerProgressHooks.delete(lookupId);
  }
}
