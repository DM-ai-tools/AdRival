import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "adrival-icp-"));
process.env.ADRIVAL_DATA_DIR = dir;
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-production";
after(() => rmSync(dir, { recursive: true, force: true }));

import { generateIcp, icpBelongsToRun, icpProfileReady } from "../src/lib/pipeline/awareness/icp";
import { maskIcp } from "../src/lib/clientFacing";
import type { BusinessProfile, IcpContent } from "../src/lib/types";

const profile = {
  url: "https://example.com",
  businessName: "Pearl Dental",
  industry: "Dental",
  description: "Family dentist",
  offerings: ["Teeth whitening", "Invisalign"],
  targetAudience: "Adults 25-45 in Melbourne",
  competitorKeywords: [],
  positioningSummary: "Gentle, same-week appointments",
} as BusinessProfile;

const thin = { ...profile, offerings: [], targetAudience: "  " } as BusinessProfile;

const valid = {
  painPoints: ["a"],
  demographics: { ageRange: "25-45", role: null, budget: null, location: "Melbourne", other: null },
  psychographics: ["b"],
  saysOutLoud: ["I hate how my teeth look"],
  interests: ["c"],
  hopesAndDesires: ["d"],
  stageNotes: "notes",
  suggestedAngle: "angle",
};

const pages = [
  {
    brand: "Rival",
    headline: "Whiter teeth in 1 hour",
    awarenessStage: "solution_aware" as const,
    audienceLevel: "newbie" as const,
  },
];

test("thin profile refuses before any model call", async () => {
  assert.equal(icpProfileReady(thin), false);
  assert.equal(icpProfileReady(null), false);
  assert.equal(icpProfileReady(profile), true);
  let calls = 0;
  await assert.rejects(
    generateIcp({
      profile: thin,
      stage: "problem_aware",
      keywords: [],
      competitorPages: [],
      call: async () => {
        calls++;
        return "{}";
      },
    }),
    /^Error: Add your business website first$/,
  );
  assert.equal(calls, 0);
});

test("valid output fills all sections and the prompt carries stage and competitor headline", async () => {
  let prompt = "";
  const icp = await generateIcp({
    profile,
    stage: "problem_aware",
    keywords: ["dentist melbourne"],
    competitorPages: pages,
    call: async (system, user) => {
      prompt = system + user;
      return JSON.stringify(valid);
    },
  });
  assert.ok(prompt.includes("problem_aware"));
  assert.ok(prompt.includes("Whiter teeth in 1 hour"));
  assert.ok(icp.painPoints.length && icp.psychographics.length && icp.saysOutLoud.length);
  assert.ok(icp.interests.length && icp.hopesAndDesires.length);
  assert.equal(icp.demographics.location, "Melbourne");
  assert.ok(icp.stageNotes && icp.suggestedAngle);
});

test("an empty or hollow model reply is rejected, not stored as an ICP", async () => {
  for (const reply of ["{}", JSON.stringify({ ...valid, painPoints: [] }), JSON.stringify({ ...valid, suggestedAngle: "  " })]) {
    await assert.rejects(
      generateIcp({ profile, stage: "unaware", keywords: [], competitorPages: [], call: async () => reply }),
      /Could not build the customer profile/,
    );
  }
});

test("lists longer than 8 are truncated", async () => {
  const long = Array.from({ length: 12 }, (_, i) => `item ${i}`);
  const icp = await generateIcp({
    profile,
    stage: "most_aware",
    keywords: [],
    competitorPages: [],
    call: async () => JSON.stringify({ ...valid, painPoints: long, saysOutLoud: long }),
  });
  assert.equal(icp.painPoints.length, 8);
  assert.equal(icp.saysOutLoud.length, 8);
});

test("icpBelongsToRun matches search and lookup ids", () => {
  assert.equal(icpBelongsToRun({ source: { kind: "search", id: "r1" } }, "r1"), true);
  assert.equal(icpBelongsToRun({ source: { kind: "search", id: "r1" } }, "r2"), false);
  assert.equal(icpBelongsToRun({ source: { kind: "lookup", id: "L1" } }, "lookup-recreate-L1"), true);
  assert.equal(icpBelongsToRun({ source: { kind: "lookup", id: "L1" } }, "L1"), false);
});

test("maskIcp scrubs vendor names", () => {
  const icp: IcpContent = { ...valid, saysOutLoud: ["Ask OpenRouter"], stageNotes: "Built by Anthropic" };
  const out = maskIcp(icp);
  assert.ok(!/OpenRouter|Anthropic/i.test(JSON.stringify(out)));
  assert.equal(out.demographics.location, "Melbourne");
});

test("upsertIcp keeps one row per source and stage and deletes with the run", async () => {
  const { upsertIcp, getIcps, getIcp, deleteHistoryRun } = await import("../src/lib/db");
  const mk = (id: string, stage: "unaware" | "most_aware") => ({
    ...valid,
    id,
    source: { kind: "search" as const, id: "run-x" },
    stage,
    createdAt: new Date().toISOString(),
  });
  upsertIcp(mk("a", "unaware"));
  upsertIcp(mk("b", "unaware"));
  upsertIcp(mk("c", "most_aware"));
  assert.equal(getIcps("search", "run-x").length, 2);
  assert.equal(getIcp("a"), null);
  assert.ok(getIcp("b"));
  deleteHistoryRun("run-x");
  assert.equal(getIcps("search", "run-x").length, 0);
});
