import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";
import type { BusinessProfile } from "../src/lib/types";

const store = useTempStore("competitor-quality");
after(() => store.cleanup());

// The seed from run 1f2d3c75: an Australian SEO agency.
const profile = {
  url: "https://trafficradius.com.au",
  businessName: "Traffic Radius",
  industry: "Digital Marketing",
  subIndustry: "SEO and Paid Search Agency",
  description: "Melbourne-based digital marketing agency focused on search-led growth.",
  offerings: ["SEO services", "Local SEO", "Technical SEO audits", "Google Ads management"],
  targetAudience: "Australian businesses",
  positioningSummary: "Full-service search agency",
  businessModel: "service",
  competitorKeywords: ["SEO agency Melbourne"],
  categories: [],
} as unknown as BusinessProfile;
const category = { id: "seo", label: "SEO Services", type: "service" as const };
const keywords = ["SEO", "Search Engine Optimization", "SEO agency", "SEO Strategy call"];

const yoast = {
  pageName: "Yoast",
  text: "Headline: Get the most out of your website with Yoast SEO Premium!\nPrimary body:\nHeard of SEO but still unsure what it actually means (or why it matters)? This beginner-friendly guide explains everything in plain English.\nLearn:\n- What SEO is\n- Why it's crucial for your website",
  landing: "https://yoast.com/what-is-seo/?utm_source=meta",
};
const ipburger = {
  pageName: "IPBurger",
  text: "Headline: Getting Blocked While Browsing?\nPrimary body:\nStay undetected and access the data you need without restrictions. IPBurger's Residential Proxies are optimized for data scraping, ad verification, SEO tracking, and more.",
  landing: "https://www.ipburger.com/pricing/residential/?utm_source=x",
};
const agency = {
  pageName: "Rank Local Digital",
  text: "Headline: Melbourne SEO agency\nPrimary body:\nOf course you want more leads. Our SEO team audits your site, fixes technical issues and grows your Google rankings. AI-powered SEO reporting for SaaS companies and tradies. Book a free strategy call.\nCTA: Book now",
  landing: "https://ranklocal.com.au/seo-services/",
};

async function ctx() {
  const { buildGuardrailContext } = await import("../src/lib/guardrails");
  return buildGuardrailContext({
    businessProfile: profile,
    selectedCategoryLabel: category.label,
    searchKeywords: keywords,
  });
}

test("an SEO plugin guide and a proxy service are rejected before the AI review", async () => {
  const { precheckCompetitor } = await import("../src/lib/guardrails");
  const c = await ctx();
  for (const ad of [yoast, ipburger]) {
    const d = precheckCompetitor(c, {
      pageName: ad.pageName,
      adText: ad.text,
      landingPageUrls: [ad.landing],
      targetCountries: ["AU"],
    });
    assert.equal(d.ok, false, `${ad.pageName} should be rejected: ${d.reason}`);
  }
});

test("a real agency ad still passes, even with 'of course', 'AI-powered' and 'SaaS' in it", async () => {
  const { precheckCompetitor, guardCompetitorHeuristic } = await import("../src/lib/guardrails");
  const c = await ctx();
  const d = precheckCompetitor(c, {
    pageName: agency.pageName,
    adText: agency.text,
    landingPageUrls: [agency.landing],
    targetCountries: ["AU"],
  });
  assert.equal(d.ok, true, d.reason);
  const after = guardCompetitorHeuristic(c, {
    pageName: agency.pageName,
    adText: agency.text,
    landingPageUrl: agency.landing,
    services: ["SEO"],
    llmReason: "A real agency, not a SaaS tool or course",
  });
  assert.equal(after.ok, true, "the model's own reason is not scanned");
});

test("a site on another country's domain is outside the searched country", async () => {
  const { foreignCountryDomain } = await import("../src/lib/guardrails");
  assert.equal(foreignCountryDomain(["https://seo.example.co.uk/"], ["AU"]), "GB");
  assert.equal(foreignCountryDomain(["https://seo.example.com.au/"], ["AU"]), null);
  assert.equal(foreignCountryDomain(["https://seo.example.com/"], ["AU"]), null, "generic domains are unknown");
  assert.equal(foreignCountryDomain(["https://seo.example.co.uk/"], ["UK"]), null);
});

test("keyword matching uses whole words in the ad copy, not CTA or URL lines", async () => {
  const { hasServiceKeywordSignal, serviceKeywordOverlapScore } = await import("../src/lib/openai/analyzer");
  const opts = { businessProfile: profile, searchKeywords: keywords, selectedCategory: category };
  // "call" (from "SEO Strategy call") and a landing URL used to count as a match.
  assert.equal(
    hasServiceKeywordSignal("Primary body:\nFresh flowers delivered in Seoul.\nCTA: Call now\nLanding page URL: https://x.example/what-is-seo", opts),
    false,
  );
  assert.equal(hasServiceKeywordSignal(agency.text, opts), true);
  assert.equal(serviceKeywordOverlapScore("research the auditorium", { searchKeywords: ["search", "audit"] }), 0);
  assert.ok(serviceKeywordOverlapScore("free SEO audits", { searchKeywords: ["seo audit"] }) > 0);
});

test("service and agency seeds only compete with service providers", async () => {
  const { blockedAdvertiserTypes, isAgencySeed } = await import("../src/lib/openai/analyzer");
  assert.equal(isAgencySeed(profile, category, keywords), true);
  const blocked = blockedAdvertiserTypes(profile, category, keywords);
  for (const t of ["software_tool", "education_or_content", "media_or_publisher", "marketplace_or_directory"] as const) {
    assert.ok(blocked.has(t), t);
  }
  assert.ok(!blocked.has("agency"));

  const clinic = { ...profile, industry: "Healthcare", subIndustry: "Dental clinic", offerings: ["Dental implants"], positioningSummary: "Family dentist" } as BusinessProfile;
  const dental = { id: "implants", label: "Dental implants", type: "service" as const };
  const clinicBlocked = blockedAdvertiserTypes(clinic, dental, ["dental implants"]);
  assert.ok(clinicBlocked.has("software_tool") && !clinicBlocked.has("service_provider"));

  const saas = { ...clinic, industry: "B2B SaaS", subIndustry: "CRM software" } as BusinessProfile;
  assert.ok(!blockedAdvertiserTypes(saas, { id: "crm", label: "CRM", type: "service" }, ["crm"]).has("software_tool"));
});

test("queries for every keyword are kept, provider phrasing first for agencies", async () => {
  const { searchQueriesForKeywords } = await import("../src/lib/pipeline/searchQueries");
  const lists: Record<string, string[]> = {
    SEO: ["SEO agency", "SEO services", "SEO company Melbourne", "SEO"],
    "SEO Strategy call": ["SEO strategy consultant"],
  };
  const out = await searchQueriesForKeywords(
    ["SEO", "SEO Strategy call"],
    async (kw) => {
      if (kw === "boom") throw new Error("x");
      return lists[kw];
    },
    4,
  );
  assert.deepEqual(out, ["SEO agency", "SEO strategy consultant", "SEO services", "SEO Strategy call"]);
});
