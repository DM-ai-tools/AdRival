import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import * as identity from "../src/lib/data/identity";
import * as svc from "../src/lib/data/accountingService";
import type { ProviderCallStatus, ProviderId, UsageConfidence } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

/*
 * The admin overview loads provider calls once and summarizes them with the
 * pure helpers; they must give exactly what usageByProvider / usageByDate
 * return for the same query.
 */

let cleanup: () => Promise<void> = async () => {};
let alice = "";
let bob = "";

before(async () => {
  ({ cleanup } = await useTestDb("usage-summaries"));
  alice = (await identity.createUser({ username: "alice", displayName: "Alice", passwordHash: "x" })).id;
  bob = (await identity.createUser({ username: "bob", displayName: "Bob", passwordHash: "x" })).id;
  for (const id of [alice, bob]) {
    await svc.initializeUserCredits(id, { allowanceSubunits: 1_000_000, resetCadence: "none", reason: "seed" });
  }
  let n = 0;
  const call = async (
    userId: string,
    provider: ProviderId,
    startedAt: string,
    credits: number,
    status: ProviderCallStatus = "succeeded",
    usageConfidence: UsageConfidence = "confirmed",
    cost: number | null = null,
  ) => {
    n += 1;
    await svc.settleProviderCall({
      idempotencyKey: `k${n}`,
      initiatedByUserId: userId,
      chargedUserId: userId,
      projectKind: null,
      projectId: null,
      runId: `run-${n % 3}`,
      provider,
      model: null,
      endpoint: null,
      operation: "op",
      providerRequestId: null,
      usage: { requests: 1 },
      usageConfidence,
      creditsCharged: credits,
      estimatedCostUsdMicros: cost,
      conversionRuleVersion: 2,
      status,
      errorMessage: null,
      reservationId: null,
      startedAt,
      durationMs: 1,
      releaseSubunits: 0,
    });
  };
  await call(alice, "openai", "2026-03-01T10:00:00.000Z", 500, "succeeded", "confirmed", 1200);
  await call(alice, "sociavault", "2026-03-01T11:00:00.000Z", 100);
  await call(bob, "openai", "2026-03-02T09:00:00.000Z", 700, "succeeded", "estimated");
  await call(bob, "firecrawl", "2026-03-03T09:00:00.000Z", 0, "failed");
  await call(alice, "firecrawl", "2026-03-03T12:00:00.000Z", 0, "timeout", "pending_reconciliation");
  await call(bob, "sociavault", "2026-03-04T08:00:00.000Z", 100, "succeeded", "confirmed", 50);
});

after(async () => {
  await cleanup();
});

const QUERIES: Array<[string, () => svc.UsageQuery]> = [
  ["all calls", () => ({})],
  ["from a date", () => ({ from: "2026-03-02T00:00:00.000Z" })],
  ["one organisation's users", () => ({ chargedUserIds: new Set([alice]) })],
];

for (const [label, query] of QUERIES) {
  test(`summaries of loaded rows equal the query helpers: ${label}`, async () => {
    const q = query();
    const { rows } = await svc.queryProviderCalls({ ...q, limit: Number.MAX_SAFE_INTEGER });
    assert.ok(rows.length > 0);
    assert.deepEqual(svc.summarizeUsageByProvider(rows), await svc.usageByProvider(q));
    assert.deepEqual(svc.summarizeUsageByDate(rows), await svc.usageByDate(q));
  });
}

test("no calls: empty summaries", () => {
  assert.deepEqual(svc.summarizeUsageByProvider([]), []);
  assert.deepEqual(svc.summarizeUsageByDate([]), []);
});
