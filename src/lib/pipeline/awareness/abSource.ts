import {
  getCompetitorsByRun,
  getJob,
  getLookupAds,
  getLookupJob,
  listLookupJobs,
} from "../../db";
import type { BusinessProfile, ProjectKind } from "../../types";
import { buildAbPages, mergeOfferPages, type AbPage } from "./abPages";

export type AbSource = {
  pages: AbPage[];
  profile: BusinessProfile | null;
  businessUrl: string | null;
  keywords: string[];
};

/** Loads the page list and business context for a search or lookup, or null when it does not exist. */
export function loadAbSource(kind: ProjectKind, id: string): AbSource | null {
  if (kind === "lookup") {
    const job = getLookupJob(id);
    if (!job) return null;
    const profile = job.businessProfile ?? null;
    return {
      pages: buildAbPages({ lookupAds: getLookupAds(id) }),
      profile,
      businessUrl: job.businessUrl ?? profile?.url ?? null,
      keywords: [job.queryName].filter(Boolean),
    };
  }
  const job = getJob(id);
  if (!job) return null;
  const profile = job.businessProfile ?? null;
  // The offers dashboard keeps its analysed pages under hidden lookups named after the run.
  const prefix = `search-offers:${id}:`;
  const offerAds = listLookupJobs(Number.MAX_SAFE_INTEGER)
    .filter((j) => j.id.startsWith(prefix))
    .flatMap((j) => getLookupAds(j.id));
  return {
    pages: mergeOfferPages(buildAbPages({ competitors: getCompetitorsByRun(id) }), offerAds),
    profile,
    businessUrl: job.businessUrl ?? profile?.url ?? null,
    keywords: job.keywords?.length ? job.keywords : [job.keyword].filter(Boolean),
  };
}
