import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { validateConversionRules } from "../src/lib/accounting/conversionValidation";
import { auditActionLabel, auditDetailsText } from "../src/lib/admin/auditView";
import { callStatusLabel, confidenceLabel, operationLabel } from "../src/lib/admin/labels";

test("well-formed conversion rules pass, including the rules this install uses", () => {
  assert.deepEqual(
    validateConversionRules({
      rates: { openai: { default: { perThousandInputTokens: 2000, perThousandOutputTokens: 8000 } } },
      perCallReservationCeiling: { openai: 400000 },
    }),
    [],
  );
  // The live store's newest rule set must stay publishable as-is.
  if (existsSync("data/store.json")) {
    const store = JSON.parse(readFileSync("data/store.json", "utf8")) as {
      conversionRuleSets?: Array<{ rates: unknown; perCallReservationCeiling: unknown }>;
    };
    const latest = store.conversionRuleSets?.at(-1);
    if (latest) assert.deepEqual(validateConversionRules(latest), []);
  }
});

test("malformed conversion rules are reported in plain words", () => {
  const problems = validateConversionRules({
    rates: {
      openai: { default: { perRequest: -1, perSomething: 2 } },
      madeup: { default: {} },
      anthropic: { "claude-x": { perRequest: 1 } },
    },
    perCallReservationCeiling: { openai: "lots" },
  });
  assert.ok(problems.some((p) => /perRequest must be a number of 0 or more/.test(p)));
  assert.ok(problems.some((p) => /"perSomething" is not a rate field/.test(p)));
  assert.ok(problems.some((p) => /"madeup" is not a known provider/.test(p)));
  assert.ok(problems.some((p) => /anthropic: add a "default" rate/.test(p)));
  assert.ok(problems.some((p) => /Ceiling for openai/.test(p)));
});

test("audit entries and codes read as plain language", () => {
  assert.equal(auditActionLabel("admin.credits.add"), "Added credits");
  assert.equal(auditActionLabel("admin.something_new"), "Something new");
  assert.equal(
    auditDetailsText({ details: { amountSubunits: 30000, reason: "top-up", bulk: true } }),
    "amount: 3 credits · reason: top-up · bulk: yes",
  );
  assert.equal(callStatusLabel("not_billable"), "Not billed");
  assert.equal(confidenceLabel("pending_reconciliation"), "Waiting for billing check");
  assert.equal(operationLabel("search.offers_report"), "Offers report");
});
