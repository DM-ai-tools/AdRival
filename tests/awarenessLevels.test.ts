import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLevels, attachSectionLevels } from "../src/lib/pipeline/awareness/levelAgents";
import type { JsonCaller } from "../src/lib/pipeline/llmJson";
import { buildLevels, runWithLevels } from "../src/lib/pipeline/landingPageAnalysis";
import { InsufficientCreditsError } from "../src/lib/accounting/errors";

const visibleText =
  "Tired of wasting money on ads that never convert? Our dashboard shows exactly where every dollar goes. Start your free trial today.";
const base = {
  headingOutline: [
    { level: 1, text: "Stop wasting ad spend", snippet: "Tired of wasting money" },
    { level: 2, text: "See where every dollar goes", snippet: "dashboard" },
  ],
  heroCandidates: ["Stop wasting ad spend"],
  visibleText,
};

function fakeFor(audience: string, awareness: string): JsonCaller {
  return async (system) => (/audience/i.test(system.slice(0, 200)) ? audience : awareness);
}

const audienceOk = JSON.stringify({
  audienceLevel: "newbie",
  reason: "Plain language, no jargon.",
  evidence: "Tired of wasting money on ads that never convert",
});
const awarenessOk = JSON.stringify({
  awarenessStage: "problem_aware",
  awarenessFocus: "only_problem",
  reason: "Opens on the pain.",
  evidence: "wasting money on ads that never convert",
  blocks: [
    { heading: "Stop wasting ad spend", audienceLevel: "newbie", awarenessStage: "problem_aware" },
    { heading: "See where every dollar goes", audienceLevel: "intermediate", awarenessStage: "solution_aware" },
  ],
});

test("carries agent values and evidence", async () => {
  const r = await analyzeLevels({ ...base, call: fakeFor(audienceOk, awarenessOk) });
  assert.equal(r.levels.audienceLevel, "newbie");
  assert.equal(r.levels.awarenessStage, "problem_aware");
  assert.equal(r.levels.awarenessFocus, "only_problem");
  assert.match(r.levels.audienceEvidence ?? "", /Tired of wasting money/);
  assert.match(r.levels.awarenessEvidence ?? "", /wasting money/);
  assert.deepEqual(r.levels.sectionLevels, []);
  assert.equal(r.blocks.length, 2);
});

test("both agents start before either resolves", async () => {
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const call: JsonCaller = async (system) => {
    started += 1;
    if (started === 2) release();
    await gate; // neither resolves until both have started
    return /audience/i.test(system.slice(0, 200)) ? audienceOk : awarenessOk;
  };
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("agents ran sequentially")), 2000).unref(),
  );
  const r = await Promise.race([analyzeLevels({ ...base, call }), timeout]);
  assert.equal(started, 2);
  assert.equal(r.levels.audienceLevel, "newbie");
});

test("evidence absent from the page becomes unclear", async () => {
  const aud = JSON.stringify({ audienceLevel: "advanced", reason: "x", evidence: "quantum blockchain synergy platform" });
  const awa = JSON.stringify({
    awarenessStage: "most_aware",
    awarenessFocus: "balanced",
    reason: "x",
    evidence: "limited time lifetime discount coupon",
    blocks: [],
  });
  const r = await analyzeLevels({ ...base, call: fakeFor(aud, awa) });
  assert.equal(r.levels.audienceLevel, "unclear");
  assert.equal(r.levels.audienceEvidence, null);
  assert.equal(r.levels.awarenessStage, "unclear");
  assert.equal(r.levels.awarenessEvidence, null);
});

test("malformed JSON from one agent only affects that label", async () => {
  const r = await analyzeLevels({ ...base, call: fakeFor("not json {", awarenessOk) });
  assert.equal(r.levels.audienceLevel, "unclear");
  assert.equal(r.levels.awarenessStage, "problem_aware");
  assert.deepEqual(r.levels.sectionLevels, []);
});

test("attachSectionLevels matches by heading and inherits otherwise", () => {
  const blocks = [
    { heading: "See where every dollar goes", audienceLevel: "advanced" as const, awarenessStage: "solution_aware" as const },
  ];
  const out = attachSectionLevels(
    [
      { name: "Hero", summary: "Opening pitch" },
      { name: "Features", summary: "x", keyElements: ["SEE WHERE EVERY DOLLAR GOES"] },
    ],
    blocks,
    { audienceLevel: "newbie", awarenessStage: "problem_aware" },
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { sectionName: "Hero", audienceLevel: "newbie", awarenessStage: "problem_aware" });
  assert.deepEqual(out[1], { sectionName: "Features", audienceLevel: "advanced", awarenessStage: "solution_aware" });
});

test("buildLevels fills one section level per section and is null without a result", async () => {
  const sections = [
    { name: "Hero", summary: "Opening pitch" },
    { name: "Features", summary: "Stop wasting ad spend" },
  ];
  assert.equal(buildLevels(sections, null), null);
  const result = await analyzeLevels({ ...base, call: fakeFor(audienceOk, awarenessOk) });
  const levels = buildLevels(sections, result);
  assert.equal(levels?.sectionLevels.length, 2);
  assert.equal(levels?.audienceLevel, "newbie");
});

test("runWithLevels keeps the extraction when the level agents fail", async (t) => {
  t.mock.method(console, "warn", () => {});
  const out = await runWithLevels(
    async () => "extracted",
    async () => {
      throw new Error("agent down");
    },
  );
  assert.deepEqual(out, { extracted: "extracted", levels: null });
});

test("runWithLevels rethrows credit errors", async () => {
  await assert.rejects(
    runWithLevels(
      async () => "extracted",
      async () => {
        throw new InsufficientCreditsError(10, 1);
      },
    ),
    (err) => err instanceof InsufficientCreditsError,
  );
});

test("runWithLevels starts both before either settles", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = runWithLevels(
    async () => {
      started.push("extract");
      await gate;
      return 1;
    },
    async () => {
      started.push("levels");
      await gate;
      return { levels: (await analyzeLevels({ ...base, call: fakeFor(audienceOk, awarenessOk) })).levels, blocks: [] };
    },
  );
  await Promise.resolve();
  assert.deepEqual(started, ["extract", "levels"]);
  release();
  const out = await run;
  assert.equal(out.extracted, 1);
  assert.equal(out.levels?.levels.audienceLevel, "newbie");
});
