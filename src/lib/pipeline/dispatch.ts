import type { AdPlatform } from "../platforms";
import { isGoogleFamily, isMetaPlatform, parseKeywords } from "../platforms";
import { runCompetitorSearch } from "./finder";
import { runCompetitorLookup } from "./lookup";
import {
  runGoogleFamilyLookup,
  runGoogleFamilySearch,
} from "./googleSearch";
import { runLinkedInLookup, runLinkedInSearch } from "./linkedinSearch";
import type { SearchDispatchOptions } from "./searchOptions";
import { resolveCompetitorIdentity } from "./competitorIdentity";
import { updateLookupJob } from "../db";
import { isCreditError } from "../accounting/errors";
import { getLinkedInCompany } from "../sociavault/client";
import type { LookupIdentity } from "../types";

export async function dispatchPlatformSearch(
  jobId: string,
  keywordInput: string | string[],
  platform: AdPlatform,
  options?: SearchDispatchOptions,
) {
  const keywords = parseKeywords(keywordInput);
  if (keywords.length === 0) {
    throw new Error("At least one keyword is required");
  }

  if (isMetaPlatform(platform)) {
    await runCompetitorSearch(jobId, keywords, platform, options);
    return;
  }
  if (isGoogleFamily(platform)) {
    await runGoogleFamilySearch(
      jobId,
      keywords,
      platform as "google" | "youtube",
      options,
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInSearch(jobId, keywords, options);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export type LookupDispatchOptions = {
  businessUrl?: string | null;
  businessProfile?: import("../types").BusinessProfile | null;
};

/**
 * A lookup accepts a name, a website or a Facebook, Instagram or LinkedIn
 * link. It is resolved once to the competitor's name, website and pages,
 * then each ad library is searched with what it finds best.
 */
export async function dispatchPlatformLookup(
  lookupId: string,
  queryName: string,
  platform: AdPlatform,
  forcedCandidate?: import("../types").LookupPageCandidate | null,
  options?: LookupDispatchOptions,
) {
  let identity: LookupIdentity | null = null;
  // A match the user picked by hand is used as it is.
  if (!forcedCandidate) {
    updateLookupJob(lookupId, {
      progress: {
        stage: "searching_pages",
        message: `Working out who "${queryName}" is (name, website and pages)…`,
        candidatesFound: 0,
        adsFetched: 0,
        pagesScanned: 0,
      },
    });
    try {
      identity = await resolveCompetitorIdentity(queryName);
      updateLookupJob(lookupId, { resolvedIdentity: identity });
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.warn("[lookup] could not resolve the competitor; searching the text as typed", (err as Error).message);
    }
  }

  if (isMetaPlatform(platform)) {
    await runCompetitorLookup(
      lookupId,
      identity?.name || queryName,
      platform,
      forcedCandidate,
      { ...options, identity },
    );
    return;
  }
  if (isGoogleFamily(platform)) {
    // Google lists many advertisers under a legal name; the website domain finds them reliably.
    await runGoogleFamilyLookup(
      lookupId,
      identity?.domain || identity?.name || queryName,
      platform as "google" | "youtube",
      forcedCandidate,
      options,
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInLookup(lookupId, await linkedInCompanyName(identity, queryName), forcedCandidate, options);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/** The company name exactly as LinkedIn shows it, from the company page when one is known. */
async function linkedInCompanyName(identity: LookupIdentity | null, typed: string): Promise<string> {
  if (!identity) return typed;
  if (identity.linkedinName) return identity.linkedinName;
  if (identity.linkedinUrl) {
    try {
      const name = (await getLinkedInCompany(identity.linkedinUrl)).data?.name?.trim();
      if (name) return name;
    } catch (err) {
      if (isCreditError(err)) throw err;
    }
  }
  return identity.name || typed;
}
