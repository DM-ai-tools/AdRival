import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("offer-relevance");
after(() => store.cleanup());

test("text for the searched service scores above generic and other-service text", async () => {
  const { offerRelevance } = await import("../src/lib/pipeline/offerRelevance");
  const { searchedServiceFocus } = await import("../src/lib/pipeline/offerServiceFocus");
  const focus = searchedServiceFocus(["Google Ads management", "Google ads audit"]);

  const specific = offerRelevance("Free Google Ads audit for local clinics", focus);
  const generic = offerRelevance("Digital marketing: SEO, Google Ads, web design and email marketing", focus);
  const other = offerRelevance("Rank #1 on Google with our local SEO packages", focus);
  const neutral = offerRelevance("Book a call with our team today", focus);

  assert.ok(specific > generic, "a specific offer beats a list of every service");
  assert.ok(generic > 0, "a generic page that names the service is still relevant");
  assert.ok(other < 0, "an SEO offer is not a Google Ads offer");
  assert.equal(neutral, 0);
});

test("job, legal and social destinations are not offer pages", async () => {
  const { junkLandingReason, isHomepageUrl, isJunkAdCopy } = await import(
    "../src/lib/pipeline/offerRelevance"
  );
  assert.ok(junkLandingReason("https://agency.example/careers/paid-media-specialist/"));
  assert.ok(junkLandingReason("https://agency.example/privacy-policy"));
  assert.ok(junkLandingReason("https://www.facebook.com/groups/12345"));
  assert.ok(junkLandingReason("https://instagram.com/agency"));
  assert.equal(junkLandingReason("https://agency.example/google-ads-audit"), null);
  assert.equal(junkLandingReason("https://agency.example/terms-and-savings-guide"), null);
  assert.ok(isHomepageUrl("https://agency.example/"));
  assert.ok(!isHomepageUrl("https://agency.example/ppc"));
  assert.ok(isJunkAdCopy("We're hiring a Paid Media Specialist in Sydney"));
  assert.ok(!isJunkAdCopy("Get a free Google Ads audit this week"));
});

test("ad picking prefers the searched service and caps repeated copy", async () => {
  const { pickAdsForAnalysis } = await import("../src/lib/pipeline/searchOffersReport");
  const { searchedServiceFocus } = await import("../src/lib/pipeline/offerServiceFocus");
  const focus = searchedServiceFocus(["Google Ads management"]);
  const base = {
    runId: "r",
    competitorId: "c",
    pageId: "p",
    pageName: "Agency",
    platform: "facebook",
    country: "AU",
    isActive: true,
    adLibraryUrl: "https://example.invalid",
    raw: {},
    createdAt: new Date().toISOString(),
  };
  let n = 0;
  const ad = (title: string, body: string, landingPageUrl: string | null = "https://agency.example/offer") => ({
    ...base,
    id: `ad-${++n}`,
    adArchiveId: `a${n}`,
    title,
    body,
    landingPageUrl,
  });
  const ads = [
    ...Array.from({ length: 6 }, () => ad("How we scaled INTVL 4x", "Case study of our Google Ads management for a DTC brand.")),
    ad("We're hiring", "Join our team as a paid media specialist", "https://agency.example/careers"),
    ad("SEO that ranks", "Rank on page one with local SEO"),
    ad("Free Google Ads audit", "Find the wasted spend in your Google Ads account"),
    ad("Google Ads management from $990/mo", "Fully managed PPC campaigns"),
    ad("60 days of Google Ads management free", "Try us before you pay"),
  ] as never[];

  const picked = pickAdsForAnalysis(ads, focus, 5) as Array<{ title: string }>;
  const titles = picked.map((a) => a.title);
  assert.equal(titles.filter((t) => t === "How we scaled INTVL 4x").length, 2, "repeated copy is capped at two");
  assert.ok(!titles.includes("We're hiring"), "hiring ads are left out");
  assert.ok(!titles.includes("SEO that ranks"), "another service is left out");
  assert.ok(titles.includes("Free Google Ads audit"));
  assert.ok(titles.includes("Google Ads management from $990/mo"));
});
