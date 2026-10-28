import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { useTestDb } from "./helpers/testDb";
import * as jobs from "../src/lib/data/recreateJobs";

let cleanup: () => Promise<void>;
before(async () => {
  cleanup = (await useTestDb("recreateJobs")).cleanup;
});
after(async () => {
  await cleanup();
});

let seq = 0;
function input(owner: string, spaceId: string | null = null) {
  seq += 1;
  return {
    ownerUserId: owner,
    competitorId: `comp-${seq}`,
    runId: `run-${seq}`,
    spaceId,
    options: {
      businessUrl: "https://example.com",
      styleDirection: null,
      userFeedback: null,
      targetIcp: null,
    },
  };
}

test("claimNextQueued returns oldest first", async () => {
  const a = await jobs.insertJob(input("u-order"));
  const b = await jobs.insertJob(input("u-order"));
  assert.equal(a.status, "queued");
  const first = await jobs.claimNextQueued("u-order", 3);
  assert.equal(first?.id, a.id);
  assert.equal(first?.status, "running");
  assert.ok(first?.startedAt);
  const second = await jobs.claimNextQueued("u-order", 3);
  assert.equal(second?.id, b.id);
  assert.equal(await jobs.claimNextQueued("u-order", 3), null);
});

test("claimNextQueued returns null at the running limit", async () => {
  await jobs.insertJob(input("u-limit"));
  await jobs.insertJob(input("u-limit"));
  await jobs.insertJob(input("u-limit"));
  assert.ok(await jobs.claimNextQueued("u-limit", 2));
  const second = await jobs.claimNextQueued("u-limit", 2);
  assert.ok(second);
  assert.equal(await jobs.claimNextQueued("u-limit", 2), null);
  await jobs.finishJob(second.id, "finished");
  assert.ok(await jobs.claimNextQueued("u-limit", 2));
  const all = await jobs.listJobs("u-limit", null);
  assert.equal(all.filter((j) => j.status === "finished").length, 1);
  assert.ok(all.find((j) => j.id === second.id)?.finishedAt);
});

test("two simultaneous claims never exceed the limit", async () => {
  for (let i = 0; i < 4; i++) await jobs.insertJob(input("u-race"));
  const results = await Promise.all(Array.from({ length: 4 }, () => jobs.claimNextQueued("u-race", 2)));
  assert.equal(results.filter(Boolean).length, 2);
  const ids = results.filter(Boolean).map((j) => j!.id);
  assert.equal(new Set(ids).size, 2);
  const running = (await jobs.listRunning()).filter((j) => j.ownerUserId === "u-race");
  assert.equal(running.length, 2);
});

test("removeQueued only removes the owner's queued job", async () => {
  const j = await jobs.insertJob(input("u-rm"));
  assert.equal(await jobs.removeQueued(j.id, "someone-else"), false);
  assert.equal(await jobs.removeQueued(j.id, "u-rm"), true);
  assert.equal(await jobs.removeQueued(j.id, "u-rm"), false);
  const running = await jobs.insertJob(input("u-rm"));
  await jobs.claimNextQueued("u-rm", 3);
  assert.equal(await jobs.removeQueued(running.id, "u-rm"), false);
  assert.equal((await jobs.listJobs("u-rm", null)).length, 1);
});

test("settleRunningJob only settles a job that is still running", async () => {
  const j = await jobs.insertJob(input("u-settle"));
  assert.equal(await jobs.settleRunningJob(j.id, "finished"), false, "a queued job is not settled");
  await jobs.claimNextQueued("u-settle", 3);
  await jobs.finishJob(j.id, "stopped", "Stopped by user");
  assert.equal(await jobs.settleRunningJob(j.id, "failed", "late failure"), false);
  const stopped = await jobs.getRecreateJob(j.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.error, "Stopped by user");

  const k = await jobs.insertJob(input("u-settle"));
  await jobs.claimNextQueued("u-settle", 3);
  assert.equal(await jobs.settleRunningJob(k.id, "failed", "agent broke"), true);
  const failed = await jobs.getRecreateJob(k.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "agent broke");
  assert.ok(failed?.finishedAt);
  assert.equal(await jobs.getRecreateJob("missing"), null);
});

test("requeueJob puts a running job back at its place in the queue", async () => {
  const a = await jobs.insertJob(input("u-requeue"));
  const b = await jobs.insertJob(input("u-requeue"));
  assert.equal((await jobs.claimNextQueued("u-requeue", 1))?.id, a.id);
  assert.equal(await jobs.requeueJob(a.id), true);
  const back = await jobs.getRecreateJob(a.id);
  assert.equal(back?.status, "queued");
  assert.equal(back?.startedAt, null);
  assert.equal((await jobs.claimNextQueued("u-requeue", 1))?.id, a.id, "it keeps its place ahead of later jobs");
  await jobs.finishJob(a.id, "finished");
  assert.equal(await jobs.requeueJob(a.id), false, "a finished job is not requeued");
  assert.equal((await jobs.claimNextQueued("u-requeue", 1))?.id, b.id);
});

test("listJobs scopes by space and usersWithQueuedJobs lists owners with queued work", async () => {
  const mine = await jobs.insertJob(input("u-list", "space-a"));
  await jobs.insertJob(input("u-list", "space-b"));
  await jobs.insertJob(input("u-list", null));
  const inA = await jobs.listJobs("u-list", "space-a");
  assert.deepEqual(inA.map((j) => j.id), [mine.id]);
  assert.equal(inA[0].options.businessUrl, "https://example.com");
  assert.equal(typeof inA[0].createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(inA[0].createdAt)));
  assert.equal((await jobs.listJobs("u-list", null)).length, 1);
  assert.ok((await jobs.usersWithQueuedJobs()).includes("u-list"));
});
