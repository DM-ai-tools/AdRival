import { test } from "node:test";
import assert from "node:assert/strict";
import { externalUrl } from "../src/lib/externalUrl";

test("bare domains from ad libraries open as outside pages", () => {
  assert.equal(externalUrl("pushmobility.com.au"), "https://pushmobility.com.au");
  assert.equal(externalUrl("www.pushmobility.com.au/wheelchairs?x=1"), "https://www.pushmobility.com.au/wheelchairs?x=1");
  assert.equal(externalUrl("//cdn.example.com/a"), "https://cdn.example.com/a");
});

test("full links and app paths are left alone", () => {
  assert.equal(externalUrl("https://pushmobility.com.au/a"), "https://pushmobility.com.au/a");
  assert.equal(externalUrl("tel:0399999999"), "tel:0399999999");
  assert.equal(externalUrl("/recreate/abc"), "/recreate/abc");
  assert.equal(externalUrl(""), undefined);
  assert.equal(externalUrl(null), undefined);
});
