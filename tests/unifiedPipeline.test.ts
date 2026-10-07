import assert from "node:assert/strict";
import { test } from "node:test";
import { packagePortableHtml } from "../src/lib/pipeline/design/packageHtml";
import type { RecreatedLandingPage } from "../src/lib/types";

test("preview and download packaging stay identical for embedded assets", () => {
  const source =
    "<!DOCTYPE html><html><head><style>body{margin:0}</style></head><body><img src=\"data:image/png;base64,abc\" alt=\"x\"></body></html>";
  const first = packagePortableHtml(source).html;
  const second = packagePortableHtml(first).html;
  assert.equal(first, second);
});

