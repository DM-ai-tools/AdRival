import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactGeoSearchQueries,
  resolveSearchGeoContext,
} from "../src/lib/pipeline/keywordSuggestions";
import type { BusinessLocation, BusinessProfile } from "../src/lib/types";

const locations: BusinessLocation[] = [
  {
    label: "Brisbane CBD",
    city: "Brisbane",
    suburb: "CBD",
    region: "QLD",
    countryCode: "AU",
    isPrimary: true,
  },
  {
    label: "Sydney",
    city: "Sydney",
    suburb: null,
    region: "NSW",
    countryCode: "AU",
    isPrimary: false,
  },
];

const profile = {
  locations,
  primaryMarketCountry: "AU",
} as BusinessProfile;

test("company locations keeps every branch", () => {
  const ctx = resolveSearchGeoContext({
    keywords: ["SEO Brisbane", "SEO Sydney", "SEO near me"],
    profile,
    geoMode: "company_locations",
  });
  assert.equal(ctx.geoMode, "company_locations");
  assert.deepEqual(
    ctx.targetLocations.map((loc) => loc.city),
    ["Brisbane", "Sydney"],
  );
});

test("countrywide still narrows when the keyword names one city", () => {
  const ctx = resolveSearchGeoContext({
    keywords: ["SEO Brisbane"],
    profile,
    geoMode: "countrywide",
  });
  assert.equal(ctx.geoMode, "keyword_location");
  assert.equal(ctx.keywordLocation, "Brisbane");
  assert.deepEqual(
    ctx.targetLocations.map((loc) => loc.city),
    ["Brisbane"],
  );
});

test("location search uses one query per city plus the service", () => {
  const queries = compactGeoSearchQueries({
    keywords: [
      "SEO service",
      "SEO Brisbane",
      "SEO Brisbane CBD",
      "SEO Sydney",
      "SEO Sydney NSW",
    ],
    locations,
    categoryLabel: "SEO",
  });
  assert.deepEqual(queries, ["SEO Brisbane", "SEO Sydney", "SEO service"]);
});
