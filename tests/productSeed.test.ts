import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedAdvertiserTypes, isProductSeed } from "../src/lib/openai/analyzer";
import type { BusinessProfile } from "../src/lib/types";

const store = {
  url: "https://mobilitystore.example.com.au",
  businessName: "Mobility Store",
  industry: "Retail",
  subIndustry: "Mobility aids",
  description: "Online store for wheelchairs and walking aids.",
  offerings: ["Wheelchairs", "Walking aids"],
  competitorKeywords: [],
  positioningSummary: "Online mobility aids store",
  businessModel: "ecommerce",
  serviceDelivery: "n_a",
} satisfies BusinessProfile;

test("an online store is a product seed; a clinic is not", () => {
  assert.equal(isProductSeed(store), true);
  assert.equal(isProductSeed({ ...store, businessModel: "service", serviceDelivery: "onsite" }), false);
  // A product category picked on a hybrid business counts too.
  assert.equal(isProductSeed({ ...store, businessModel: "hybrid", serviceDelivery: "mixed" }, { id: "w", label: "Wheelchairs", type: "product" }), true);
  assert.equal(isProductSeed({ ...store, businessModel: "hybrid" }, { id: "r", label: "Repairs", type: "service" }), false);
});

test("an online store competes with stores and brands, not marketplaces, tools or content", () => {
  const blocked = blockedAdvertiserTypes(store, null, ["wheelchairs"]);
  for (const t of ["marketplace_or_directory", "software_tool", "education_or_content", "media_or_publisher", "agency"] as const) {
    assert.equal(blocked.has(t), true, t);
  }
  assert.equal(blocked.has("physical_product"), false);
  assert.equal(blocked.has("service_provider"), false);
});
