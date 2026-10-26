import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb, withTx } from "../src/lib/data/client";
import * as identity from "../src/lib/data/identity";
import * as svc from "../src/lib/data/accountingService";
import type { CreditPeriod } from "../src/lib/types";
import { hasStagingDb, STAGING_TEST_TIMEOUT_MS, useStagingSchema, waitForBlocked } from "./helpers/testDb";

/*
 * Credit operations racing each other on a real Postgres with separate
 * connections (PGlite has one connection, so these cannot interleave there).
 * Skipped unless DATABASE_TEST_URL is set.
 *
 * Each test holds the user's current period row `for update` in another
 * transaction, starts both operations, waits until both are blocked, then
 * releases the row. Without the per-user lock and the period row lock, both
 * operations would read the same balance without waiting (the holder only
 * blocks lockers), so waitForBlocked would time out or both would succeed /
 * one update would be lost, and the assertions below would fail.
 */

const skip = hasStagingDb() ? false : "DATABASE_TEST_URL is not set";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  if (!skip) ({ cleanup } = await useStagingSchema("credits-race"));
}, { timeout: STAGING_TEST_TIMEOUT_MS });

after(async () => {
  await cleanup();
}, { timeout: STAGING_TEST_TIMEOUT_MS });

let n = 0;

async function makeUser(allowanceSubunits: number) {
  n += 1;
  const user = await identity.createUser({
    username: `race-${n}-${Date.now()}`,
    displayName: "Race",
    passwordHash: "x",
  });
  await svc.initializeUserCredits(user.id, { allowanceSubunits, resetCadence: "none", reason: "race" });
  return user;
}

/** Holds `for update` on the user's current period row until release(). */
function holdPeriod(userId: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = withTx(async (tx) => {
    await tx.query("select 1 from credit_periods where user_id = $1 and status = 'current' for update", [userId]);
    markLocked();
    await gate;
  });
  return { locked, release, done };
}

async function currentPeriod(userId: string): Promise<CreditPeriod> {
  const { rows } = await getDb().query<{ data: CreditPeriod }>(
    "select data from credit_periods where user_id = $1 and status = 'current'",
    [userId],
  );
  return rows[0].data;
}

async function ledgerSum(userId: string): Promise<number> {
  return (await svc.queryLedger({ userId })).reduce((sum, e) => sum + e.deltaSubunits, 0);
}

test("two simultaneous reservations of 60 against 100: exactly one succeeds", { skip, timeout: STAGING_TEST_TIMEOUT_MS }, async () => {
  for (let round = 0; round < 3; round += 1) {
    const user = await makeUser(100);
    const holder = holdPeriod(user.id);
    await holder.locked;
    const a = svc.reserveCredits({ userId: user.id, amountSubunits: 60, operation: "race.a" });
    const b = svc.reserveCredits({ userId: user.id, amountSubunits: 60, operation: "race.b" });
    try {
      await waitForBlocked(2);
    } finally {
      // Always let go of the row: a failed wait must not leave the lock (and the
      // schema drop in after()) hanging.
      holder.release();
    }
    await holder.done;
    const results = await Promise.all([a, b]);

    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one reservation is granted");
    const refused = results.find((r) => !r.ok);
    assert.ok(refused && !refused.ok);
    assert.equal(refused.reason, "insufficient_credits");
    assert.equal(refused.availableSubunits, 40, "the loser saw the winner's hold, not a stale balance");
    const period = await currentPeriod(user.id);
    assert.equal(period.reservedSubunits, 60);
    assert.equal(await ledgerSum(user.id), svc.availableSubunits(period));
  }
});

test("settle and release of one reservation at once: one release, the charge kept", { skip, timeout: STAGING_TEST_TIMEOUT_MS }, async () => {
  for (let round = 0; round < 3; round += 1) {
    const user = await makeUser(100);
    const reserved = await svc.reserveCredits({ userId: user.id, amountSubunits: 50, operation: "race.hold" });
    assert.ok(reserved.ok);
    const holder = holdPeriod(user.id);
    await holder.locked;
    const settling = svc.settleProviderCall({
      idempotencyKey: `race-settle-${user.id}`,
      initiatedByUserId: user.id,
      chargedUserId: user.id,
      projectKind: null,
      projectId: null,
      runId: null,
      provider: "sociavault",
      model: null,
      endpoint: "/race",
      operation: "race.settle",
      providerRequestId: null,
      usage: { requests: 1 },
      usageConfidence: "confirmed",
      creditsCharged: 30,
      estimatedCostUsdMicros: null,
      conversionRuleVersion: 1,
      status: "succeeded",
      errorMessage: null,
      reservationId: reserved.reservation.id,
      startedAt: new Date().toISOString(),
      durationMs: 1,
      releaseSubunits: 50,
    });
    const releasing = svc.releaseReservation(reserved.reservation.id, "race.release");
    try {
      await waitForBlocked(2);
    } finally {
      // Always let go of the row: a failed wait must not leave the lock (and the
      // schema drop in after()) hanging.
      holder.release();
    }
    await holder.done;
    await Promise.all([settling, releasing]);

    const period = await currentPeriod(user.id);
    assert.equal(period.reservedSubunits, 0, "the hold is returned exactly once");
    assert.equal(period.consumedSubunits, 30, "the charge is not lost");
    assert.equal(svc.availableSubunits(period), 70);
    assert.equal(await ledgerSum(user.id), 70, "ledger agrees with the period");
    const releases = await svc.queryLedger({ userId: user.id, types: ["reservation_release"] });
    assert.equal(releases.reduce((sum, e) => sum + e.deltaSubunits, 0), 50);
    const reservation = await svc.getReservation(reserved.reservation.id);
    assert.equal(reservation?.amountSubunits, 0);
    assert.equal(reservation?.status, "released");
  }
});
