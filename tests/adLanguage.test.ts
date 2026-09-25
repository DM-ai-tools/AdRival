import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeEnglish } from "../src/lib/pipeline/adLanguage";

test("french service ads are not treated as English", () => {
  const copy =
    "Site vitrine professionnel dès 800 €. SEO inclus pour attirer plus de clients locaux";
  assert.equal(looksLikeEnglish(copy), false);
});

test("english service ads stay eligible", () => {
  const copy =
    "Professional website from $800. SEO included to attract more local customers.";
  assert.equal(looksLikeEnglish(copy), true);
});
