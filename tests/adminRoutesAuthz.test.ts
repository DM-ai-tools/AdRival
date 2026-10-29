import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { setClientForTests, type Queryable } from "../src/lib/data/client";
import * as identity from "../src/lib/data/identity";
import { migrate } from "../src/lib/data/migrate";
import type { AppUser } from "../src/lib/types";
import { asUser, jsonRequest, readJson, routeParams } from "./helpers/routeRequest";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * The admin user routes, called as route handlers against a real (PGlite)
 * database. These guard the async migration: an authorization helper or a
 * last-admin guard that is no longer awaited would silently let these through.
 */

process.env.SESSION_SECRET = "admin-routes-authz-test-secret";

const usersRoute = await import("../src/app/api/admin/users/route");
const userRoute = await import("../src/app/api/admin/users/[userId]/route");

const BASE = "http://localhost/api/admin/users";

/*
 * A race needs both requests past sign-in and the early last-admin check
 * before either writes. The test database runs one statement at a time, so
 * without help one request can finish before the other starts. While armed,
 * the barrier holds every transaction at its start until `parties` have
 * arrived (the first transaction of these routes is the user update), so both
 * requests are about to write when the first one goes ahead.
 */
let barrier: { parties: number; waiting: Array<() => void> } | null = null;

function armBarrier(parties: number) {
  barrier = { parties, waiting: [] };
}

async function atBarrier(): Promise<void> {
  const current = barrier;
  if (!current) return;
  await new Promise<void>((resolve) => {
    current.waiting.push(resolve);
    if (current.waiting.length >= current.parties) {
      barrier = null;
      for (const release of current.waiting) release();
    }
  });
}

let client: PgliteTestClient;

beforeEach(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests({
    query: (text, params) => client.query(text, params),
    tx: async <T>(fn: (t: Queryable) => Promise<T>) => {
      await atBarrier();
      return client.tx(fn);
    },
  });
});

afterEach(async () => {
  barrier = null;
  setClientForTests(null);
  await client.close();
});

async function makeUser(
  username: string,
  options: { role?: "admin" | "user"; orgId?: string | null } = {},
): Promise<AppUser> {
  return identity.createUser({
    username,
    displayName: username,
    passwordHash: "x",
    role: options.role ?? "user",
    orgId: options.orgId ?? null,
  });
}

function patchUser(actor: AppUser, targetId: string, body: unknown) {
  return asUser(actor, async () =>
    readJson(await userRoute.PATCH(jsonRequest(`${BASE}/${targetId}`, "PATCH", body), routeParams({ userId: targetId }))),
  );
}

function deleteUser(actor: AppUser, targetId: string, query = "projects=archive") {
  return asUser(actor, async () =>
    readJson(
      await userRoute.DELETE(jsonRequest(`${BASE}/${targetId}?${query}`, "DELETE"), routeParams({ userId: targetId })),
    ),
  );
}

function getUser(actor: AppUser | null, targetId: string) {
  return asUser(actor, async () =>
    readJson(await userRoute.GET(jsonRequest(`${BASE}/${targetId}`, "GET"), routeParams({ userId: targetId }))),
  );
}

test("a signed-in non-admin gets 403 on the admin user routes, and nothing changes", async () => {
  const admin = await makeUser("root", { role: "admin" });
  const plain = await makeUser("plain");

  const list = await asUser(plain, async () => readJson(await usersRoute.GET(jsonRequest(BASE, "GET"))));
  assert.equal(list.status, 403);
  assert.equal(list.body.code, "forbidden");

  assert.equal((await getUser(plain, admin.id)).status, 403);

  const patch = await patchUser(plain, plain.id, { role: "admin" });
  assert.equal(patch.status, 403);
  assert.equal((await identity.getUserById(plain.id))?.role, "user", "no self-promotion");

  const del = await deleteUser(plain, admin.id);
  assert.equal(del.status, 403);
  assert.equal((await identity.getUserById(admin.id))?.status, "active");

  const create = await asUser(plain, async () =>
    readJson(await usersRoute.POST(jsonRequest(BASE, "POST", { email: "sneaky@example.com", displayName: "Sneaky" }))),
  );
  assert.equal(create.status, 403);
  assert.equal(await identity.getUserByUsername("sneaky"), null);

  // No session at all is 401.
  assert.equal((await getUser(null, admin.id)).status, 401);
});

test("an organisation admin cannot see or change another organisation's users", async () => {
  await makeUser("root", { role: "admin" });
  const acme = await identity.createOrganization({ name: "Acme", createdByUserId: null });
  const globex = await identity.createOrganization({ name: "Globex", createdByUserId: null });
  const acmeAdmin = await makeUser("acme-admin", { role: "admin", orgId: acme.id });
  const globexAdmin = await makeUser("globex-admin", { role: "admin", orgId: globex.id });
  const globexUser = await makeUser("globex-user", { orgId: globex.id });
  const platformUser = await makeUser("platform-user");

  for (const target of [globexUser, globexAdmin, platformUser]) {
    const read = await getUser(acmeAdmin, target.id);
    assert.equal(read.status, 404, `GET ${target.username}`);
    assert.equal(read.body.code, "not_found");

    const patch = await patchUser(acmeAdmin, target.id, { status: "suspended", displayName: "Hacked" });
    assert.equal(patch.status, 404, `PATCH ${target.username}`);

    const del = await deleteUser(acmeAdmin, target.id);
    assert.equal(del.status, 404, `DELETE ${target.username}`);

    const stored = await identity.getUserById(target.id);
    assert.equal(stored?.status, "active", `${target.username} untouched`);
    assert.equal(stored?.displayName, target.username);
  }

  // The list only shows Acme's own accounts.
  const list = await asUser(acmeAdmin, async () => readJson(await usersRoute.GET(jsonRequest(BASE, "GET"))));
  assert.equal(list.status, 200);
  const names = (list.body.users as Array<{ username: string }>).map((u) => u.username);
  assert.deepEqual(names, ["acme-admin"]);

  // Inside its own organisation the same admin can act.
  const colleague = await makeUser("acme-user", { orgId: acme.id });
  const ok = await patchUser(acmeAdmin, colleague.id, { displayName: "Renamed" });
  assert.equal(ok.status, 200);
  assert.equal((await identity.getUserById(colleague.id))?.displayName, "Renamed");
});

async function twoAdmins(): Promise<[AppUser, AppUser]> {
  const a = await makeUser("admin-a", { role: "admin" });
  const b = await makeUser("admin-b", { role: "admin" });
  assert.equal(await identity.countActiveAdmins(), 2);
  return [a, b];
}

function assertOneRefusedAsLastAdmin(results: Array<{ status: number; body: Record<string, unknown> }>, code = "last_admin") {
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify(results));
  const refused = results.find((r) => r.status === 409)!;
  assert.equal(refused.body.code, code);
}

test("two admins demoting each other at once: one is refused with 409 last_admin", async () => {
  const [a, b] = await twoAdmins();
  armBarrier(2);
  const results = await Promise.all([patchUser(a, b.id, { role: "user" }), patchUser(b, a.id, { role: "user" })]);
  assertOneRefusedAsLastAdmin(results);
  assert.equal(await identity.countActiveAdmins(), 1, "at least one active admin remains");
});

test("two admins suspending each other at once: one is refused with 409 last_admin", async () => {
  const [a, b] = await twoAdmins();
  armBarrier(2);
  const results = await Promise.all([
    patchUser(a, b.id, { status: "suspended" }),
    patchUser(b, a.id, { status: "suspended" }),
  ]);
  assertOneRefusedAsLastAdmin(results);
  assert.equal(await identity.countActiveAdmins(), 1);
});

test("two admins deleting each other at once: one is refused with 409 last_admin and changes nothing", async () => {
  const [a, b] = await twoAdmins();
  armBarrier(2);
  const results = await Promise.all([deleteUser(a, b.id), deleteUser(b, a.id)]);
  assertOneRefusedAsLastAdmin(results);
  assert.equal(await identity.countActiveAdmins(), 1);
  const users = [await identity.getUserById(a.id), await identity.getUserById(b.id)];
  assert.deepEqual(users.map((u) => u?.status).sort(), ["active", "deleted"]);
});

test("demote and suspend racing each other on two admins still leave one", async () => {
  const [a, b] = await twoAdmins();
  armBarrier(2);
  const results = await Promise.all([patchUser(a, b.id, { role: "user" }), patchUser(b, a.id, { status: "suspended" })]);
  assertOneRefusedAsLastAdmin(results);
  assert.equal(await identity.countActiveAdmins(), 1);
});

test("two organisation admins demoting each other at once: one is refused with 409 last_org_admin", async () => {
  await makeUser("root", { role: "admin" });
  const acme = await identity.createOrganization({ name: "Acme", createdByUserId: null });
  const a = await makeUser("acme-a", { role: "admin", orgId: acme.id });
  const b = await makeUser("acme-b", { role: "admin", orgId: acme.id });
  armBarrier(2);
  const results = await Promise.all([patchUser(a, b.id, { role: "user" }), patchUser(b, a.id, { role: "user" })]);
  assertOneRefusedAsLastAdmin(results, "last_org_admin");
  assert.equal(await identity.countActiveOrgAdmins(acme.id), 1);
});

test("an admin cannot demote, suspend or delete their own account", async () => {
  const [a] = await twoAdmins();
  assert.equal((await patchUser(a, a.id, { role: "user" })).body.code, "self_lockout");
  assert.equal((await patchUser(a, a.id, { status: "suspended" })).body.code, "self_lockout");
  assert.equal((await deleteUser(a, a.id)).body.code, "self_delete");
  assert.equal(await identity.countActiveAdmins(), 2);
});

test("a change racing a delete never brings the deleted account back", async () => {
  const [a, b] = await twoAdmins();
  const target = await makeUser("leaving");
  armBarrier(2);
  const [del, patch] = await Promise.all([deleteUser(a, target.id), patchUser(b, target.id, { status: "suspended" })]);
  assert.equal(del.status, 200);
  if (patch.status !== 200) {
    assert.equal(patch.status, 409);
    assert.equal(patch.body.code, "user_deleted");
  }
  assert.equal((await identity.getUserById(target.id))?.status, "deleted");
});
