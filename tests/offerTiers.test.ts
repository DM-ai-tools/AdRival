import assert from "node:assert/strict";
import { test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("offer-tiers");
test.after(() => store.cleanup());

test("dollar prices set the ticket tier", async () => {
  const { heuristicTicketTier } = await import("../src/lib/pipeline/lookupOffersReport");
  assert.equal(heuristicTicketTier("Professional whitening from $299"), "mid");
  assert.equal(heuristicTicketTier("In-chair whitening", "$ 299"), "mid");
  assert.equal(heuristicTicketTier("Invisalign", "$1,500"), "high");
  assert.equal(heuristicTicketTier("Invisalign", "$5490"), "high");
  assert.equal(heuristicTicketTier("Consultation", "$0"), "low");
  assert.equal(heuristicTicketTier("Free smile assessment"), "low");
  assert.equal(heuristicTicketTier("Monthly retainer"), "high");
  assert.equal(heuristicTicketTier("Starter package"), "mid");
  assert.equal(heuristicTicketTier("SEO plans", "$49/mo"), "mid");
  assert.equal(heuristicTicketTier("Book a call"), "unknown");
});
