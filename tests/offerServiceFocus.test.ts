import assert from "node:assert/strict";
import { test } from "node:test";
import {
  offerFitsSearchedService,
  searchedServiceFocus,
} from "../src/lib/pipeline/offerServiceFocus";

const seoKeywords = [
  "SEO service",
  "Search Engine Optimization",
  "Rank on Google",
  "SEO Strategy call",
];

test("an SEO keyword search drops Google Ads and other services", () => {
  const focus = searchedServiceFocus(seoKeywords, "SEO");
  assert.equal(
    offerFitsSearchedService("Google Ads management from $1,500/mo", focus, {
      requireMatch: true,
    }),
    false,
  );
  assert.equal(
    offerFitsSearchedService("Facebook ads starter package", focus, {
      requireMatch: true,
    }),
    false,
  );
  assert.equal(
    offerFitsSearchedService("Website design packages", focus, {
      requireMatch: true,
    }),
    false,
  );
  assert.equal(
    offerFitsSearchedService("Free SEO audit and monthly organic ranking", focus, {
      requireMatch: true,
    }),
    true,
  );
  assert.equal(
    offerFitsSearchedService("Rank higher with search engine optimization", focus, {
      requireMatch: true,
    }),
    true,
  );
});

test("rank on google does not keep a Google Ads ad", () => {
  const focus = searchedServiceFocus(seoKeywords, null);
  assert.equal(
    offerFitsSearchedService(
      "Get more leads with Google Ads. PPC management for local businesses.",
      focus,
    ),
    false,
  );
  assert.equal(
    offerFitsSearchedService(
      "We help local businesses get more customers. Book a call.",
      focus,
    ),
    true,
  );
});
