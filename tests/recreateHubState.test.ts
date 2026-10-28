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
