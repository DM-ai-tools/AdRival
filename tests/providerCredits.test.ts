import assert from "node:assert/strict";
import { test } from "node:test";
import { providerOutOfCreditsNote } from "../src/lib/accounting/errors";

test("administrators are told which provider ran out of credits during a run", () => {
  const note = providerOutOfCreditsNote([
    { provider: "sociavault", errorMessage: null },
    { provider: "firecrawl", errorMessage: "Firecrawl /search failed (402): Insufficient credits to perform this request." },
  ]);
  assert.equal(note, "Admin note: the firecrawl account is out of credits. Top it up, then run again.");
  assert.equal(providerOutOfCreditsNote([{ provider: "openrouter", errorMessage: "timeout" }]), null);
});
