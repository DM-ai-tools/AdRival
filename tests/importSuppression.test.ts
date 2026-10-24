import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { setClientForTests, type Queryable } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as history from "../src/lib/data/importHistory";
import * as runs from "../src/lib/data/runs";
import type { LookupJob, SearchJob } from "../src/lib/types";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * A history import changes which runs this process refuses to write only
 * once it has committed: a replace that rolls back leaves the in-process
 * tombstones as they were, a committed replace suppresses the runs it removed
 * and lifts the tombstone of every run it made live.
 */

let client: PgliteTestClient;
/** When set, the import's tombstone write fails (after the removals ran). */
let failTombstones = false;

before(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests({
    query: (text, params) => client.query(text, params),
    tx: (fn) =>
      client.tx((t) => {
        const handle: Queryable = {
          query(text, params) {
            if (failTombstones && text.includes("insert into deleted_run_ids")) {
              return Promise.reject(new Error("injected failure"));
            }
            return t.query(text, params);
          },
        };
        return fn(handle);
      }),
  });
});

after(async () => {
  setClientForTests(null);
  await client.close();
});

const AT = "2026-02-01T00:00:00.000Z";

function job(id: string): SearchJob {
  return {
    id,
    keyword: id,
    keywords: [id],
    status: "completed",
    progress: { stage: "done", message: "Done" },
    competitorIds: [],
    ownerUserId: null,
    createdAt: AT,
    updatedAt: AT,
  } as unknown as SearchJob;
}

function lookup(id: string): LookupJob {
  return {
    id,
    queryName: id,
    status: "completed",
    progress: { stage: "done", message: "Done" },
    candidates: [],
    adIds: [],
    ownerUserId: null,
    createdAt: AT,
    updatedAt: AT,
  } as unknown as LookupJob;
}

test("a replace that rolls back suppresses nothing in this process", async () => {
  assert.equal(await runs.saveJob(job("keep-me")), true);
  assert.equal(await runs.saveLookupJob(lookup("keep-lookup")), true);

  failTombstones = true;
  try {
    await assert.rejects(history.replaceStore({ jobs: [], lookupJobs: [] }), /injected failure/);
  } finally {
    failTombstones = false;
  }

  assert.equal(runs.searchRunSuppressedHere("keep-me"), false);
  assert.equal(runs.lookupRunSuppressedHere("keep-lookup"), false);
  assert.ok(await runs.getJob("keep-me"), "the run is still there");
  assert.ok(await runs.getLookupJob("keep-lookup"));
});

test("a committed replace suppresses the runs it removed and lifts tombstones of runs it made live", async () => {
  // Deleted earlier in this process; the import brings it back.
  runs.suppressSearchRunHere("revived");
  runs.suppressLookupRunHere("revived-lookup");

  await history.replaceStore({ jobs: [job("revived")], lookupJobs: [lookup("revived-lookup")] });

  assert.equal(runs.searchRunSuppressedHere("keep-me"), true, "removed by the replace");
  assert.equal(runs.lookupRunSuppressedHere("keep-lookup"), true);
  assert.equal(runs.searchRunSuppressedHere("revived"), false, "live after the import");
  assert.equal(runs.lookupRunSuppressedHere("revived-lookup"), false);
  assert.ok(await runs.getJob("revived"));
});

test("a merge lifts the tombstone of the runs it wrote", async () => {
  runs.suppressSearchRunHere("merged");
  await history.mergeStore({ jobs: [job("merged")] });
  assert.equal(runs.searchRunSuppressedHere("merged"), false);
  assert.equal(runs.searchRunSuppressedHere("keep-me"), true, "a merge removes nothing and changes no other tombstone");
});
