import assert from "node:assert/strict";
import { test } from "node:test";
import { computeCoverage } from "../src/lib/pipeline/awareness/coverage";
import type { AwarenessFocus, AwarenessStage, PageLevels, SectionLevel } from "../src/lib/types";

function levels(
  stage: AwarenessStage,
  opts: { focus?: AwarenessFocus | null; sections?: SectionLevel[] } = {},
): PageLevels {
  return {
    audienceLevel: "newbie",
    audienceReason: "",
    audienceEvidence: null,
    awarenessStage: stage,
    awarenessFocus: opts.focus ?? null,
    awarenessReason: "",
    awarenessEvidence: null,
    sectionLevels: opts.sections ?? [],
  };
}

test("page-level stages are covered, the rest missing", () => {
  const r = computeCoverage([
    { id: "a", levels: levels("problem_aware") },
    { id: "b", levels: levels("solution_aware") },
  ]);
  assert.equal(r.labelledCount, 2);
  const by = Object.fromEntries(r.stages.map((s) => [s.stage, s]));
  assert.deepEqual(by.problem_aware, { stage: "problem_aware", status: "covered", pageIds: ["a"] });
  assert.deepEqual(by.solution_aware, { stage: "solution_aware", status: "covered", pageIds: ["b"] });
  for (const s of ["unaware", "product_aware", "most_aware"]) {
    assert.equal(by[s].status, "missing");
    assert.deepEqual(by[s].pageIds, []);
  }
});

test("a stage only seen in a section is partial", () => {
  const r = computeCoverage([
    {
      id: "a",
      levels: levels("unclear", {
        sections: [{ sectionName: "Hero", audienceLevel: "newbie", awarenessStage: "problem_aware" }],
      }),
    },
  ]);
  const p = r.stages.find((s) => s.stage === "problem_aware")!;
  assert.equal(p.status, "partial");
  assert.deepEqual(p.pageIds, ["a"]);
  assert.equal(r.labelledCount, 1);
});

test("pages without levels are ignored", () => {
  const r = computeCoverage([{ id: "a" }, { id: "b", levels: null }]);
  assert.equal(r.labelledCount, 0);
  assert.ok(r.stages.every((s) => s.status === "missing"));
});

test("awarenessFocus does not change coverage", () => {
  const a = computeCoverage([{ id: "a", levels: levels("problem_aware", { focus: "only_problem" }) }]);
  const b = computeCoverage([{ id: "a", levels: levels("problem_aware", { focus: null }) }]);
  assert.deepEqual(a, b);
});
