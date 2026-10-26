import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertArchiveStorage,
  loadScriptEnv,
  parseArgs,
  parseEnvText,
  supabaseRefOfDbUrl,
  supabaseRefOfProjectUrl,
} from "../scripts/storeScriptArgs";

/*
 * The shared script helper: every script (import, verify, backup, load test)
 * loads .env.local then .env from the repo root without overriding the shell,
 * and the import refuses --archive-days before writing anything when Storage
 * is not configured (or belongs to another Supabase project).
 */

const dirs: string[] = [];
const touched = ["SCRIPTENV_A", "SCRIPTENV_B", "SCRIPTENV_C", "SCRIPTENV_D"];

function tempRoot(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "script-env-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const key of touched) delete process.env[key];
});

test("loadScriptEnv: the shell wins, .env.local fills gaps before .env, values are never printed", () => {
  for (const key of touched) delete process.env[key];
  process.env.SCRIPTENV_A = "from-shell";
  const root = tempRoot({
    ".env.local": "SCRIPTENV_A=local-a\nSCRIPTENV_B=local-b\n",
    ".env": "SCRIPTENV_B=env-b\nSCRIPTENV_C=env-c\n",
  });
  const lines: string[] = [];
  const loaded = loadScriptEnv({ root, log: (line) => lines.push(line) });

  assert.deepEqual(loaded, [".env.local", ".env"]);
  assert.equal(process.env.SCRIPTENV_A, "from-shell", "a variable set in the shell is never overridden");
  assert.equal(process.env.SCRIPTENV_B, "local-b", ".env.local wins over .env");
  assert.equal(process.env.SCRIPTENV_C, "env-c", ".env fills what is still missing");
  const printed = lines.join("\n");
  assert.match(printed, /\.env\.local/);
  assert.doesNotMatch(printed, /local-a|local-b|env-b|env-c|from-shell/, "names only, never values");
});

test("loadScriptEnv: no env files is fine and says so", () => {
  const root = tempRoot({});
  const lines: string[] = [];
  assert.deepEqual(loadScriptEnv({ root, log: (line) => lines.push(line) }), []);
  assert.match(lines.join("\n"), /none/i);
});

test("loadScriptEnv: only .env present", () => {
  delete process.env.SCRIPTENV_D;
  const root = tempRoot({ ".env": "SCRIPTENV_D=only-env\n" });
  assert.deepEqual(loadScriptEnv({ root, log: () => {} }), [".env"]);
  assert.equal(process.env.SCRIPTENV_D, "only-env");
});

test("parseEnvText (fallback parser): comments, export, quotes", () => {
  assert.deepEqual(
    parseEnvText('# comment\nexport A=1\nB="two words"\nC=\'x=y\'\n\nD = spaced \nE=a#b\nbad line\n'),
    { A: "1", B: "two words", C: "x=y", D: "spaced", E: "a#b" },
  );
});

test("--url still wins over DATABASE_DIRECT_URL from the environment", () => {
  const before = process.env.DATABASE_DIRECT_URL;
  process.env.DATABASE_DIRECT_URL = "postgresql://env-host:5432/postgres";
  try {
    assert.equal(parseArgs([]).url, "postgresql://env-host:5432/postgres");
    assert.equal(parseArgs(["--url", "postgresql://flag-host:5432/postgres"]).url, "postgresql://flag-host:5432/postgres");
  } finally {
    if (before === undefined) delete process.env.DATABASE_DIRECT_URL;
    else process.env.DATABASE_DIRECT_URL = before;
  }
});

const SESSION = "postgresql://postgres.abcdefghijklmnop:pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const DIRECT = "postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres";

test("Supabase project refs are read from database and project URLs", () => {
  assert.equal(supabaseRefOfDbUrl(SESSION), "abcdefghijklmnop");
  assert.equal(supabaseRefOfDbUrl(DIRECT), "abcdefghijklmnop");
  assert.equal(supabaseRefOfDbUrl("postgresql://u:p@localhost:5432/db"), null);
  assert.equal(supabaseRefOfProjectUrl("https://abcdefghijklmnop.supabase.co"), "abcdefghijklmnop");
  assert.equal(supabaseRefOfProjectUrl("http://localhost:54321"), null);
});

test("import --archive-days without Storage settings is refused before anything is written", () => {
  const args = { ...parseArgs(["--archive-days", "14", "--url", SESSION]) };
  assert.throws(
    () => assertArchiveStorage(args, {}),
    (err: Error) => /SUPABASE_URL/.test(err.message) && /SUPABASE_SERVICE_ROLE_KEY/.test(err.message),
  );
  assert.throws(() => assertArchiveStorage(args, { SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" }), /SUPABASE_SERVICE_ROLE_KEY/);
});

test("import --archive-days refuses Storage of another Supabase project than the database", () => {
  const args = parseArgs(["--archive-days", "14", "--url", SESSION]);
  assert.throws(
    () => assertArchiveStorage(args, { SUPABASE_URL: "https://zzzzzzzzzzzzzzzz.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }),
    /different Supabase project/,
  );
  assert.doesNotThrow(() =>
    assertArchiveStorage(args, { SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }),
  );
});

test("no refusal without --archive-days or on a dry run", () => {
  assert.doesNotThrow(() => assertArchiveStorage(parseArgs(["--url", SESSION]), {}));
  assert.doesNotThrow(() => assertArchiveStorage(parseArgs(["--archive-days", "14", "--dry-run"]), {}));
});
