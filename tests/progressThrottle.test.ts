import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("progress-throttle");
after(() => store.cleanup());

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeJob(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    keyword: "teeth whitening",
    keywords: ["teeth whitening"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
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
    createdAt: now,
    updatedAt: now,
  };
}

test("routine progress is batched, stage changes and the latest state always land", async () => {
  const db = await import("../src/lib/db");
  type Job = Parameters<typeof db.saveJob>[0];
  const job = makeJob(`throttle-${Date.now()}`) as unknown as Job;
  db.saveJob(job);

  job.progress = { ...job.progress, message: "one" };
  db.saveJobProgress(job); // first progress write for this run goes straight through
  assert.equal(db.getJob(job.id)?.progress.message, "one");

  job.progress = { ...job.progress, message: "two" };
  db.saveJobProgress(job);
  job.progress = { ...job.progress, message: "three" };
  db.saveJobProgress(job);
  assert.equal(db.getJob(job.id)?.progress.message, "one", "held back within the window");

  await wait(2_200);
  assert.equal(db.getJob(job.id)?.progress.message, "three", "flushed with the latest state");

  job.progress = { ...job.progress, stage: "analyzing_ad", message: "reviewing" };
  db.saveJobProgress(job);
  assert.equal(db.getJob(job.id)?.progress.stage, "analyzing_ad", "a stage change is written at once");
});

test("a final save is never overwritten by a pending progress write", async () => {
  const db = await import("../src/lib/db");
  type Job = Parameters<typeof db.saveJob>[0];
  const job = makeJob(`final-${Date.now()}`) as unknown as Job;
  db.saveJob(job);
  job.progress = { ...job.progress, message: "a" };
  db.saveJobProgress(job);
  job.progress = { ...job.progress, message: "b" };
  db.saveJobProgress(job); // pending

  const final = { ...job, status: "completed", progress: { ...job.progress, stage: "done", message: "Done" } } as Job;
  db.saveJob(final);
  await wait(2_200);
  const stored = db.getJob(job.id);
  assert.equal(stored?.status, "completed");
  assert.equal(stored?.progress.message, "Done");
});

test("a route patch cancels a pending progress write", async () => {
  const db = await import("../src/lib/db");
  type Job = Parameters<typeof db.saveJob>[0];
  const job = makeJob(`patch-${Date.now()}`) as unknown as Job;
  db.saveJob(job);
  job.progress = { ...job.progress, message: "a" };
  db.saveJobProgress(job);
  job.progress = { ...job.progress, message: "b" };
  db.saveJobProgress(job); // pending

  db.updateJob(job.id, { status: "failed", error: "boom" });
  await wait(2_200);
  assert.equal(db.getJob(job.id)?.status, "failed");
});
