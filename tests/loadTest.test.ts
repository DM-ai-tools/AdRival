import { test } from "node:test";
import assert from "node:assert/strict";

import { parseLoadArgs, percentile, summarize, verdict, type Sample } from "../scripts/load-test";

/* The load test's pure parts only; the load test itself never runs in `npm test`. */

test("percentile is nearest-rank over sorted samples", () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 100), 100);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 95), 0);
  assert.equal(percentile([10, 20, 30], 50), 20);
});

test("summarize groups by endpoint and counts errors apart from 401s", () => {
  const samples: Sample[] = [
    { endpoint: "history", ms: 100, status: 200 },
    { endpoint: "history", ms: 300, status: 200 },
    { endpoint: "history", ms: 200, status: 500 },
    { endpoint: "credits/summary", ms: 50, status: 401 },
    { endpoint: "credits/summary", ms: 70, status: 0 },
  ];
  const { endpoints, total } = summarize(samples);
  assert.deepEqual(
    endpoints.map((e) => [e.endpoint, e.count, e.p50, e.max, e.errors, e.unauthorized]),
    [
      ["credits/summary", 2, 50, 70, 1, 1],
      ["history", 3, 200, 300, 1, 0],
    ],
  );
  assert.equal(total.count, 5);
  assert.equal(total.errors, 2);
  assert.equal(total.unauthorized, 1);
  assert.equal(total.p95, 300);
});

test("verdict fails on errors, 401s (unless allowed) or a slow p95", () => {
  const base = { endpoint: "total", count: 10, p50: 100, p95: 900, max: 1000, errors: 0, unauthorized: 2 };
  assert.equal(verdict(base, 2000).ok, false, "401s fail by default");
  assert.match(verdict(base, 2000).reasons.join(), /2 401/);
  assert.deepEqual(verdict(base, 2000, true), { ok: true, reasons: [] });
  assert.deepEqual(verdict({ ...base, unauthorized: 0 }, 2000), { ok: true, reasons: [] });
  assert.equal(verdict({ ...base, errors: 1 }, 2000).ok, false);
  assert.match(verdict({ ...base, p95: 2500 }, 2000).reasons.join(), /p95 2500/);
});

test("arguments: defaults, flags and refusals", () => {
  assert.deepEqual(parseLoadArgs(["--base", "https://staging.example.com/"]), {
    base: "https://staging.example.com",
    users: 6,
    durationSec: 60,
    job: null,
    p95Ms: 2000,
    reserve: false,
    allow401: false,
  });
  const full = parseLoadArgs([
    "--base", "http://localhost:3000", "--users", "3", "--duration", "10", "--job", "job-1", "--p95-ms", "800", "--reserve", "--allow-401",
  ]);
  assert.deepEqual(full, {
    base: "http://localhost:3000",
    users: 3,
    durationSec: 10,
    job: "job-1",
    p95Ms: 800,
    reserve: true,
    allow401: true,
  });
  assert.throws(() => parseLoadArgs([]), /--base/);
  assert.throws(() => parseLoadArgs(["--base", "ftp://x"]), /http/);
  assert.throws(() => parseLoadArgs(["--base", "http://x", "--users", "0"]), /positive/);
  assert.throws(() => parseLoadArgs(["--base", "http://x", "--nope"]), /unknown/);
  assert.throws(() => parseLoadArgs(["--base"]), /needs a value/);
});
