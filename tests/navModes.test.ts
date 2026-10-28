import assert from "node:assert/strict";
import test from "node:test";
import { FIND_MODES, parseMode, topTabOf } from "../src/lib/navModes";

test("topTabOf maps search, lookup and ab to find", () => {
  for (const mode of FIND_MODES) assert.equal(topTabOf(mode), "find");
});

test("topTabOf maps recreate and history to themselves", () => {
  assert.equal(topTabOf("recreate"), "recreate");
  assert.equal(topTabOf("history"), "history");
});

test("parseMode falls back to search for unknown or empty values", () => {
  for (const raw of ["", "bogus", "RECREATE", null, undefined]) assert.equal(parseMode(raw), "search");
});

test("parseMode accepts every valid mode", () => {
  for (const mode of ["search", "lookup", "ab", "recreate", "history"] as const) assert.equal(parseMode(mode), mode);
});
