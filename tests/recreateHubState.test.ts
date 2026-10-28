import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecreateListItem } from "../src/lib/recreateList";
import { splitItems } from "../src/lib/recreateHubState";

function item(id: string, state: RecreateListItem["state"], createdAt: string, archived = false): RecreateListItem {
  return {
    id,
    competitorId: id,
    jobId: state === "legacy" ? null : id,
    state,
    sourceUrl: "https://example.com",
    sourceName: "",
    businessName: null,
    keyword: null,
    styleDirection: null,
    targetIcp: null,
    progress: null,
    daysRunning: null,
    activeAds: null,
    createdAt,
    finishedAt: state === "running" || state === "queued" ? null : createdAt,
    archived,
    hasPage: false,
    openPath: `/recreate/${id}`,
    error: null,
  };
}

const ids = (items: RecreateListItem[]) => items.map((i) => i.id);

test("splitItems puts three running jobs in slots and the rest in queue", () => {
  const out = splitItems([
    item("q1", "queued", "2026-10-01T00:00:00Z"),
    item("r1", "running", "2026-10-02T00:00:00Z"),
    item("r2", "running", "2026-10-03T00:00:00Z"),
    item("r3", "running", "2026-10-04T00:00:00Z"),
  ]);
  assert.deepEqual(ids(out.slots), ["r1", "r2", "r3"]);
  assert.deepEqual(ids(out.queue), ["q1"]);
  assert.deepEqual(out.recent, []);
});

test("splitItems keeps extra running items visible in slots", () => {
  const out = splitItems(["a", "b", "c", "d"].map((id, n) => item(id, "running", `2026-10-0${n + 1}T00:00:00Z`)));
  assert.deepEqual(ids(out.slots), ["a", "b", "c", "d"]);
});

test("splitItems orders the queue oldest first", () => {
  const out = splitItems([
    item("q2", "queued", "2026-10-03T00:00:00Z"),
    item("q1", "queued", "2026-10-01T00:00:00Z"),
  ]);
  assert.deepEqual(ids(out.queue), ["q1", "q2"]);
});

test("splitItems orders recent newest first", () => {
  const out = splitItems([
    item("old", "finished", "2026-10-01T00:00:00Z"),
    item("new", "failed", "2026-10-05T00:00:00Z"),
    item("mid", "stopped", "2026-10-03T00:00:00Z"),
  ]);
  assert.deepEqual(ids(out.recent), ["new", "mid", "old"]);
});

test("splitItems moves archived items to archived", () => {
  const out = splitItems([
    item("a", "finished", "2026-09-01T00:00:00Z", true),
    item("b", "finished", "2026-10-20T00:00:00Z"),
  ]);
  assert.deepEqual(ids(out.archived), ["a"]);
  assert.deepEqual(ids(out.recent), ["b"]);
});

test("splitItems keeps legacy items in recent when not archived", () => {
  const out = splitItems([item("l", "legacy", "2026-10-20T00:00:00Z"), item("m", "legacy", "2026-08-01T00:00:00Z", true)]);
  assert.deepEqual(ids(out.recent), ["l"]);
  assert.deepEqual(ids(out.archived), ["m"]);
});

import { createPollScheduler, stopFailureMessage, STATE_PILL_CLASS } from "../src/lib/recreateHubState";

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  return {
    pending,
    setTimer: (fn: () => void) => {
      pending.set(next, fn);
      return next++;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    fireAll: async () => {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
      await new Promise((r) => setImmediate(r));
    },
  };
}

test("scheduling twice leaves exactly one pending timer", () => {
  const t = fakeTimers();
  const s = createPollScheduler({ intervalFor: () => 1, run: async () => {}, ...t });
  s.schedule();
  s.schedule();
  assert.equal(t.pending.size, 1);
});

test("a stopped scheduler never runs after stop()", async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createPollScheduler({ intervalFor: () => 1, run: async () => void runs++, ...t });
  s.schedule();
  s.stop();
  s.schedule();
  await s.trigger();
  await t.fireAll();
  assert.equal(runs, 0);
  assert.equal(t.pending.size, 0);
});

test("an event-triggered refresh while one is in flight does not create a second chain", async () => {
  const t = fakeTimers();
  const releases: Array<() => void> = [];
  let runs = 0;
  const s = createPollScheduler({
    intervalFor: () => 1,
    run: () => new Promise<void>((r) => (runs++, releases.push(r))),
    ...t,
  });
  s.schedule();
  const timerFn = [...t.pending.values()][0];
  timerFn(); // timer-driven run now in flight (its handle is already cleared)
  t.pending.clear();
  const triggered = s.trigger(); // event while in flight
  releases.forEach((r) => r());
  await triggered;
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 2);
  assert.equal(t.pending.size, 1);
});

test("a due run is skipped while paused", async () => {
  const t = fakeTimers();
  let runs = 0;
  const s = createPollScheduler({ intervalFor: () => 1, run: async () => void runs++, paused: () => true, ...t });
  s.schedule();
  await t.fireAll();
  assert.equal(runs, 0);
  assert.equal(t.pending.size, 0);
});

test("stopFailureMessage uses the server reason, else a generic one", () => {
  assert.equal(stopFailureMessage(409, " Already finished "), "Already finished");
  assert.match(stopFailureMessage(500, ""), /Could not stop/);
  assert.match(stopFailureMessage(null), /reach the server/);
});

test("every state has a pill class", () => {
  assert.equal(STATE_PILL_CLASS.finished, "status-completed");
  assert.equal(STATE_PILL_CLASS.stopped, "status-partial");
});
