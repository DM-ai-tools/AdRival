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
) {
  const keywords = parseKeywords(keywordInput);
  if (keywords.length === 0) {
    throw new Error("At least one keyword is required");
  }

  if (isMetaPlatform(platform)) {
    await runCompetitorSearch(jobId, keywords, platform);
    return;
  }
  if (isGoogleFamily(platform)) {
    await runGoogleFamilySearch(
      jobId,
      keywords,
      platform as "google" | "youtube",
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInSearch(jobId, keywords);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

export async function dispatchPlatformLookup(
  lookupId: string,
  queryName: string,
  platform: AdPlatform,
) {
  if (isMetaPlatform(platform)) {
    await runCompetitorLookup(lookupId, queryName, platform);
    return;
  }
  if (isGoogleFamily(platform)) {
    await runGoogleFamilyLookup(
      lookupId,
      queryName,
      platform as "google" | "youtube",
    );
    return;
  }
  if (platform === "linkedin") {
    await runLinkedInLookup(lookupId, queryName);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
