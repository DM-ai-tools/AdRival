import type { AdPlatform } from "../platforms";
import { isGoogleFamily, isMetaPlatform, parseKeywords } from "../platforms";
import { runCompetitorSearch } from "./finder";
import { runCompetitorLookup } from "./lookup";
import {
  runGoogleFamilyLookup,
  runGoogleFamilySearch,
} from "./googleSearch";
import { runLinkedInLookup, runLinkedInSearch } from "./linkedinSearch";

export async function dispatchPlatformSearch(
  jobId: string,
  keywordInput: string | string[],
  platform: AdPlatform,
  options?: {
    geo?: string;
    businessProfile?: import("../types").BusinessProfile | null;
    businessUrl?: string | null;
  },
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

export async function dispatchPlatformLookup(
  lookupId: string,
  queryName: string,
  platform: AdPlatform,
  forcedCandidate?: import("../types").LookupPageCandidate | null,
) {
  if (isMetaPlatform(platform)) {
    await runCompetitorLookup(lookupId, queryName, platform, forcedCandidate);
    return;
  }
  if (isGoogleFamily(platform)) {
    await runGoogleFamilyLookup(
      lookupId,
      queryName,
      platform as "google" | "youtube",
      forcedCandidate,
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInLookup(lookupId, queryName, forcedCandidate);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
