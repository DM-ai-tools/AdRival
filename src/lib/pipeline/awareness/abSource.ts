import {
  getCompetitorsByRun,
  getJob,
  getLookupAds,
  getLookupJob,
  listLookupJobs,
} from "../../db";
import type { BusinessProfile, LookupAdRecord, ProjectKind } from "../../types";
import { buildAbPages, mergeOfferPages, type AbPage } from "./abPages";

export type AbSource = {
  pages: AbPage[];
  profile: BusinessProfile | null;
  businessUrl: string | null;
  keywords: string[];
};

/** Loads the page list and business context for a search or lookup, or null when it does not exist. */
export async function loadAbSource(kind: ProjectKind, id: string): Promise<AbSource | null> {
  if (kind === "lookup") {
    const job = await getLookupJob(id);
    if (!job) return null;
    const profile = job.businessProfile ?? null;
    return {
      pages: buildAbPages({ lookupAds: await getLookupAds(id) }),
      profile,
      businessUrl: job.businessUrl ?? profile?.url ?? null,
      keywords: [job.queryName].filter(Boolean),
    };
  }
  const job = await getJob(id);
  if (!job) return null;
  const profile = job.businessProfile ?? null;
  // The offers dashboard keeps its analysed pages under hidden lookups named after the run.
  const prefix = `search-offers:${id}:`;
  const offerAds: LookupAdRecord[] = [];
  for (const j of (await listLookupJobs(Number.MAX_SAFE_INTEGER)).filter((j) => j.id.startsWith(prefix))) {
    offerAds.push(...(await getLookupAds(j.id)));
  }
  return {
    pages: mergeOfferPages(buildAbPages({ competitors: await getCompetitorsByRun(id) }), offerAds),
    profile,
    businessUrl: job.businessUrl ?? profile?.url ?? null,
    keywords: job.keywords?.length ? job.keywords : [job.keyword].filter(Boolean),
  };
}
