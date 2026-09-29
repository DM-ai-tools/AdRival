import assert from "node:assert/strict";
import { test } from "node:test";
import { maskClientFacingText } from "../src/lib/clientFacing";

test("status and error messages lose vendor names, status codes and endpoint paths", () => {
  assert.equal(
    maskClientFacingText("SociaVault rate limited (429) for /v1/scrape/facebook-ad-library/search — retry shortly"),
    "ad library rate limited — retry shortly",
  );
  assert.equal(maskClientFacingText("LLM reviewing Pearl Dental…"), "AI reviewing Pearl Dental…");
  assert.equal(maskClientFacingText("Search error: fetch failed"), "Search error: the connection failed");
  assert.equal(maskClientFacingText("Landing page fetch failed with status 403"), "Landing page fetch failed");
  assert.equal(maskClientFacingText("Found 7 competitors"), "Found 7 competitors");
});
