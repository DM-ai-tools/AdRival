import assert from "node:assert/strict";
import { test } from "node:test";
import { designPlaybook, repairGuide, styleGuide } from "../src/lib/pipeline/skills/playbook";

test("the playbook loads the fixed rules, and style rules only for a chosen style", () => {
  const playbook = designPlaybook();
  assert.match(playbook, /DESIGN PLAYBOOK/);
  assert.match(playbook, /competitor's layout/i);
  assert.match(playbook, /em dashes/i);
  assert.equal(styleGuide("brand"), null);
  assert.match(styleGuide("minimal") || "", /Minimal/);
  assert.match(styleGuide("brutalist") || "", /brutalist/i);
  assert.match(repairGuide(), /do not redesign/i);
});
