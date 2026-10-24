import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import * as identity from "../src/lib/data/identity";
import * as svc from "../src/lib/data/accountingService";
import { meterProviderCall, recordIncurredUsage, singleRequestUsage } from "../src/lib/accounting/meter";
import { precheckRun, reportRunCredits, runBillable, TooManyConcurrentRunsError } from "../src/lib/accounting/run";
import { runWithBillingContext } from "../src/lib/accounting/context";
import { InsufficientCreditsError } from "../src/lib/accounting/errors";
import { creditsToSubunits } from "../src/lib/accounting/units";
import type { AppUser } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

/*
 * The async metering path (accounting/meter.ts + run.ts) over the Postgres
 * repositories: reserve → meter → settle → release, the per-step top-up, and
 * the checks that used to be atomic because the file store was synchronous.
 * sociavault: ceiling 2 credits per call, 1 credit per request.
 */

const CEILING = creditsToSubunits(2);
const PER_REQUEST = creditsToSubunits(1);

let cleanup: () => Promise<void> = async () => {};
let seq = 0;

before(async () => {
  ({ cleanup } = await useTestDb("meter-async"));
});

after(async () => {
  await cleanup();
});

async function makeUser(credits: number, overrides: { maxConcurrentRuns?: number } = {}): Promise<AppUser> {
  seq += 1;
  const user = await identity.createUser({ username: `meter${seq}`, displayName: `Meter ${seq}`, passwordHash: "x" });
  await svc.initializeUserCredits(user.id, {
    allowanceSubunits: creditsToSubunits(credits),
    resetCadence: "none",
    reason: "test",
  });
  if (overrides.maxConcurrentRuns !== undefined) {
    return (await identity.updateUser(user.id, { maxConcurrentRuns: overrides.maxConcurrentRuns }))!;
  }
  return user;
}

function sociavaultCall(label = "test.call") {
  return meterProviderCall(
    { provider: "sociavault", operation: label, extractUsage: () => singleRequestUsage("req-1") },
    async () => ({ ok: true }),
  );
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("runBillable reserves, a metered call settles against the hold, and the rest is released", async () => {
  const user = await makeUser(100);
  const result = await runBillable(
    { user, operation: "test.run", projectKind: "search", projectId: "run-1", runId: "run-1" },
    async () => {
      await sociavaultCall();
      return "done";
    },
  );
  assert.equal(result, "done");

  const summary = await svc.getCreditSummary(user.id);
  assert.equal(summary.consumedSubunits, PER_REQUEST, "one request charged");
  assert.equal(summary.reservedSubunits, 0, "the run's hold is released");
  assert.equal(summary.availableSubunits, creditsToSubunits(100) - PER_REQUEST);

  const calls = await svc.queryProviderCalls({ runId: "run-1" });
  assert.equal(calls.total, 1);
  assert.equal(calls.rows[0].status, "succeeded");
  assert.equal(calls.rows[0].creditsCharged, PER_REQUEST);

  const [reservation] = await svc.listRunReservations("run-1");
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.settledSubunits, PER_REQUEST);

  const report = await reportRunCredits(user.id, "run-1");
  assert.deepEqual(report, {
    runCreditsCharged: PER_REQUEST,
    availableSubunits: creditsToSubunits(99),
    pendingCalls: 0,
  });
});

test("a call outside a run gets its own hold, settled and closed", async () => {
  const user = await makeUser(10);
  await runWithBillingContext(
    {
      initiatedByUserId: user.id,
      chargedUserId: user.id,
      projectKind: null,
      projectId: null,
      runId: "adhoc-1",
      reservationId: null,
      runBudgetSubunits: creditsToSubunits(500),
    },
    () => sociavaultCall("adhoc"),
  );
  const [reservation] = await svc.listRunReservations("adhoc-1");
  assert.equal(reservation.status, "settled");
  assert.equal(reservation.amountSubunits, 0);
  const summary = await svc.getCreditSummary(user.id);
  assert.equal(summary.consumedSubunits, PER_REQUEST);
  assert.equal(summary.reservedSubunits, 0);
});

test("a failing provider call is recorded and the error is rethrown", async () => {
  const user = await makeUser(100);
  await assert.rejects(
    runBillable(
      { user, operation: "test.run", projectKind: null, projectId: null, runId: "run-fail" },
      () =>
        meterProviderCall({ provider: "sociavault", operation: "boom" }, async () => {
          throw new Error("HTTP 500 from provider");
        }),
    ),
    /HTTP 500/,
  );
  const calls = await svc.queryProviderCalls({ runId: "run-fail" });
  assert.equal(calls.rows[0].status, "failed");
  assert.equal(calls.rows[0].creditsCharged, 0);
  assert.equal((await svc.getCreditSummary(user.id)).reservedSubunits, 0);
});

test("a small opening hold is topped up to four ceilings before the call", async () => {
  const user = await makeUser(100);
  let heldDuringCall = -1;
  await runBillable(
    {
      user,
      operation: "test.run",
      projectKind: null,
      projectId: null,
      runId: "run-topup",
      initialHoldSubunits: 1,
    },
    () =>
      meterProviderCall({ provider: "sociavault", operation: "topup" }, async () => {
        heldDuringCall = (await svc.listRunReservations("run-topup"))[0].amountSubunits;
        return { ok: true };
      }),
  );
  assert.equal(heldDuringCall, CEILING * 4);
});

test("the run budget refuses a step before the provider is contacted", async () => {
  const user = await makeUser(100);
  let contacted = false;
  await assert.rejects(
    runBillable(
      {
        user,
        operation: "test.run",
        projectKind: null,
        projectId: null,
        runId: "run-budget",
        initialHoldSubunits: 1,
        runBudgetSubunits: CEILING - 1,
      },
      () =>
        meterProviderCall({ provider: "sociavault", operation: "over" }, async () => {
          contacted = true;
          return { ok: true };
        }),
    ),
    (err: unknown) => err instanceof InsufficientCreditsError,
  );
  assert.equal(contacted, false);
});

test("parallel steps of one run top up once, never past the run budget", async () => {
  const user = await makeUser(100);
  const budget = CEILING * 5;
  const gate = deferred();
  let started = 0;
  const bothStarted = deferred();
  const holds: number[] = [];
  await runBillable(
    {
      user,
      operation: "test.run",
      projectKind: null,
      projectId: null,
      runId: "run-parallel",
      initialHoldSubunits: 1,
      runBudgetSubunits: budget,
    },
    async () => {
      const step = () =>
        meterProviderCall({ provider: "sociavault", operation: "parallel" }, async () => {
          started += 1;
          if (started === 2) bothStarted.resolve();
          await gate.promise;
          return { ok: true };
        });
      const running = Promise.all([step(), step()]);
      await bothStarted.promise;
      const [reservation] = await svc.listRunReservations("run-parallel");
      holds.push(reservation.amountSubunits + reservation.settledSubunits);
      gate.resolve();
      await running;
    },
  );
  assert.equal(holds[0], CEILING * 4, "one top-up to four ceilings; the second step found it enough");
  assert.ok(holds[0] <= budget);
});

test("the concurrency limit holds when two runs start at once", async () => {
  const user = await makeUser(100, { maxConcurrentRuns: 1 });
  const gate = deferred();
  const start = (runId: string) =>
    runBillable({ user, operation: "test.run", projectKind: null, projectId: null, runId }, async () => {
      await gate.promise;
      return runId;
    });
  const running = Promise.allSettled([start("conc-a"), start("conc-b")]);
  // Both runs are past their checks long before this; then let the admitted one finish.
  const timer = setTimeout(gate.resolve, 500);
  const settled = await running;
  clearTimeout(timer);
  const refused = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(refused.length, 1, "exactly one run is refused");
  assert.ok(refused[0].reason instanceof TooManyConcurrentRunsError);
  assert.equal(await svc.countOpenReservations(user.id), 0);
});

test("precheckRun reports the balance, the concurrency limit and suspension", async () => {
  const user = await makeUser(1);
  const low = await precheckRun(user);
  assert.equal(low.ok, false);
  assert.equal(low.reason, "insufficient_credits");
  assert.equal(low.availableSubunits, creditsToSubunits(1));

  const ok = await precheckRun(user, creditsToSubunits(1));
  assert.equal(ok.ok, true);

  const suspended = await precheckRun({ ...user, status: "suspended" });
  assert.equal(suspended.reason, "suspended");
});

test("recordIncurredUsage charges once per idempotency key", async () => {
  const user = await makeUser(10);
  const input = {
    provider: "manus" as const,
    operation: "manus.task",
    usage: { requests: 5 },
    providerRequestId: "task-1",
    idempotencyKey: "manus:task-1:5",
    fallbackUserId: user.id,
    runId: "run-manus",
  };
  const first = await recordIncurredUsage(input);
  const second = await recordIncurredUsage(input);
  assert.ok(first);
  assert.equal(second?.id, first.id, "a repeated key is recorded once");
  assert.equal((await svc.getCreditSummary(user.id)).consumedSubunits, creditsToSubunits(0.5));
  assert.equal(await recordIncurredUsage({ ...input, idempotencyKey: "x", fallbackUserId: "nobody" }), null);
});
