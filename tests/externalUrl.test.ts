import { test } from "node:test";
import assert from "node:assert/strict";
import { externalUrl } from "../src/lib/externalUrl";

test("bare domains from ad libraries open as outside pages", () => {
  assert.equal(externalUrl("pushmobility.com.au"), "https://pushmobility.com.au");
  assert.equal(externalUrl("www.pushmobility.com.au/wheelchairs?x=1"), "https://www.pushmobility.com.au/wheelchairs?x=1");
  assert.equal(externalUrl("//cdn.example.com/a"), "https://cdn.example.com/a");
});

test("full links and app paths are left alone", () => {
  assert.equal(externalUrl("https://pushmobility.com.au/a"), "https://pushmobility.com.au/a");
  assert.equal(externalUrl("tel:0399999999"), "tel:0399999999");
  assert.equal(externalUrl("/recreate/abc"), "/recreate/abc");
  assert.equal(externalUrl(""), undefined);
  assert.equal(externalUrl(null), undefined);
});

test("a Google Ads Transparency page is never an ad's landing page", async () => {
  const { mapGoogleCreativeToCandidate } = await import("../src/lib/pipeline/adMappers");
  const details = (landing: string | null) => ({
    title: "Lash cleanser",
    body: "",
    cta: null,
    landing,
    youtubeUrl: null,
    visibleUrl: null,
    firstShown: null,
    lastShown: null,
    format: "text",
  });
  const ad = { creativeId: "CR1", advertiserId: "AR1", advertiserName: "My Lash Store Pty Ltd" };
  assert.equal(
    mapGoogleCreativeToCandidate(ad, details("https://adstransparency.google.com/advertiser/AR1/creative/CR1")).landingPageUrl,
    null,
  );
  assert.equal(mapGoogleCreativeToCandidate(ad, details("mylashstore.com.au/cleanser")).landingPageUrl, "https://mylashstore.com.au/cleanser");
});
