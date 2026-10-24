import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import * as identity from "../src/lib/data/identity";
import { bootstrapFirstAdmin } from "../src/lib/auth/bootstrap";
import { HttpError, assertNotLastActiveAdmin, lastActiveAdminGuard } from "../src/lib/authz";
import type { AppUser } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

/*
 * The identity invariants that used to be safe because the file store was
 * synchronous: bootstrap creates or promotes an admin only while none exists,
 * and the last active (organisation) admin cannot be demoted. Each check runs
 * as a guard inside the write's transaction, so concurrent requests cannot
 * both pass it.
 */

let cleanup: () => Promise<void> = async () => {};
const TOKEN = "bootstrap-secret";

before(async () => {
  ({ cleanup } = await useTestDb("admin-guards"));
  process.env.ADMIN_BOOTSTRAP_TOKEN = TOKEN;
});

after(async () => {
  delete process.env.ADMIN_BOOTSTRAP_TOKEN;
  delete process.env.ADMIN_BOOTSTRAP_USERNAME;
  await cleanup();
});

test("two bootstrap requests at once create exactly one admin", async () => {
  process.env.ADMIN_BOOTSTRAP_USERNAME = "founder";
  const results = await Promise.all([bootstrapFirstAdmin(TOKEN), bootstrapFirstAdmin(TOKEN)]);
  const actions = results.map((r) => r.action).sort();
  assert.deepEqual(actions, ["created", "noop"]);
  assert.equal(await identity.countActiveAdmins(), 1);
  const created = results.find((r) => r.action === "created")!;
  assert.ok(created.temporaryPassword);
  const noop = results.find((r) => r.action === "noop")!;
  assert.equal(noop.ok, false);
  assert.match(noop.message, /administrator already exists/);
});

test("bootstrap refuses once an admin exists", async () => {
  const result = await bootstrapFirstAdmin(TOKEN);
  assert.equal(result.action, "noop");
  assert.equal((await bootstrapFirstAdmin("wrong")).message, "Invalid bootstrap token.");
});

test("two bootstrap requests promoting an existing account promote it once", async () => {
  // No active admin again: the founder is suspended.
  const founder = await identity.getUserByUsername("founder");
  await identity.updateUser(founder!.id, { status: "suspended" });
  assert.equal(await identity.countActiveAdmins(), 0);

  const carol = await identity.createUser({ username: "carol", displayName: "Carol", passwordHash: "x" });
  process.env.ADMIN_BOOTSTRAP_USERNAME = "carol";
  const results = await Promise.all([bootstrapFirstAdmin(TOKEN), bootstrapFirstAdmin(TOKEN)]);
  assert.deepEqual(results.map((r) => r.action).sort(), ["noop", "promoted"]);
  const promoted = await identity.getUserById(carol.id);
  assert.equal(promoted?.role, "admin");
  assert.equal(promoted?.sessionEpoch, carol.sessionEpoch + 1, "the session epoch is bumped once");
  assert.equal(await identity.countActiveAdmins(), 1);
});

async function admin(username: string, orgId: string | null = null): Promise<AppUser> {
  return identity.createUser({ username, displayName: username, passwordHash: "x", role: "admin", orgId });
}

test("the last active admin cannot be demoted; the guard runs inside the update", async () => {
  const carol = (await identity.getUserByUsername("carol"))!;
  await assert.rejects(
    identity.updateUser(carol.id, { role: "user" }, { guard: lastActiveAdminGuard(carol) }),
    (err: unknown) => err instanceof HttpError && err.status === 409 && err.code === "last_admin",
  );
  assert.equal((await identity.getUserById(carol.id))?.role, "admin", "nothing was written");
});

test("two admins demoting each other at once: exactly one succeeds", async () => {
  const dave = await admin("dave");
  const carol = (await identity.getUserByUsername("carol"))!;
  assert.equal(await identity.countActiveAdmins(), 2);
  const results = await Promise.allSettled([
    identity.updateUser(carol.id, { role: "user" }, { guard: lastActiveAdminGuard(dave) }),
    identity.updateUser(dave.id, { role: "user" }, { guard: lastActiveAdminGuard(carol) }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await identity.countActiveAdmins(), 1);
});

test("an organisation keeps one active admin of its own when an org admin acts", async () => {
  const org = await identity.createOrganization({ name: "Acme", createdByUserId: null });
  const erin = await admin("erin", org.id);
  const frank = await admin("frank", org.id);
  // Two org admins: one may be demoted by the other.
  await identity.updateUser(frank.id, { role: "user" }, { guard: lastActiveAdminGuard(erin) });
  await assert.rejects(
    identity.updateUser(erin.id, { status: "suspended" }, { guard: (prev, tx) => assertNotLastActiveAdmin(prev, erin, tx) }),
    (err: unknown) => err instanceof HttpError && err.code === "last_org_admin",
  );
  // A platform admin (no organisation) may override the organisation rule.
  const platform = (await identity.listUsers()).find((u) => u.role === "admin" && u.status === "active" && !u.orgId)!;
  const demoted = await identity.updateUser(erin.id, { role: "user" }, { guard: lastActiveAdminGuard(platform) });
  assert.equal(demoted?.role, "user");
});

test("the guard ignores accounts that are not active admins", async () => {
  const user = await identity.createUser({ username: "gina", displayName: "Gina", passwordHash: "x" });
  const actor = (await identity.listUsers()).find((u) => u.role === "admin" && u.status === "active")!;
  const updated = await identity.updateUser(user.id, { status: "suspended" }, { guard: lastActiveAdminGuard(actor) });
  assert.equal(updated?.status, "suspended");
});
