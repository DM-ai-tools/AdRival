import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb, withTx } from "../src/lib/data/client";
import * as runs from "../src/lib/data/runs";
import type { SearchJob } from "../src/lib/types";
import { hasStagingDb, STAGING_TEST_TIMEOUT_MS, useStagingSchema, waitForBlocked } from "./helpers/testDb";

/*
 * Delete/clear racing a save, on a real Postgres with separate connections
 * (PGlite has one connection, so these interleavings cannot happen there).
 * Skipped unless DATABASE_TEST_URL is set.
 *
 * Each test makes the race deterministic: another transaction holds the job
 * row `for update`, the delete (or clear) is started and blocks on that row,
 * then the save is started and blocks too. Releasing the row lets the delete
 * commit first. Without the global/per-run advisory locks the save would
 * already have passed its tombstone check, find no row after the wait and
 * insert the run again.
 */

const skip = hasStagingDb() ? false : "DATABASE_TEST_URL is not set";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  if (!skip) ({ cleanup } = await useStagingSchema("runs-race"));
}, { timeout: STAGING_TEST_TIMEOUT_MS });

after(async () => {
  await cleanup();
}, { timeout: STAGING_TEST_TIMEOUT_MS });

let seq = 0;

function makeJob(): SearchJob {
  seq += 1;
  const at = new Date().toISOString();
  return {
    id: `race-${seq}-${Date.now()}`,
    keyword: "race",
    status: "running",
    progress: {
      stage: "searching_ads",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 10,
      rejected: 0,
      message: "Starting",
    },
    competitorIds: [],
    createdAt: at,
    updatedAt: at,
  };
}

/** Holds `for update` on one row in its own transaction until release(). */
function holdRow(table: "jobs" | "lookup_jobs", id: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markLocked!: () => void;
  const locked = new Promise<void>((resolve) => {
    markLocked = resolve;
  });
  const done = withTx(async (tx) => {
    await tx.query(`select 1 from ${table} where id = $1 for update`, [id]);
    markLocked();
    await gate;
  });
  return { locked, release, done };
}

async function jobRows(id: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>("select count(*)::int as n from jobs where id = $1", [id]);
  return rows[0].n;
}

test("a save that waits behind deleteHistoryRun does not bring the run back", { skip, timeout: STAGING_TEST_TIMEOUT_MS }, async () => {
  const job = makeJob();
  assert.equal(await runs.saveJob(job), true);

  const holder = holdRow("jobs", job.id);
  await holder.locked;
  const deleting = runs.deleteHistoryRun(job.id);
  let saving!: ReturnType<typeof runs.saveJob>;
  try {
    await waitForBlocked(1);
    saving = runs.saveJob({ ...job, progress: { ...job.progress, message: "late write" } });
    await waitForBlocked(2);
  } finally {
    // Always let go of the row: a failed wait must not leave the lock (and the
    // schema drop in after()) hanging.
    holder.release();
  }
  await holder.done;

  assert.deepEqual(await deleting, { ok: true, removedCompetitors: 0 });
  assert.equal(await saving, false);
  assert.equal(await jobRows(job.id), 0);
});

test("a save that waits behind clearAllHistory does not bring the run back", { skip, timeout: STAGING_TEST_TIMEOUT_MS }, async () => {
  const job = makeJob();
  assert.equal(await runs.saveJob(job), true);

  const holder = holdRow("jobs", job.id);
  await holder.locked;
  const clearing = runs.clearAllHistory();
  let saving!: ReturnType<typeof runs.saveJob>;
  try {
    await waitForBlocked(1);
    saving = runs.saveJob({ ...job, progress: { ...job.progress, message: "late write" } });
    await waitForBlocked(2);
  } finally {
    // Always let go of the row: a failed wait must not leave the lock (and the
    // schema drop in after()) hanging.
    holder.release();
  }
  await holder.done;

  const cleared = await clearing;
  assert.ok(cleared.removedRuns >= 1);
  assert.equal(await saving, false);
  assert.equal(await jobRows(job.id), 0);
});
