import assert from "node:assert/strict";
import test from "node:test";
import {
  analysisSetupMessage,
  analyzeBusinessProfile,
  type BusinessProfileSteps,
} from "../src/lib/pipeline/businessProfile";
import { InsufficientCreditsError } from "../src/lib/accounting/errors";
import type { BusinessProfile } from "../src/lib/types";

/*
 * The shared business website analysis (src/lib/pipeline/businessProfile.ts):
 * the New Search form's analysis (POST /api/business/analyze) and a recreate
 * build for another website both run it. Its steps are faked; no provider is
 * reached.
 */

const BASE: BusinessProfile = {
  url: "https://newco.invalid",
  businessName: "Newco Smiles",
  industry: "dental",
  description: "d",
  offerings: ["check-ups"],
  competitorKeywords: ["dentist"],
  positioningSummary: "p",
};

const COLORS = { primary: "#ABCDEF", secondary: "#111111", accent: "#222222", background: "#FFFFFF", text: "#000000" };

function steps(brand: () => Promise<unknown>): BusinessProfileSteps {
  return {
    prefetchBrandBranding: ((url: string) => ({ businessUrl: url, result: Promise.resolve({ ok: true, value: null }) })) as unknown as BusinessProfileSteps["prefetchBrandBranding"],
    analyzeBusinessUrl: (async () => ({ ...BASE })) as BusinessProfileSteps["analyzeBusinessUrl"],
    analyzeServiceArea: (async (p: BusinessProfile) => ({ ...p, recommendedGeoScope: "local" })) as BusinessProfileSteps["analyzeServiceArea"],
    resolveBrandBundle: brand as unknown as BusinessProfileSteps["resolveBrandBundle"],
  };
}

test("a read brand fills the profile's colours, assets and design", async () => {
  const profile = await analyzeBusinessProfile(
    "https://newco.invalid",
    {},
    steps(async () => ({ businessUrl: "x", finalUrl: "x", colors: COLORS, assets: null, design: null, warnings: [] })),
  );
  assert.equal(profile.brandColors?.primary, "#ABCDEF");
  assert.equal(profile.recommendedGeoScope, "local", "the service area is part of it");
});

test("the form's analysis (default) keeps going without brand data when the brand read fails, credit errors included", async () => {
  for (const error of [new Error("Firecrawl timed out"), new InsufficientCreditsError(1, 0)]) {
    const profile = await analyzeBusinessProfile("https://newco.invalid", {}, steps(async () => Promise.reject(error)));
    assert.equal(profile.businessName, "Newco Smiles");
    assert.equal(profile.brandColors ?? null, null);
  }
});

test("a build's analysis (strictBrand) throws a credit error from the brand read; other brand failures leave no colours", async () => {
  await assert.rejects(
    analyzeBusinessProfile("https://newco.invalid", { strictBrand: true }, steps(async () => Promise.reject(new InsufficientCreditsError(1, 0)))),
    InsufficientCreditsError,
  );
  const profile = await analyzeBusinessProfile(
    "https://newco.invalid",
    { strictBrand: true },
    steps(async () => Promise.reject(new Error("Could not extract real brand colors"))),
  );
  assert.equal(profile.brandColors ?? null, null);
});

test("analysisSetupMessage names setup problems and leaves other failures to the caller", () => {
  assert.equal(analysisSetupMessage(new Error("OPENROUTER_API_KEY is not set")), "URL analysis is not configured. Please contact support.");
  assert.equal(analysisSetupMessage(new Error("401 Unauthorized")), "URL analysis is not configured correctly. Please contact support.");
  assert.equal(
    analysisSetupMessage(new Error("402 Insufficient credits")),
    "URL analysis credit limit reached. Please try again later or contact support.",
  );
  assert.equal(analysisSetupMessage(new Error("getaddrinfo ENOTFOUND newco.invalid")), null);
});
