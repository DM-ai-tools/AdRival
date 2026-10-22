import assert from "node:assert/strict";
import test from "node:test";
import { icpToText, pickDisplayedBase } from "../src/lib/pipeline/awareness/icpText";
import type { AbPage } from "../src/lib/pipeline/awareness/abPages";
import type { IcpContent } from "../src/lib/types";

const icp: IcpContent = {
  painPoints: ["Leaks at night", " "],
  demographics: { ageRange: "35-55", role: null, budget: "", location: "Leeds", other: null },
  psychographics: ["Distrusts quotes"],
  saysOutLoud: ["Who can I trust?"],
  interests: [],
  hopesAndDesires: ["A dry house"],
  stageNotes: "Knows the problem, not the fix.",
  suggestedAngle: "Lead with the guarantee.",
};

const page = (id: string, status: AbPage["status"]): AbPage => ({
  id, source: "competitor", brand: id, url: "", headline: null, primaryOffer: null, cta: null,
  status, levels: null, activeAds: null,
});

test("icpToText skips empty blocks and blank items", () => {
  const t = icpToText(icp, "Problem aware");
  assert.match(t, /^Ideal customer profile: Problem aware/);
  assert.match(t, /Pain points\n- Leaks at night\n\nDemographics\n- Age: 35-55\n- Location: Leeds/);
  assert.doesNotMatch(t, /Interests/);
  assert.doesNotMatch(t, /Role:|Budget:/);
  assert.match(t, /What this reader knows\nKnows the problem/);
  assert.match(t, /Suggested angle\nLead with the guarantee\.$/);
});

test("pickDisplayedBase prefers a completed override, else the default", () => {
  const a = page("a", "completed");
  const b = page("b", "completed");
  const f = page("f", "failed");
  assert.equal(pickDisplayedBase(a, [a, b, f], "b"), b);
  assert.equal(pickDisplayedBase(a, [a, b, f], "f"), a);
  assert.equal(pickDisplayedBase(a, [a, b], "gone"), a);
  assert.equal(pickDisplayedBase(null, [a], null), null);
});
