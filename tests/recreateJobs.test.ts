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
