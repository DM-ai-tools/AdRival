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

export async function dispatchPlatformLookup(
  lookupId: string,
  queryName: string,
  platform: AdPlatform,
  forcedCandidate?: import("../types").LookupPageCandidate | null,
  options?: LookupDispatchOptions,
) {
  if (isMetaPlatform(platform)) {
    await runCompetitorLookup(
      lookupId,
      queryName,
      platform,
      forcedCandidate,
      options,
    );
    return;
  }
  if (isGoogleFamily(platform)) {
    await runGoogleFamilyLookup(
      lookupId,
      queryName,
      platform as "google" | "youtube",
      forcedCandidate,
      options,
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInLookup(lookupId, queryName, forcedCandidate, options);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
