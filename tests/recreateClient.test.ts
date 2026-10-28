import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RECREATE_CHANGED_EVENT,
  RecreateRequestError,
  STYLE_DIRECTIONS,
  defaultDetails,
  enqueueRecreation,
} from "../src/lib/recreateClient";
import { STYLE_DIRECTIONS as SERVER_STYLE_DIRECTIONS } from "../src/lib/pipeline/skills/playbook";

test("defaultDetails uses the run's business website and the brand style", () => {
  assert.deepEqual(
    defaultDetails({ businessUrl: "https://acme.com", businessProfile: { url: "https://other.com" } }),
    { businessUrl: "https://acme.com", styleDirection: "brand" },
  );
});

test("defaultDetails falls back to the business profile's website", () => {
  assert.deepEqual(defaultDetails({ businessUrl: "  ", businessProfile: { url: " https://acme.com.au " } }), {
    businessUrl: "https://acme.com.au",
    styleDirection: "brand",
  });
  assert.deepEqual(defaultDetails({ businessUrl: null, businessProfile: { url: "acme.com" } }), {
    businessUrl: "acme.com",
    styleDirection: "brand",
  });
});

test("defaultDetails leaves the website empty when the run has none", () => {
  assert.deepEqual(defaultDetails(null), { businessUrl: "", styleDirection: "brand" });
  assert.deepEqual(defaultDetails({ businessProfile: null }), { businessUrl: "", styleDirection: "brand" });
});

test("the client's style list matches the server's", () => {
  assert.deepEqual([...STYLE_DIRECTIONS], [...SERVER_STYLE_DIRECTIONS]);
});

type FakeCall = { url: string; init: RequestInit | undefined };

function fakeFetch(status: number, body: unknown, calls: FakeCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const JOB = {
  id: "job-1",
  competitorId: "c-2",
  runId: "run-1",
  spaceId: null,
  status: "queued",
  options: { businessUrl: "https://acme.com", styleDirection: "brand", userFeedback: null, targetIcp: null },
  error: null,
  createdAt: "2026-10-28T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

test("enqueueRecreation posts the body and returns the job and queue place", async () => {
  const calls: FakeCall[] = [];
  const out = await enqueueRecreation(
    { competitorId: "c-1", businessUrl: "https://acme.com", styleDirection: "minimal" },
    fakeFetch(202, { job: JOB, queuedAhead: 2 }, calls),
  );
  assert.equal(out.job.id, "job-1");
  assert.equal(out.queuedAhead, 2);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/recreate/jobs");
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    competitorId: "c-1",
    businessUrl: "https://acme.com",
    styleDirection: "minimal",
  });
});

test("enqueueRecreation tells other parts of the page that the list changed", async () => {
  const g = globalThis as { window?: EventTarget };
  const hadWindow = "window" in g;
  const prev = g.window;
  const target = new EventTarget();
  g.window = target;
  let fired = 0;
  target.addEventListener(RECREATE_CHANGED_EVENT, () => {
    fired += 1;
  });
  try {
    await enqueueRecreation({ jobId: "run-1", url: "https://x.com/lp" }, fakeFetch(202, { job: JOB, queuedAhead: 0 }));
    assert.equal(fired, 1);
    await assert.rejects(enqueueRecreation({ competitorId: "c-1" }, fakeFetch(409, { error: "x" })));
    assert.equal(fired, 1, "a failed add changes nothing");
  } finally {
    if (hadWindow) g.window = prev;
    else delete g.window;
  }
});

async function errorOf(status: number, body: unknown): Promise<RecreateRequestError> {
  try {
    await enqueueRecreation({ competitorId: "c-1" }, fakeFetch(status, body));
  } catch (err) {
    assert.ok(err instanceof RecreateRequestError, "a typed error");
    return err;
  }
  throw new Error("expected enqueueRecreation to throw");
}

test("409 means the same page and details are already in progress", async () => {
  const err = await errorOf(409, { error: "This page is already in progress with these details.", code: "already_in_progress" });
  assert.equal(err.status, 409);
  assert.equal(err.code, "already_in_progress");
  assert.equal(err.message, "This page is already being recreated with these details.");
});

test("402 shows the server's credits message", async () => {
  const err = await errorOf(402, { error: "You need 40 more credits to recreate this page.", code: "insufficient_credits" });
  assert.equal(err.status, 402);
  assert.equal(err.code, "insufficient_credits");
  assert.equal(err.message, "You need 40 more credits to recreate this page.");
});

test("402 without a message still explains credits", async () => {
  const err = await errorOf(402, {});
  assert.match(err.message, /credits/i);
});

test("403 is view-only access", async () => {
  const err = await errorOf(403, { error: "Forbidden" });
  assert.equal(err.status, 403);
  assert.equal(err.message, "You have view-only access to this search.");
});

test("429 asks to try again shortly", async () => {
  const err = await errorOf(429, { error: "Too many runs", code: "too_many_concurrent_runs" });
  assert.equal(err.status, 429);
  assert.equal(err.code, "too_many_concurrent_runs");
  assert.equal(err.message, "Too many tasks are running, try again shortly.");
});

test("400 keeps the server's message and the business_url_required code", async () => {
  const err = await errorOf(400, {
    error: "Add your business website so the page can use your brand.",
    code: "business_url_required",
  });
  assert.equal(err.status, 400);
  assert.equal(err.code, "business_url_required");
  assert.equal(err.message, "Add your business website so the page can use your brand.");
});

test("a non-JSON error page still gives a readable message", async () => {
  const err = await errorOf(502, "<html>upstream error</html>");
  assert.equal(err.status, 502);
  assert.equal(err.code, null);
  assert.equal(err.message, "The page could not be added to Recreate. Try again.");
});

test("a success without a job is an error, not a silent pass", async () => {
  const err = await errorOf(202, { queuedAhead: 0 });
  assert.equal(err.message, "The page could not be added to Recreate. Try again.");
});
