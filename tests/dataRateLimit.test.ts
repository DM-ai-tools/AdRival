import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../src/lib/data/client";
import * as attempts from "../src/lib/data/loginAttempts";
import { clearLoginAttempts, isLoginLocked, recordFailedLogin } from "../src/lib/auth/rateLimit";
import { useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  ({ cleanup } = await useTestDb("rate-limit"));
});

after(async () => {
  await cleanup();
});

test("eight failures inside the window lock the username, case-insensitively", async () => {
  for (let i = 1; i <= 7; i += 1) {
    assert.deepEqual(await recordFailedLogin("Alice"), { locked: false }, `failure ${i} does not lock`);
  }
  assert.deepEqual(await isLoginLocked("alice"), { locked: false, retryAfterSec: 0 });
  assert.deepEqual(await recordFailedLogin(" ALICE "), { locked: true });
  const state = await isLoginLocked("alice");
  assert.equal(state.locked, true);
  assert.ok(state.retryAfterSec > 890 && state.retryAfterSec <= 900, `retry after ${state.retryAfterSec}s`);

  const stored = await attempts.getLoginAttempt("alice");
  assert.equal(stored?.key, "alice");
  assert.equal(stored?.attempts, 8);
});

test("clearing attempts unlocks the username", async () => {
  for (let i = 0; i < 8; i += 1) await recordFailedLogin("bob");
  assert.equal((await isLoginLocked("bob")).locked, true);
  await clearLoginAttempts("BOB");
  assert.deepEqual(await isLoginLocked("bob"), { locked: false, retryAfterSec: 0 });
  assert.equal(await attempts.getLoginAttempt("bob"), null);
});

test("a window older than fifteen minutes starts over; an expired lock is not a lock", async () => {
  const old = new Date(Date.now() - 16 * 60_000).toISOString();
  await getDb().query("insert into login_attempts (id, created_at, data) values ($1, $2::timestamptz, $3::jsonb)", [
    "carol",
    old,
    JSON.stringify({ key: "carol", attempts: 7, firstAttemptAt: old, lockedUntil: new Date(Date.now() - 1000).toISOString() }),
  ]);
  assert.deepEqual(await isLoginLocked("carol"), { locked: false, retryAfterSec: 0 }, "lock in the past");
  assert.deepEqual(await recordFailedLogin("carol"), { locked: false });
  const stored = await attempts.getLoginAttempt("carol");
  assert.equal(stored?.attempts, 1, "a fresh window");
  assert.equal(stored?.lockedUntil, null);
  assert.ok(stored && Date.parse(stored.firstAttemptAt) > Date.parse(old));
  const { rows } = await getDb().query<{ first: string }>(
    "select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS') as first from login_attempts where id = 'carol'",
  );
  assert.equal(rows[0]?.first, stored?.firstAttemptAt.slice(0, 19), "created_at follows firstAttemptAt");
});

test("concurrent failures are all counted", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => recordFailedLogin("dave")));
  assert.equal((await attempts.getLoginAttempt("dave"))?.attempts, 8);
  assert.equal(results.filter((r) => r.locked).length, 1, "only the eighth failure locks");
  assert.equal((await isLoginLocked("dave")).locked, true);
});
