import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSignal, pageSignals } from "../src/lib/recreateSignals";

test("pageSignals returns the longest days and active count", () => {
  const out = pageSignals([
    { daysRunning: 3, isActive: true },
    { daysRunning: 14, isActive: true },
    { daysRunning: 40, isActive: false },
  ]);
  assert.deepEqual(out, { daysRunning: 40, activeAds: 2 });
});

test("pageSignals returns nulls for no ads", () => {
  assert.deepEqual(pageSignals([]), { daysRunning: null, activeAds: null });
});

test("pageSignals leaves days null when no ad has a known run length", () => {
  const out = pageSignals([{ isActive: true }]);
  assert.deepEqual(out, { daysRunning: null, activeAds: 1 });
});

test("formatSignal(null) is the dash", () => {
  assert.equal(formatSignal(null), "—");
  assert.equal(formatSignal(0), "0");
  assert.equal(formatSignal(14), "14");
});
