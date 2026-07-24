#!/usr/bin/env node
/**
 * Upload local data/store.json into a deployed AdRival instance.
 *
 * Usage:
 *   node scripts/import-history.mjs --url https://your-app.up.railway.app --secret YOUR_SECRET
 *   node scripts/import-history.mjs --url https://... --secret ... --mode merge
 *
 * Env alternatives:
 *   ADRIVAL_URL, HISTORY_IMPORT_SECRET
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const storePath = path.join(root, "data", "store.json");

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const url = (arg("url") || process.env.ADRIVAL_URL || "").replace(/\/$/, "");
const secret = arg("secret") || process.env.HISTORY_IMPORT_SECRET || "";
const mode = (arg("mode") || "replace").toLowerCase() === "merge" ? "merge" : "replace";

if (!url || !secret) {
  console.error(
    "Missing --url / ADRIVAL_URL or --secret / HISTORY_IMPORT_SECRET",
  );
  process.exit(1);
}

if (!fs.existsSync(storePath)) {
  console.error(`Local store not found: ${storePath}`);
  process.exit(1);
}

const body = fs.readFileSync(storePath, "utf8");
JSON.parse(body); // validate

const endpoint = `${url}/api/admin/import-history?mode=${mode}`;
console.log(`Uploading ${storePath} (${body.length} bytes) → ${endpoint}`);

const res = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${secret}`,
  },
  body,
});

const text = await res.text();
let json;
try {
  json = JSON.parse(text);
} catch {
  json = { raw: text };
}

if (!res.ok) {
  console.error("Import failed:", res.status, json);
  process.exit(1);
}

console.log("Import ok:", JSON.stringify(json, null, 2));
