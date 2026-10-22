import assert from "node:assert/strict";
import { test } from "node:test";
import { mapPool } from "../src/lib/pipeline/pool";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("results keep input order and concurrency never exceeds the limit", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    active++;
    peak = Math.max(peak, active);
    await tick(ms);
    active--;
    return i * 10;
  });
  assert.ok(peak <= 3 && peak > 1, `peak ${peak}`);
  assert.deepEqual(
    out.map((r) => (r.status === "fulfilled" ? r.value : null)),
    [0, 10, 20, 30, 40, 50],
  );
});

test("a rejecting task is reported and later tasks still run", async () => {
  const ran: number[] = [];
  const out = await mapPool([0, 1, 2, 3], 2, async (n) => {
    if (n === 1) throw new Error("boom");
    ran.push(n);
    return n;
  });
  assert.equal(out[1].status, "rejected");
  assert.deepEqual(ran.sort(), [0, 2, 3]);
  assert.equal(out[3].status, "fulfilled");
});
