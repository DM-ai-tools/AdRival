import assert from "node:assert/strict";
import { test } from "node:test";
import { returnLabel, safeReturnPath, withReturn } from "../src/lib/returnTo";

test("only same-site paths are accepted as a way back", () => {
  assert.equal(safeReturnPath("/?mode=history&item=search:1&tab=offers"), "/?mode=history&item=search:1&tab=offers");
  assert.equal(safeReturnPath("//evil.example"), null);
  assert.equal(safeReturnPath("/\\evil.example"), null);
  assert.equal(safeReturnPath("https://evil.example/"), null);
  assert.equal(safeReturnPath(""), null);
  assert.equal(safeReturnPath(null), null);
});

test("a detail link carries the way back, and an unsafe one is dropped", () => {
  assert.equal(
    withReturn("/recreate/abc", "/?mode=search&run=r1&tab=preview"),
    "/recreate/abc?back=%2F%3Fmode%3Dsearch%26run%3Dr1%26tab%3Dpreview",
  );
  assert.equal(withReturn("/x?y=1", "/"), "/x?y=1&back=%2F");
  assert.equal(withReturn("/recreate/abc", "//evil.example"), "/recreate/abc");
});

test("the breadcrumb names the screen the user came from", () => {
  assert.equal(returnLabel("/?mode=history&item=search:1"), "History");
  assert.equal(returnLabel("/?mode=lookup&lookup=l1"), "Competitor lookup");
  assert.equal(returnLabel("/?mode=search&run=r1&tab=offers"), "Keyword search");
  assert.equal(returnLabel("/"), "Keyword search");
});
