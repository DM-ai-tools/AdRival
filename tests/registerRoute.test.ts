import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { setClientForTests, type Queryable, type TestClient } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import { updateAppSettings } from "../src/lib/data/settings";
import { jsonRequest, readJson } from "./helpers/routeRequest";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * POST /api/auth/register is reachable without a session: a database failure
 * must come back as a generic message (500), never the raw database text;
 * validation and duplicate-username messages stay user-facing (400/409).
 */

process.env.SESSION_SECRET ??= "register-route-test-secret";

const registerRoute = await import("../src/app/api/auth/register/route");

const DB_ERROR =
  'duplicate key value violates unique constraint "users_pkey" (postgres at db.abcdefghijklmnop.supabase.co:5432, SQL: insert into users)';

let client: PgliteTestClient;
let failUserInsert = false;

/** The PGlite client, except that `insert into users` fails like a real database error while failUserInsert is set. */
function failingClient(base: PgliteTestClient): TestClient {
  const guard = (q: Queryable): Queryable => ({
    query: (text, params) => {
      if (failUserInsert && /insert into users/i.test(text)) return Promise.reject(new Error(DB_ERROR));
      return q.query(text, params);
    },
  });
  return {
    query: (text, params) => guard(base).query(text, params),
    tx: (fn, opts) => base.tx((t) => fn(guard(t)), opts),
  };
}

before(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests(failingClient(client));
  await updateAppSettings({ publicSignupEnabled: true }, null);
});

after(async () => {
  setClientForTests(null);
  await client.close();
});

const register = (body: unknown) =>
  registerRoute.POST(jsonRequest("http://localhost/api/auth/register", "POST", body)).then(readJson);

const valid = (username: string) => ({
  username,
  displayName: "New Person",
  password: "a-long-password-123",
  confirmPassword: "a-long-password-123",
});

test("a failing database write returns a generic 500 without database details", async (t) => {
  const logged: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    logged.push(args);
  });
  failUserInsert = true;
  try {
    const { status, body } = await register(valid("dbfailure"));
    assert.equal(status, 500);
    assert.equal(body.error, "Could not create the account. Please try again.");
    const text = JSON.stringify(body);
    for (const leak of [/postgres/i, /supabase/i, /insert into/i, /constraint/i, /users_pkey/, /5432/]) {
      assert.doesNotMatch(text, leak);
    }
  } finally {
    failUserInsert = false;
  }
  assert.ok(
    logged.some((args) => args.some((a) => String(a instanceof Error ? a.message : a).includes("users_pkey"))),
    "the detail is logged server-side",
  );
});

test("validation messages stay user-facing (400)", async () => {
  const { status, body } = await register({ ...valid("shortpw"), password: "x", confirmPassword: "x" });
  assert.equal(status, 400);
  assert.equal(typeof body.error, "string");
  assert.notEqual(body.error, "Could not create the account. Please try again.");
});

test("a taken username stays a clear message", async () => {
  assert.equal((await register(valid("takenname"))).status, 200);
  const { status, body } = await register(valid("takenname"));
  assert.ok(status === 409 || status === 400);
  assert.equal(body.error, "Username already taken");
});
