import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { jsonText, jsonTextWithStats, sanitizeJsonValue, sanitizeJsonValueWithStats } from "../src/lib/data/jsonText";

/*
 * jsonText: the JSON text every jsonb parameter is written with. Postgres
 * jsonb rejects a lone UTF-16 surrogate escape ("\ud83c", e.g. ad copy cut in
 * the middle of an emoji) and the NUL escape ("\u0000"); jsonText replaces
 * both with U+FFFD and leaves everything else exactly as JSON.stringify wrote it.
 */

const FFFD = "\uFFFD";
const HIGH = "\ud83c"; // first half of 🎉 (U+1F389)
const LOW = "\udf89"; // second half of 🎉
const EMOJI = "\ud83c\udf89"; // 🎉, a valid pair

test("clean input: the text is exactly JSON.stringify's (fast path)", () => {
  const value = { a: "plain", b: [1, 2.5, null, true], c: { d: "emoji 🎉 ok", e: "tab\tnewline\n" }, f: undefined };
  const { text, replaced } = jsonTextWithStats(value);
  assert.equal(text, JSON.stringify(value));
  assert.equal(replaced, 0);
  assert.equal(jsonText(value), JSON.stringify(value));
  // undefined stays what JSON.stringify returns (no parameter text at all).
  assert.equal(jsonText(undefined), JSON.stringify(undefined));
});

test("a lone high surrogate at the end of a string becomes U+FFFD", () => {
  const value = { sampleCopy: `Shop now and save\n${HIGH}` };
  assert.match(JSON.stringify(value), /\\ud83c/, "JSON.stringify writes the escape Postgres rejects");
  const { text, replaced } = jsonTextWithStats(value);
  assert.equal(replaced, 1);
  assert.doesNotMatch(text, /\\ud8/);
  assert.deepEqual(JSON.parse(text), { sampleCopy: `Shop now and save\n${FFFD}` });
});

test("a lone low surrogate becomes U+FFFD", () => {
  const { text, replaced } = jsonTextWithStats({ s: `${LOW}tail` });
  assert.equal(replaced, 1);
  assert.deepEqual(JSON.parse(text), { s: `${FFFD}tail` });
});

test("a valid surrogate pair (an emoji) is untouched", () => {
  const value = { s: `party ${EMOJI}!`, t: "\u{1F600}" };
  assert.equal(jsonText(value), JSON.stringify(value));
  assert.deepEqual(JSON.parse(jsonText(value)), value);
});

test("NUL becomes U+FFFD", () => {
  const { text, replaced } = jsonTextWithStats({ s: "a\u0000b" });
  assert.equal(replaced, 1);
  assert.equal(text, JSON.stringify({ s: `a${FFFD}b` }));
});

test("a backslash followed by 'ud83c' in text is not a surrogate and is untouched", () => {
  const value = { s: "C:\\ud83c\\file", t: "literal \\u0000 text" };
  const text = JSON.stringify(value);
  assert.ok(text.includes("\\\\ud83c"), "the text holds an escaped backslash, then ud83c");
  const out = jsonTextWithStats(value);
  assert.equal(out.text, text);
  assert.equal(out.replaced, 0);
  assert.deepEqual(JSON.parse(out.text), value);
});

test("nested objects, arrays and object keys are all cleaned; clean parts unchanged", () => {
  const value = {
    ok: "fine",
    list: ["a", `b${HIGH}`, { deep: [`${LOW}`, "c"] }],
    [`key${HIGH}`]: 1,
    ["nul\u0000key"]: { inner: "x\u0000" },
    emoji: EMOJI,
  };
  const { text, replaced } = jsonTextWithStats(value);
  assert.equal(replaced, 5);
  assert.deepEqual(JSON.parse(text), {
    ok: "fine",
    list: ["a", `b${FFFD}`, { deep: [FFFD, "c"] }],
    [`key${FFFD}`]: 1,
    [`nul${FFFD}key`]: { inner: `x${FFFD}` },
    emoji: EMOJI,
  });
  // Key order is kept.
  assert.deepEqual(Object.keys(JSON.parse(text)), ["ok", "list", `key${FFFD}`, `nul${FFFD}key`, "emoji"]);
});

test("the slow path cleans what JSON.stringify would write (toJSON, undefined members)", () => {
  const value = { at: new Date("2026-01-01T00:00:00.000Z"), gone: undefined, s: `x${HIGH}` };
  assert.equal(jsonText(value), JSON.stringify({ at: "2026-01-01T00:00:00.000Z", s: `x${FFFD}` }));
});

test("sanitizeJsonValue: same reference when clean, a cleaned copy otherwise (input untouched)", () => {
  const clean = { a: ["x", { b: EMOJI }], n: 1 };
  assert.equal(sanitizeJsonValue(clean), clean);

  const dirty = { a: ["x", { b: `y${HIGH}` }], keep: { z: 1 }, n: 1, ["k\u0000"]: true };
  const out = sanitizeJsonValueWithStats(dirty);
  assert.equal(out.replaced, 2);
  assert.deepEqual(out.value, { a: ["x", { b: `y${FFFD}` }], keep: { z: 1 }, n: 1, [`k${FFFD}`]: true });
  assert.equal(out.value.keep, dirty.keep, "clean branches are shared, not cloned");
  assert.equal(dirty.a[1] && (dirty.a[1] as { b: string }).b, `y${HIGH}`, "the input is not modified");
  assert.equal(sanitizeJsonValue(`s${LOW}`), `s${FFFD}`);
  assert.equal(sanitizeJsonValue(42), 42);
  assert.equal(sanitizeJsonValue(null), null);
});

test("a __proto__ key from parsed JSON stays an own key", () => {
  const parsed = JSON.parse(`{"__proto__":{"x":"a"},"s":"b\\ud83c"}`) as Record<string, unknown>;
  const out = sanitizeJsonValue(parsed);
  assert.ok(Object.prototype.hasOwnProperty.call(out, "__proto__"));
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(jsonText(parsed), `{"__proto__":{"x":"a"},"s":"b${FFFD}"}`);
});

/*
 * The rule: every JSON text written to a jsonb column goes through jsonText.
 * A JSON.stringify( in src/lib/data/*.ts must be in this list, with its reason.
 */
const ALLOWED: Array<{ file: string; contains: string; reason: string }> = [
  { file: "jsonText.ts", contains: "JSON.stringify(", reason: "jsonText itself" },
  { file: "audit.ts", contains: "`project-member:${JSON.stringify(", reason: "advisory lock key text (hashed), not stored" },
  { file: "spaces.ts", contains: "`space-member:${JSON.stringify(", reason: "advisory lock key text (hashed), not stored" },
  { file: "backup.ts", contains: "Buffer.from(JSON.stringify(manifest, null, 2))", reason: "backup manifest file in Storage, not jsonb" },
  { file: "importHistory.ts", contains: "const key = JSON.stringify([icp.source", reason: "in-memory map key" },
  { file: "importStore.ts", contains: "const key = JSON.stringify([icp.source", reason: "in-memory map key" },
  { file: "importStore.ts", contains: "`seq ${JSON.stringify(old)}", reason: "warning message text" },
  { file: "importStore.ts", contains: "${JSON.stringify(value) ?? \"undefined\"} is not an id", reason: "warning message text" },
  { file: "recreatedPages.ts", contains: "const json = JSON.stringify(heavy);", reason: "gzip heavy content in a bytea column (JSON escapes survive gzip; read back with JSON.parse)" },
  { file: "storageClient.ts", contains: "body: JSON.stringify(", reason: "Storage REST request body" },
  { file: "verifyImport.ts", contains: "JSON.stringify(key)", reason: "canonical JSON for hashing" },
  { file: "verifyImport.ts", contains: "return JSON.stringify(value) ?? \"null\";", reason: "canonical JSON for hashing" },
  { file: "verifyImport.ts", contains: "Buffer.byteLength(JSON.stringify(heavy))", reason: "byte length of the gzip content, which recreatedPages writes with JSON.stringify" },
];

test("src/lib/data: no JSON.stringify( outside jsonText.ts and the allow-list", () => {
  // Tests run from the repo root (npm test).
  const dir = path.resolve("src", "lib", "data");
  const offenders: string[] = [];
  const used = new Set<number>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    readFileSync(path.join(dir, file), "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (!line.includes("JSON.stringify(")) return;
        if (/^\s*(\*|\/\/)/.test(line)) return; // comments
        const allowed = ALLOWED.findIndex((a) => a.file === file && line.includes(a.contains));
        if (allowed === -1) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        else used.add(allowed);
      });
  }
  assert.deepEqual(offenders, [], "write jsonb parameters with jsonText(...) (src/lib/data/jsonText.ts)");
  const stale = ALLOWED.filter((_, i) => !used.has(i)).map((a) => `${a.file}: ${a.contains}`);
  assert.deepEqual(stale, [], "allow-list entries that no longer match a line: remove them");
});
