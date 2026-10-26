import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { setClientForTests, type Queryable } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as identity from "../src/lib/data/identity";
import * as runs from "../src/lib/data/runs";
import { initializeUserCredits } from "../src/lib/data/accountingService";
import { creditsToSubunits } from "../src/lib/accounting/units";
import { isBrandReviewRunning, markBrandReviewStopped } from "../src/lib/pipeline/brandReview";
import type { AppUser, SearchJob } from "../src/lib/types";
import { jsonRequest, sessionCookieFor } from "./helpers/routeRequest";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Starting a batch brand review (POST /api/competitors/brand-review { runId })
 * is paid and runs in the background via Next's after(). Two clicks at once
 * must start exactly one batch. The route is called in-process with a request
 * scope whose afterContext records the background tasks instead of running
 * them, so "a batch started" is "after() was called".
 */

process.env.SESSION_SECRET = "brand-review-start-test-secret";

const route = await import("../src/app/api/competitors/brand-review/route");

const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external") as {
  workAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external") as {
  workUnitAsyncStorage: { run<T>(store: unknown, fn: () => T): T };
};
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies") as {
  RequestCookies: new (headers: Headers) => unknown;
};

/** Background tasks handed to after(), per test. */
let started: Array<() => unknown> = [];

async function postAs(user: AppUser, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers({ cookie: await sessionCookieFor(user) });
  const workStore = {
    route: "/api/competitors/brand-review",
    forceStatic: false,
    dynamicShouldError: false,
    afterContext: { after: (task: () => unknown) => void started.push(task) },
  };
  const requestStore = { type: "request", phase: "render", cookies: new RequestCookies(headers) };
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, async () => {
      const res = await route.POST(jsonRequest("http://localhost/api/competitors/brand-review", "POST", body));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }),
  );
}

let client: PgliteTestClient;

/*
 * The test database runs one statement at a time, so without help the first
 * request can finish before the second one reads the run. While armed, the
 * barrier holds every transaction at its start until `parties` have arrived
 * or `ms` passed (the first transaction of a starting batch clears the stop
 * flag, right before the stage is saved). A request that is turned away
 * never gets there, so the other one goes on after the timeout.
 */
let barrier: { parties: number; waiting: Array<() => void>; timer: ReturnType<typeof setTimeout> } | null = null;

function armBarrier(parties: number, ms = 750) {
  const current = {
    parties,
    waiting: [] as Array<() => void>,
    timer: setTimeout(() => release(current), ms),
  };
  barrier = current;
}

function release(current: NonNullable<typeof barrier>) {
  clearTimeout(current.timer);
  if (barrier === current) barrier = null;
  for (const go of current.waiting.splice(0)) go();
}

async function atBarrier(): Promise<void> {
  const current = barrier;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.waiting.push(resolve);
    if (current.waiting.length >= current.parties) release(current);
  });
}

before(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests({
    query: (text, params) => client.query(text, params),
    tx: async <T>(fn: (t: Queryable) => Promise<T>) => {
      await atBarrier();
      return client.tx(fn);
    },
  });
});

after(async () => {
  setClientForTests(null);
  await client.close();
});

let seq = 0;

async function makeUser(): Promise<AppUser> {
  const user = await identity.createUser({
    username: `reviewer${++seq}`,
    displayName: "reviewer",
    passwordHash: "x",
    role: "user",
    orgId: null,
  });
  await initializeUserCredits(user.id, {
    allowanceSubunits: creditsToSubunits(100),
    resetCadence: "none",
    reason: "test",
  });
  return user;
}

async function finishedRun(owner: AppUser, stage = "done"): Promise<SearchJob> {
  seq += 1;
  const at = new Date().toISOString();
  const job: SearchJob = {
    id: `brand-run-${seq}-${Date.now()}`,
    keyword: "plumber",
    keywords: ["plumber"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: { stage, scannedAds: 0, scannedPages: 0, accepted: 0, target: 0, rejected: 0, message: "done" },
    competitorIds: [],
    ownerUserId: owner.id,
    createdAt: at,
    updatedAt: at,
  } as SearchJob;
  assert.equal(await runs.saveJob(job), true);
  return job;
}

test("two brand-review batch requests at once start exactly one batch", async () => {
  started = [];
  const owner = await makeUser();
  const job = await finishedRun(owner);
  try {
    armBarrier(2);
    const [a, b] = await Promise.all([postAs(owner, { runId: job.id }), postAs(owner, { runId: job.id })]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    assert.equal(a.body.started, true);
    assert.equal(b.body.started, true);
    assert.equal(started.length, 1, "exactly one background batch");
    assert.equal((await runs.getJob(job.id))?.progress.stage, "brand_review");

    // A third click while it runs follows the same batch.
    const c = await postAs(owner, { runId: job.id });
    assert.equal(c.status, 200);
    assert.equal(started.length, 1);
  } finally {
    markBrandReviewStopped(job.id);
  }
});

test("a brand review cut off by a restart (stage saved, nothing running here) starts again", async () => {
  started = [];
  const owner = await makeUser();
  const job = await finishedRun(owner, "brand_review");
  assert.equal(isBrandReviewRunning(job.id), false);
  try {
    const res = await postAs(owner, { runId: job.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.started, true);
    assert.equal(started.length, 1);
    assert.equal(isBrandReviewRunning(job.id), true);
  } finally {
    markBrandReviewStopped(job.id);
  }
});

test("a stranger cannot start a brand review batch on someone else's run", async () => {
  started = [];
  const owner = await makeUser();
  const stranger = await makeUser();
  const job = await finishedRun(owner);
  const res = await postAs(stranger, { runId: job.id });
  assert.equal(res.status, 404);
  assert.equal(started.length, 0);
  assert.equal(isBrandReviewRunning(job.id), false);
  assert.equal((await runs.getJob(job.id))?.progress.stage, "done");
});
