import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("lookup-stop");
after(() => store.cleanup());

test("stopLookupJob blocks further pipeline saves (durable stopRequested)", async () => {
  const {
    getLookupJob,
    isLookupJobSuppressed,
    saveLookupJob,
    stopLookupJob,
  } = await import("../src/lib/db");

  const id = `lookup-stop-${Date.now()}`;
  const now = new Date().toISOString();
  assert.equal(
    saveLookupJob({
      id,
      queryName: "Echelonn",
      platform: "facebook",
      status: "running",
      progress: {
        stage: "fetching_ads",
        message: "Fetching ads…",
        candidatesFound: 1,
        adsFetched: 10,
        pagesScanned: 3,
      },
      candidates: [],
      adIds: ["ad-1"],
      createdAt: now,
      updatedAt: now,
    }),
    true,
  );

  const stopped = stopLookupJob(id, "Stopped by user");
  assert.ok(stopped);
  assert.equal(stopped.status, "partial");
  assert.equal(stopped.progress.stopRequested, true);
  assert.equal(stopped.progress.message, "Stopped by user");
  assert.equal(isLookupJobSuppressed(id), true);

  // Simulate a late pipeline progress write after Stop (same race as live runs).
  const revived = saveLookupJob({
    id,
    queryName: "Echelonn",
    platform: "facebook",
    status: "running",
    progress: {
      stage: "fetching_ads",
      message: "Fetching ads for Echelonn (US) — page 4…",
      candidatesFound: 1,
      adsFetched: 50,
      pagesScanned: 4,
    },
    candidates: [],
    adIds: ["ad-1", "ad-2"],
    createdAt: now,
    updatedAt: new Date().toISOString(),
  });
  assert.equal(revived, false);

  const persisted = getLookupJob(id);
  assert.ok(persisted);
  assert.equal(persisted.status, "partial");
  assert.equal(persisted.progress.stopRequested, true);
  assert.match(persisted.progress.message, /Stopped by user/i);
  assert.notEqual(persisted.progress.stage, "fetching_ads");
});

test("isLookupJobSuppressed reads stopRequested from the store", async () => {
  const { getLookupJob, isLookupJobSuppressed, saveLookupJob, stopLookupJob } =
    await import("../src/lib/db");

  const id = `lookup-stop-durable-${Date.now()}`;
  const now = new Date().toISOString();
  saveLookupJob({
    id,
    queryName: "Brand",
    platform: "facebook",
    status: "running",
    progress: {
      stage: "fetching_ads",
      message: "Fetching…",
      candidatesFound: 0,
      adsFetched: 0,
      pagesScanned: 0,
    },
    candidates: [],
    adIds: [],
    createdAt: now,
    updatedAt: now,
  });
  stopLookupJob(id);

  // Even if the in-memory tombstone were missing, the durable flag must still halt.
  const job = getLookupJob(id);
  assert.equal(job?.progress.stopRequested, true);
  assert.equal(isLookupJobSuppressed(id), true);
});
