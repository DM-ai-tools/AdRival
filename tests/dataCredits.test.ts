import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { getDb, setClientForTests, withTx, type Queryable, type TestClient } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as identity from "../src/lib/data/identity";
import * as settings from "../src/lib/data/settings";
import * as credits from "../src/lib/data/credits";
import * as svc from "../src/lib/data/accountingService";
import { creditsToSubunits } from "../src/lib/accounting/units";
import type { AppUser, CreditPeriod, CreditReservation } from "../src/lib/types";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Credit accounting on PGlite. The client is wrapped so a test can make one
 * statement inside a transaction throw (failure injection for rollback).
 * Concurrency with real connections is in dataCreditsStaging.test.ts.
 */

let base: PgliteTestClient;
/** When set, the next statement inside a transaction whose text matches throws. */
let failOn: RegExp | null = null;

function injecting(inner: PgliteTestClient): TestClient {
  return {
    query: (text, params) => inner.query(text, params),
    tx: (fn) =>
      inner.tx((t) => {
        const handle: Queryable = {
          query(text, params) {
            if (failOn && failOn.test(text)) {
              failOn = null;
              return Promise.reject(new Error("injected failure"));
            }
            return t.query(text, params);
          },
        };
        return fn(handle);
      }),
  };
}

before(async () => {
  base = await createPgliteClient();
  await migrate(base);
  setClientForTests(injecting(base));
});

after(async () => {
  setClientForTests(null);
  await base.close();
});

let n = 0;

async function makeUser(opts: { credits?: number; role?: AppUser["role"]; status?: AppUser["status"] } = {}) {
  n += 1;
  const user = await identity.createUser({
    username: `credit-user-${n}`,
    displayName: `Credit user ${n}`,
    passwordHash: "x",
    role: opts.role ?? "user",
    status: opts.status ?? "active",
  });
  if (opts.credits !== undefined) {
    await svc.initializeUserCredits(user.id, {
      allowanceSubunits: creditsToSubunits(opts.credits),
      resetCadence: "none",
      reason: "test",
    });
  }
  return user;
}

function settleInput(
  overrides: Partial<svc.SettleInput> & { idempotencyKey: string; chargedUserId: string },
): svc.SettleInput {
  return {
    initiatedByUserId: overrides.chargedUserId,
    projectKind: null,
    projectId: null,
    runId: null,
    provider: "sociavault",
    model: null,
    endpoint: "/test",
    operation: "test.op",
    providerRequestId: null,
    usage: { requests: 1 },
    usageConfidence: "confirmed",
    creditsCharged: creditsToSubunits(1),
    estimatedCostUsdMicros: null,
    conversionRuleVersion: 1,
    status: "succeeded",
    errorMessage: null,
    reservationId: null,
    startedAt: new Date().toISOString(),
    durationMs: 10,
    releaseSubunits: 0,
    ...overrides,
  };
}

async function currentPeriod(userId: string): Promise<CreditPeriod> {
  const { rows } = await getDb().query<{ data: CreditPeriod }>(
    "select data from credit_periods where user_id = $1 and status = 'current'",
    [userId],
  );
  assert.ok(rows[0], "user has a current period");
  return rows[0].data;
}

async function ledgerSum(userId: string): Promise<number> {
  const rows = await svc.queryLedger({ userId });
  return rows.reduce((sum, e) => sum + e.deltaSubunits, 0);
}

async function snapshot(userId: string) {
  const { rows: ledger } = await getDb().query<{ seq: string }>(
    "select l.seq::text as seq from credit_ledger l where l.user_id = $1 order by l.seq",
    [userId],
  );
  const { rows: periods } = await getDb().query<{ data: CreditPeriod }>(
    "select data from credit_periods where user_id = $1 order by id",
    [userId],
  );
  const { rows: reservations } = await getDb().query<{ data: CreditReservation }>(
    "select data from credit_reservations where user_id = $1 order by id",
    [userId],
  );
  const { rows: calls } = await getDb().query<{ id: string }>(
    "select id from provider_calls where user_id = $1 order by id",
    [userId],
  );
  return { ledger, periods, reservations, calls };
}

describe("pure helpers", () => {
  test("availableSubunits and userHasUnlimitedCredits are unchanged", () => {
    assert.equal(
      svc.availableSubunits({ allowanceSubunits: 100, consumedSubunits: 30, reservedSubunits: 20 } as CreditPeriod),
      50,
    );
    assert.equal(svc.userHasUnlimitedCredits({ role: "admin", status: "active" }), true);
    assert.equal(svc.userHasUnlimitedCredits({ role: "admin", status: "suspended" }), false);
    assert.equal(svc.userHasUnlimitedCredits({ role: "user", status: "active" }), false);
    assert.equal(svc.userHasUnlimitedCredits(null), false);
  });
});

describe("periods and allowance", () => {
  test("initializeUserCredits opens a period with period_open + allowance_set", async () => {
    const user = await makeUser({ credits: 10 });
    const period = await currentPeriod(user.id);
    assert.equal(period.allowanceSubunits, creditsToSubunits(10));
    const ledger = await svc.queryLedger({ userId: user.id });
    assert.deepEqual(
      ledger.map((e) => e.type).reverse(),
      ["period_open", "allowance_set"],
    );
    const { rows } = await getDb().query<{ allowance: string; consumed: string; reserved: string }>(
      "select allowance::text, consumed::text, reserved::text from credit_periods where id = $1",
      [period.id],
    );
    assert.deepEqual(rows[0], { allowance: String(creditsToSubunits(10)), consumed: "0", reserved: "0" });
  });

  test("a lazily opened period starts at zero allowance with the default cadence", async () => {
    await settings.updateAppSettings({ defaultResetCadence: "monthly" }, null);
    try {
      const user = await makeUser();
      const summary = await svc.getCreditSummary(user.id);
      assert.equal(summary.periodId, null, "no period until first use");
      const period = await svc.setAllowance({ userId: user.id, actorUserId: user.id, reason: "x", allowanceSubunits: 5 });
      assert.equal(period.resetCadence, "monthly");
      assert.ok(period.nextResetAt);
      const ledger = await svc.queryLedger({ userId: user.id });
      const sets = ledger.filter((e) => e.type === "allowance_set");
      assert.deepEqual(sets.map((e) => e.deltaSubunits).sort(), [0, 5]);
    } finally {
      await settings.updateAppSettings({ defaultResetCadence: "none" }, null);
    }
  });

  test("setAllowance, addCredits, recordAdjustment and setResetCadence", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    const change = { userId: user.id, actorUserId: admin.id, reason: "test" };

    let period = await svc.setAllowance({ ...change, allowanceSubunits: creditsToSubunits(20) });
    assert.equal(period.allowanceSubunits, creditsToSubunits(20));
    period = await svc.addCredits({ ...change, amountSubunits: creditsToSubunits(5) });
    assert.equal(period.allowanceSubunits, creditsToSubunits(25));
    period = await svc.recordAdjustment({ ...change, amountSubunits: -creditsToSubunits(3), providerCallId: "pc-1" });
    assert.equal(period.consumedSubunits, creditsToSubunits(3));
    assert.equal(period.allowanceSubunits, creditsToSubunits(25));
    period = await svc.setResetCadence({ ...change, cadence: "monthly" });
    assert.equal(period.resetCadence, "monthly");
    assert.ok(period.nextResetAt && period.nextResetAt > new Date().toISOString());

    const stored = await currentPeriod(user.id);
    assert.deepEqual(stored, period, "returned period is what was stored");
    const ledger = await svc.queryLedger({ userId: user.id });
    const adjustment = ledger.find((e) => e.type === "adjustment")!;
    assert.equal(adjustment.deltaSubunits, -creditsToSubunits(3));
    assert.equal(adjustment.providerCallId, "pc-1");
    assert.equal(adjustment.balanceAfterSubunits, creditsToSubunits(22));
    assert.equal(await ledgerSum(user.id), svc.availableSubunits(stored));
  });

  test("listPeriods is newest first and only the user's", async () => {
    const user = await makeUser({ credits: 1 });
    await makeUser({ credits: 1 });
    const periods = await svc.listPeriods(user.id);
    assert.equal(periods.length, 1);
    assert.equal(periods[0].userId, user.id);
  });
});

describe("reservations and settlement", () => {
  test("reserve → settle leaves allowance minus charge", async () => {
    const user = await makeUser({ credits: 10 });
    const reserved = await svc.reserveCredits({
      userId: user.id,
      amountSubunits: creditsToSubunits(4),
      operation: "test.reserve",
      runId: "run-a",
    });
    assert.ok(reserved.ok);
    assert.equal(reserved.availableSubunits, creditsToSubunits(6));
    assert.equal(await svc.countOpenReservations(user.id), 1);

    const settled = await svc.settleProviderCall(
      settleInput({
        idempotencyKey: `settle-${user.id}`,
        chargedUserId: user.id,
        reservationId: reserved.reservation.id,
        runId: "run-a",
        creditsCharged: creditsToSubunits(3),
        releaseSubunits: creditsToSubunits(4),
      }),
    );
    assert.equal(settled.duplicate, false);
    assert.equal(settled.overageSubunits, 0);
    assert.equal(settled.availableSubunits, creditsToSubunits(7));

    const summary = await svc.getCreditSummary(user.id);
    assert.equal(summary.availableSubunits, creditsToSubunits(10) - creditsToSubunits(3));
    assert.equal(summary.consumedSubunits, creditsToSubunits(3));
    assert.equal(summary.reservedSubunits, 0);

    const reservation = await svc.getReservation(reserved.reservation.id);
    assert.equal(reservation?.amountSubunits, 0);
    assert.equal(reservation?.settledSubunits, creditsToSubunits(3));
    assert.equal(reservation?.status, "open", "settlement does not close the reservation");

    await svc.releaseReservation(reserved.reservation.id, "done", "settled");
    const closed = await svc.getReservation(reserved.reservation.id);
    assert.equal(closed?.status, "settled");
    assert.ok(closed?.closedAt);
    assert.equal(await svc.countOpenReservations(user.id), 0);
    assert.equal(await ledgerSum(user.id), summary.availableSubunits);
    assert.deepEqual(await svc.creditsForRun("run-a"), { creditsCharged: creditsToSubunits(3), pendingCalls: 0 });
  });

  test("reserving more than is available returns ok: false and holds nothing", async () => {
    const user = await makeUser({ credits: 1 });
    const result = await svc.reserveCredits({ userId: user.id, amountSubunits: creditsToSubunits(2), operation: "big" });
    assert.deepEqual(result, {
      ok: false,
      reason: "insufficient_credits",
      requiredSubunits: creditsToSubunits(2),
      availableSubunits: creditsToSubunits(1),
    });
    assert.equal(await svc.countOpenReservations(user.id), 0);
    assert.equal((await currentPeriod(user.id)).reservedSubunits, 0);
  });

  test("an inactive or missing account cannot reserve", async () => {
    const user = await makeUser({ credits: 5, status: "suspended" });
    const result = await svc.reserveCredits({ userId: user.id, amountSubunits: 1, operation: "x" });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "account_not_active");
    const missing = await svc.reserveCredits({ userId: "nobody", amountSubunits: 1, operation: "x" });
    assert.equal(!missing.ok && missing.reason, "account_not_active");
  });

  test("an unlimited (active admin) user reserves past the allowance", async () => {
    const admin = await makeUser({ role: "admin", credits: 0 });
    const result = await svc.reserveCredits({ userId: admin.id, amountSubunits: creditsToSubunits(500), operation: "big" });
    assert.ok(result.ok);
    assert.equal(result.availableSubunits, -creditsToSubunits(500));
    const extended = await svc.extendReservation(result.reservation.id, creditsToSubunits(100));
    assert.equal(extended.ok, true);
    const summary = await svc.getCreditSummary(admin.id);
    assert.equal(summary.unlimited, true);
    assert.equal(summary.lowCredit, false);
  });

  test("ledger seq strictly increases", async () => {
    const user = await makeUser({ credits: 10 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 100, operation: "seq" });
    assert.ok(r.ok);
    await svc.settleProviderCall(
      settleInput({ idempotencyKey: `seq-${user.id}`, chargedUserId: user.id, reservationId: r.reservation.id, creditsCharged: 50, releaseSubunits: 100 }),
    );
    await svc.releaseReservation(r.reservation.id, "done");
    const { rows } = await getDb().query<{ seq: string; data_seq: number }>(
      "select l.seq::text as seq, (l.data->>'seq')::int as data_seq from credit_ledger l order by l.seq",
    );
    assert.ok(rows.length >= 5);
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(Number(rows[i].seq), rows[i].data_seq, "seq is written into data too");
      if (i > 0) assert.ok(Number(rows[i].seq) > Number(rows[i - 1].seq));
    }
    const mine = await svc.queryLedger({ userId: user.id });
    for (let i = 1; i < mine.length; i += 1) assert.ok(mine[i - 1].seq > mine[i].seq, "queryLedger is newest first");
  });

  test("extendReservation grows the hold or refuses past the balance", async () => {
    const user = await makeUser({ credits: 1 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 4000, operation: "grow" });
    assert.ok(r.ok);
    assert.deepEqual(await svc.extendReservation(r.reservation.id, 5000), { ok: true, availableSubunits: 1000 });
    assert.deepEqual(await svc.extendReservation(r.reservation.id, 2000), { ok: false, availableSubunits: 1000 });
    assert.deepEqual(await svc.extendReservation("missing", 1), { ok: false, availableSubunits: 0 });
    assert.equal((await svc.getReservation(r.reservation.id))?.amountSubunits, 9000);
    const holds = (await svc.queryLedger({ userId: user.id, types: ["reservation_hold"] })).map((e) => e.deltaSubunits);
    assert.deepEqual(holds, [-5000, -4000]);
  });

  test("release returns held credits and is a no-op once closed", async () => {
    const user = await makeUser({ credits: 1 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 6000, operation: "rel" });
    assert.ok(r.ok);
    await svc.releaseReservation(r.reservation.id, "user stopped");
    await svc.releaseReservation(r.reservation.id, "again");
    const period = await currentPeriod(user.id);
    assert.equal(period.reservedSubunits, 0);
    assert.equal(svc.availableSubunits(period), 10_000);
    const releases = await svc.queryLedger({ userId: user.id, types: ["reservation_release"] });
    assert.equal(releases.length, 1);
    assert.equal(releases[0].deltaSubunits, 6000);
    assert.equal(releases[0].reason, "user stopped");
    const stored = await svc.getReservation(r.reservation.id);
    assert.equal(stored?.status, "released");
    assert.equal(stored?.amountSubunits, 0);
  });

  test("touchReservation moves the heartbeat deadline of an open reservation", async () => {
    const user = await makeUser({ credits: 1 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 1, operation: "touch", ttlMs: 1000 });
    assert.ok(r.ok);
    await svc.touchReservation(r.reservation.id, 60 * 60 * 1000);
    const touched = await svc.getReservation(r.reservation.id);
    assert.ok(touched && touched.expiresAt > new Date(Date.now() + 30 * 60 * 1000).toISOString());
    const { rows } = await getDb().query<{ ok: boolean }>(
      "select expires_at = ($2::text)::timestamptz as ok from credit_reservations where id = $1",
      [r.reservation.id, touched!.expiresAt],
    );
    assert.equal(rows[0].ok, true, "expires_at column follows data");
  });

  test("settle is idempotent on the idempotency key", async () => {
    const user = await makeUser({ credits: 10 });
    const input = settleInput({ idempotencyKey: `idem-${user.id}`, chargedUserId: user.id, creditsCharged: 2500 });
    const first = await svc.settleProviderCall(input);
    const second = await svc.settleProviderCall(input);
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(second.call.id, first.call.id);
    assert.equal(second.availableSubunits, creditsToSubunits(10) - 2500);
    assert.equal((await currentPeriod(user.id)).consumedSubunits, 2500);
    const { rows } = await getDb().query<{ n: number }>(
      "select count(*)::int as n from provider_calls where data->>'idempotencyKey' = $1",
      [input.idempotencyKey],
    );
    assert.equal(rows[0].n, 1);
  });

  test("a second provider call row with the same idempotency key is refused by the database", async () => {
    const user = await makeUser({ credits: 1 });
    const first = await svc.settleProviderCall(settleInput({ idempotencyKey: `uniq-${user.id}`, chargedUserId: user.id }));
    await assert.rejects(
      getDb().query(
        "insert into provider_calls (id, user_id, provider, data) values ('dup-row', $1, 'sociavault', $2::jsonb)",
        [user.id, JSON.stringify({ ...first.call, id: "dup-row" })],
      ),
    );
  });

  test("an overage is billed and reported", async () => {
    const user = await makeUser({ credits: 10 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 1000, operation: "over" });
    assert.ok(r.ok);
    const settled = await svc.settleProviderCall(
      settleInput({ idempotencyKey: `over-${user.id}`, chargedUserId: user.id, reservationId: r.reservation.id, creditsCharged: 3000, releaseSubunits: 1000 }),
    );
    assert.equal(settled.overageSubunits, 2000);
    const charge = (await svc.queryLedger({ userId: user.id, types: ["charge"] }))[0];
    assert.match(charge.reason ?? "", /exceeded hold by 2000 subunits/);
    assert.equal(charge.idempotencyKey, `over-${user.id}`);
    assert.equal(await ledgerSum(user.id), svc.availableSubunits(await currentPeriod(user.id)));
  });

  test("a throwing step inside settleProviderCall rolls everything back", async () => {
    const user = await makeUser({ credits: 10 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 4000, operation: "rollback" });
    assert.ok(r.ok);
    const before = await snapshot(user.id);

    for (const pattern of [/insert into credit_periods/i, /insert into credit_reservations/i, /insert into credit_ledger/i]) {
      failOn = pattern;
      await assert.rejects(
        svc.settleProviderCall(
          settleInput({ idempotencyKey: `rb-${user.id}`, chargedUserId: user.id, reservationId: r.reservation.id, creditsCharged: 3000, releaseSubunits: 4000 }),
        ),
        /injected failure/,
      );
      assert.equal(failOn, null, `the failure was injected (${pattern})`);
      assert.deepEqual(await snapshot(user.id), before, `ledger, period, reservation and calls unchanged (${pattern})`);
    }

    // The same key settles normally afterwards: the failed attempts left nothing behind.
    const ok = await svc.settleProviderCall(
      settleInput({ idempotencyKey: `rb-${user.id}`, chargedUserId: user.id, reservationId: r.reservation.id, creditsCharged: 3000, releaseSubunits: 4000 }),
    );
    assert.equal(ok.duplicate, false);
    assert.equal(ok.availableSubunits, creditsToSubunits(10) - 3000);
  });

  test("a failing ledger insert rolls back a reservation", async () => {
    const user = await makeUser({ credits: 10 });
    const before = await snapshot(user.id);
    failOn = /insert into credit_ledger/i;
    await assert.rejects(svc.reserveCredits({ userId: user.id, amountSubunits: 10, operation: "x" }), /injected failure/);
    assert.deepEqual(await snapshot(user.id), before);
  });
});

describe("reconciliation", () => {
  test("a timed-out call keeps the hold until an admin resolves it", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 5000, operation: "slow" });
    assert.ok(r.ok);
    const settled = await svc.settleProviderCall(
      settleInput({
        idempotencyKey: `timeout-${user.id}`,
        chargedUserId: user.id,
        reservationId: r.reservation.id,
        usageConfidence: "pending_reconciliation",
        status: "timeout",
        creditsCharged: 4000,
        releaseSubunits: 5000,
      }),
    );
    assert.equal(settled.call.creditsCharged, 0);
    assert.equal(settled.call.settledAt, null);
    const parked = await svc.getReservation(r.reservation.id);
    assert.equal(parked?.status, "pending_reconciliation");
    assert.equal(parked?.amountSubunits, 5000);

    const summary = await svc.getCreditSummary(user.id);
    assert.equal(summary.pendingReconciliationCount, 1);
    assert.equal(summary.pendingReconciliationSubunits, 5000);
    assert.ok((await svc.listPendingReconciliation()).some((p) => p.id === r.reservation.id));

    // Not recoverable as abandoned, even past its deadline.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await getDb().query(
      "update credit_reservations set expires_at = $2::timestamptz, data = data || jsonb_build_object('expiresAt', $2::text) where id = $1",
      [r.reservation.id, past],
    );
    await svc.sweepAbandonedReservations();
    assert.equal((await svc.getReservation(r.reservation.id))?.status, "pending_reconciliation");

    assert.equal(
      await svc.resolveReconciliation({ reservationId: r.reservation.id, actorUserId: admin.id, chargeSubunits: 9999, reason: "billed" }),
      true,
    );
    assert.equal(
      await svc.resolveReconciliation({ reservationId: r.reservation.id, actorUserId: admin.id, chargeSubunits: 1, reason: "again" }),
      false,
    );
    const resolved = await svc.getReservation(r.reservation.id);
    assert.equal(resolved?.status, "settled");
    assert.equal(resolved?.settledSubunits, 5000, "charge is capped at the hold");
    const period = await currentPeriod(user.id);
    assert.equal(period.reservedSubunits, 0);
    assert.equal(period.consumedSubunits, 5000);
    assert.equal(await ledgerSum(user.id), svc.availableSubunits(period));
    assert.equal((await svc.getCreditSummary(user.id)).pendingReconciliationCount, 0);
  });

  test("releaseReservation to pending_reconciliation keeps the hold", async () => {
    const user = await makeUser({ credits: 1 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 500, operation: "park" });
    assert.ok(r.ok);
    await svc.releaseReservation(r.reservation.id, "unknown outcome", "pending_reconciliation");
    const parked = await svc.getReservation(r.reservation.id);
    assert.equal(parked?.status, "pending_reconciliation");
    assert.equal(parked?.note, "unknown outcome");
    assert.equal((await currentPeriod(user.id)).reservedSubunits, 500);
  });
});

describe("abandoned reservation recovery", () => {
  test("an expired reservation is recovered once, with a ledger entry", async () => {
    const user = await makeUser({ credits: 10 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 7000, operation: "crash", ttlMs: -60_000 });
    assert.ok(r.ok);
    assert.ok((await svc.sweepAbandonedReservations()) >= 1);
    assert.equal(await svc.sweepAbandonedReservations(), 0, "repeat recovery does nothing");

    const recovered = await svc.getReservation(r.reservation.id);
    assert.equal(recovered?.status, "expired");
    assert.equal(recovered?.amountSubunits, 0);
    const period = await currentPeriod(user.id);
    assert.equal(period.reservedSubunits, 0);
    const releases = await svc.queryLedger({ userId: user.id, types: ["reservation_release"] });
    assert.equal(releases.length, 1);
    assert.equal(releases[0].reason, "Abandoned reservation recovered");
    assert.equal(releases[0].balanceAfterSubunits, creditsToSubunits(10));
  });

  test("reserving for one user recovers another user's abandoned hold", async () => {
    const crashed = await makeUser({ credits: 10 });
    const other = await makeUser({ credits: 10 });
    const r = await svc.reserveCredits({ userId: crashed.id, amountSubunits: 3000, operation: "crash", ttlMs: -1000 });
    assert.ok(r.ok);
    const ok = await svc.reserveCredits({ userId: other.id, amountSubunits: 1, operation: "x" });
    assert.ok(ok.ok);
    assert.equal((await svc.getReservation(r.reservation.id))?.status, "expired");
    assert.equal((await currentPeriod(crashed.id)).reservedSubunits, 0);
  });

  test("recoverAbandonedReservations takes a transaction handle", async () => {
    const user = await makeUser({ credits: 1 });
    const r = await svc.reserveCredits({ userId: user.id, amountSubunits: 10, operation: "crash", ttlMs: -1000 });
    assert.ok(r.ok);
    const count = await withTx((tx) => svc.recoverAbandonedReservations(tx));
    assert.ok(count >= 1);
    assert.equal((await svc.getReservation(r.reservation.id))?.status, "expired");
  });
});

describe("monthly reset", () => {
  test("a due period rolls: history kept, open holds carried, not double-spendable", async () => {
    const user = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    await svc.settleProviderCall(settleInput({ idempotencyKey: `reset-${user.id}`, chargedUserId: user.id, creditsCharged: creditsToSubunits(3) }));
    const hold = await svc.reserveCredits({ userId: user.id, amountSubunits: creditsToSubunits(2), operation: "hold" });
    assert.ok(hold.ok);
    const old = await currentPeriod(user.id);
    const due = new Date(Date.now() - 60_000).toISOString();
    await getDb().query(
      "update credit_periods set data = data || jsonb_build_object('resetCadence', 'monthly', 'nextResetAt', $2::text) where id = $1",
      [old.id, due],
    );

    await svc.addCredits({ userId: user.id, actorUserId: admin.id, reason: "trigger roll", amountSubunits: 1 });

    const periods = await svc.listPeriods(user.id);
    assert.equal(periods.length, 2);
    const closed = periods.find((p) => p.status === "closed")!;
    const current = periods.find((p) => p.status === "current")!;
    assert.equal(closed.id, old.id);
    assert.equal(closed.consumedSubunits, creditsToSubunits(3), "history stays on the closed period");
    assert.equal(closed.reservedSubunits, 0, "the hold moved out of the closed period");
    assert.ok(closed.endsAt);
    assert.equal(current.allowanceSubunits, creditsToSubunits(10) + 1);
    assert.equal(current.reservedSubunits, creditsToSubunits(2), "the open hold is carried, once");
    assert.equal(current.consumedSubunits, 0);
    assert.equal(current.startsAt, due);
    assert.equal(current.resetCadence, "monthly");
    const expectedNext = new Date(due);
    expectedNext.setUTCMonth(expectedNext.getUTCMonth() + 1);
    assert.equal(current.nextResetAt, expectedNext.toISOString());

    const moved = await svc.getReservation(hold.reservation.id);
    assert.equal(moved?.periodId, current.id);
    const { rows } = await getDb().query<{ period_id: string; status: string }>(
      "select period_id, status from credit_periods p join (select period_id from credit_reservations where id = $1) r on r.period_id = p.id",
      [hold.reservation.id],
    );
    assert.equal(rows[0].status, "current", "period_id column follows data");

    const types = (await svc.queryLedger({ userId: user.id })).map((e) => e.type);
    assert.ok(types.includes("period_close"));
    assert.equal(types.filter((t) => t === "period_open").length, 2);

    // Releasing the carried hold returns it to the new period only.
    await svc.releaseReservation(hold.reservation.id, "done");
    const after = await svc.listPeriods(user.id);
    assert.equal(after.find((p) => p.status === "current")!.reservedSubunits, 0);
    assert.equal(after.find((p) => p.status === "closed")!.reservedSubunits, 0);
  });
});

describe("read models", () => {
  test("provider call queries, breakdowns and per-run totals", async () => {
    const payer = await makeUser({ credits: 100 });
    const other = await makeUser({ credits: 100 });
    const at = (m: number) => new Date(Date.UTC(2026, 4, 1 + m, 12)).toISOString();
    await svc.settleProviderCall(settleInput({ idempotencyKey: `q1-${payer.id}`, chargedUserId: payer.id, runId: "rq", provider: "sociavault", creditsCharged: 100, startedAt: at(0) }));
    await svc.settleProviderCall(settleInput({ idempotencyKey: `q2-${payer.id}`, chargedUserId: payer.id, runId: "rq", provider: "openai", creditsCharged: 300, startedAt: at(1), estimatedCostUsdMicros: 7 }));
    await svc.settleProviderCall(settleInput({ idempotencyKey: `q3-${payer.id}`, chargedUserId: payer.id, runId: "rq2", provider: "openai", status: "failed", creditsCharged: 0, startedAt: at(2) }));
    await svc.settleProviderCall(settleInput({ idempotencyKey: `q4-${other.id}`, chargedUserId: other.id, runId: "rq", provider: "openai", creditsCharged: 50, startedAt: at(1) }));

    const all = await svc.queryProviderCalls({ chargedUserId: payer.id });
    assert.equal(all.total, 3);
    assert.deepEqual(all.rows.map((c) => c.idempotencyKey), [`q3-${payer.id}`, `q2-${payer.id}`, `q1-${payer.id}`]);
    const page = await svc.queryProviderCalls({ chargedUserId: payer.id, limit: 1, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.rows.map((c) => c.idempotencyKey), [`q2-${payer.id}`]);
    assert.equal((await svc.queryProviderCalls({ chargedUserIds: new Set([payer.id, other.id]), runId: "rq" })).total, 3);
    assert.equal((await svc.queryProviderCalls({ chargedUserIds: new Set() })).total, 0);
    assert.equal((await svc.queryProviderCalls({ chargedUserId: payer.id, provider: "openai", status: "failed" })).total, 1);
    assert.equal((await svc.queryProviderCalls({ chargedUserId: payer.id, from: at(1), to: at(1) })).total, 1);
    assert.equal((await svc.queryProviderCalls({ chargedUserId: payer.id, confidence: "confirmed" })).total, 3);

    const byProvider = await svc.usageByProvider({ chargedUserId: payer.id });
    assert.deepEqual(
      byProvider.map((r) => [r.provider, r.calls, r.creditsCharged, r.failedCalls, r.estimatedCostUsdMicros]),
      [
        ["openai", 2, 300, 1, 7],
        ["sociavault", 1, 100, 0, null],
      ],
    );
    const byDate = await svc.usageByDate({ chargedUserId: payer.id });
    assert.deepEqual(byDate.map((r) => r.date), [at(2).slice(0, 10), at(1).slice(0, 10), at(0).slice(0, 10)]);
    const byRun = await svc.usageByRun({ chargedUserId: payer.id });
    assert.deepEqual(byRun.map((r) => [r.runId, r.calls, r.creditsCharged]), [
      ["rq2", 1, 0],
      ["rq", 2, 400],
    ]);

    assert.deepEqual(await svc.creditsForRun("rq"), { creditsCharged: 450, pendingCalls: 0 });
    assert.deepEqual(await svc.creditsForRun("rq", payer.id), { creditsCharged: 400, pendingCalls: 0 });
    assert.deepEqual(await svc.creditsForRun("none"), { creditsCharged: 0, pendingCalls: 0 });
  });

  test("queryLedger filters by type, period and limit", async () => {
    const user = await makeUser({ credits: 1 });
    const period = await currentPeriod(user.id);
    const all = await svc.queryLedger({ userId: user.id });
    assert.equal(all.length, 2);
    assert.equal((await svc.queryLedger({ userId: user.id, limit: 1 }))[0].type, "allowance_set");
    assert.equal((await svc.queryLedger({ periodId: period.id, types: ["period_open"] })).length, 1);
    assert.equal((await svc.queryLedger({ userId: user.id, from: "2999-01-01" })).length, 0);
  });

  test("getCreditSummary low-credit flag and assertSpendStillAuthorized", async () => {
    const user = await makeUser({ credits: 1 });
    const summary = await svc.getCreditSummary(user.id);
    assert.equal(summary.lowCredit, true);
    assert.equal(summary.unlimited, false);
    assert.equal(summary.resetCadence, "none");
    assert.equal(await svc.assertSpendStillAuthorized(user.id), true);
    await identity.updateUser(user.id, { status: "suspended" });
    assert.equal(await svc.assertSpendStillAuthorized(user.id), false);
    assert.equal(await svc.assertSpendStillAuthorized("nobody"), false);
  });

  test("credits.lockCurrentPeriod returns the current period, or null", async () => {
    const user = await makeUser({ credits: 2 });
    const locked = await withTx((tx) => credits.lockCurrentPeriod(tx, user.id));
    assert.equal(locked?.id, (await currentPeriod(user.id)).id);
    assert.equal(await withTx((tx) => credits.lockCurrentPeriod(tx, "nobody")), null);
  });
});
