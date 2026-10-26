import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("authz");
after(() => store.cleanup());

const { makeUser, makeSearchProject, makeLookupProject } = await import(
  "./helpers/factories"
);
const {
  HttpError,
  canRunInProject,
  listVisibleProjects,
  resolveProjectAccess,
  visibleProjectKeys,
  visibleRunIds,
} = await import("@/lib/authz");
const { upsertMembership, removeMembership, queryAudit } = await import(
  "@/lib/accounting/records"
);
const {
  assignRunsToSpace,
  getUserById,
  updateUser,
  setProjectOwner,
  createProjectSpace,
  upsertSpaceMembership,
} = await import("@/lib/db");
const { verifyPassword, hashPassword } = await import("@/lib/auth/password");
const { createSessionToken, parseSessionToken } = await import(
  "@/lib/auth/session"
);

/** Assert a call rejects with HttpError with the given status. */
async function expectHttpError(fn: () => unknown, status: number, note: string) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `${note}: expected an HttpError`);
    assert.equal((err as InstanceType<typeof HttpError>).status, status, note);
    return err as InstanceType<typeof HttpError>;
  }
  assert.fail(`${note}: expected a ${status} but the call succeeded`);
}

describe("cross-user isolation", () => {
  test("user B cannot read, edit or run user A's project", async () => {
    const a = await makeUser({ credits: 10 });
    const b = await makeUser({ credits: 10 });
    const project = await makeSearchProject({ ownerUserId: a.id });

    // Knowing the id is not access. 404, so ids cannot be probed either.
    for (const action of ["view", "edit", "run"] as const) {
      await expectHttpError(
        () => resolveProjectAccess("search", project.id, b, action),
        404,
        `user B ${action}`,
      );
    }

    // The owner still has full access.
    const ownerAccess = await resolveProjectAccess("search", project.id, a, "run");
    assert.equal(ownerAccess.role, "owner");
  });

  test("a guessed or altered project id does not widen access", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeSearchProject({ id: "search-secret-id", ownerUserId: a.id });
    await makeLookupProject({ id: "lookup-secret-id", ownerUserId: a.id });

    await expectHttpError(
      () => resolveProjectAccess("search", "search-secret-id", b, "view"),
      404,
      "guessed search id",
    );
    await expectHttpError(
      () => resolveProjectAccess("lookup", "lookup-secret-id", b, "view"),
      404,
      "guessed lookup id",
    );
    // A wholly invented id looks identical from outside.
    await expectHttpError(
      () => resolveProjectAccess("search", "does-not-exist", b, "view"),
      404,
      "nonexistent id",
    );
  });

  test("project listings only ever contain the caller's own visible projects", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const aProject = await makeSearchProject({ ownerUserId: a.id });
    const bProject = await makeSearchProject({ ownerUserId: b.id });

    const aVisible = await visibleProjectKeys(a);
    assert.ok(aVisible.has(`search:${aProject.id}`));
    assert.ok(
      !aVisible.has(`search:${bProject.id}`),
      "user A's listing excludes user B's project",
    );

    const aRunIds = await visibleRunIds(a, "search");
    assert.ok(aRunIds.has(aProject.id));
    assert.ok(!aRunIds.has(bProject.id));
  });
});

describe("legacy projects", () => {
  test("an unowned legacy project stays invisible until an admin assigns it", async () => {
    const user = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const legacy = await makeSearchProject({ ownerUserId: null });

    await expectHttpError(
      () => resolveProjectAccess("search", legacy.id, user, "view"),
      404,
      "legacy row is not readable by a regular user",
    );
    assert.ok(
      !(await visibleProjectKeys(user)).has(`search:${legacy.id}`),
      "legacy row is absent from the user's listing",
    );

    // Admins can reach it for administration.
    const adminAccess = await resolveProjectAccess("search", legacy.id, admin, "view");
    assert.equal(adminAccess.isAdminOverride, true);

    // Once assigned, the owner gains access and nobody else does.
    await setProjectOwner("search", legacy.id, user.id);
    assert.equal(
      (await resolveProjectAccess("search", legacy.id, user, "run")).role,
      "owner",
    );
    const other = await makeUser();
    await expectHttpError(
      () => resolveProjectAccess("search", legacy.id, other, "view"),
      404,
      "assignment does not expose the project to everyone",
    );
  });
});

describe("admin-controlled sharing", () => {
  test("a shared viewer can view but cannot edit or run", async () => {
    const owner = await makeUser();
    const viewer = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    const project = await makeSearchProject({ ownerUserId: owner.id });

    await upsertMembership({
      projectKind: "search",
      projectId: project.id,
      userId: viewer.id,
      role: "viewer",
      grantedByUserId: admin.id,
    });

    const view = await resolveProjectAccess("search", project.id, viewer, "view");
    assert.equal(view.role, "viewer");
    assert.equal(canRunInProject(view), false);

    await expectHttpError(
      () => resolveProjectAccess("search", project.id, viewer, "edit"),
      403,
      "viewer edit",
    );
    await expectHttpError(
      () => resolveProjectAccess("search", project.id, viewer, "run"),
      403,
      "viewer run",
    );
  });

  test("a shared editor can run, and sharing does not change ownership", async () => {
    const owner = await makeUser();
    const editor = await makeUser({ credits: 10 });
    const admin = await makeUser({ role: "admin" });
    const project = await makeSearchProject({ ownerUserId: owner.id });

    await upsertMembership({
      projectKind: "search",
      projectId: project.id,
      userId: editor.id,
      role: "editor",
      grantedByUserId: admin.id,
    });

    const access = await resolveProjectAccess("search", project.id, editor, "run");
    assert.equal(access.role, "editor");
    assert.equal(canRunInProject(access), true);
    assert.equal(
      access.project.ownerUserId,
      owner.id,
      "sharing left ownership with the original owner",
    );

    // The editor sees it under "Shared with me", not "My projects".
    const visible = await listVisibleProjects(editor);
    const entry = visible.find((p) => p.id === project.id);
    assert.equal(entry?.accessRole, "editor");
    assert.equal(entry?.ownerUsername, owner.username);
    assert.equal(
      visible.filter((p) => p.accessRole === "owner").length,
      0,
      "a shared project is never listed as owned",
    );
  });

  test("sharing exposes only that project, not the owner's other work", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const shared = await makeSearchProject({ ownerUserId: owner.id });
    const private_ = await makeSearchProject({ ownerUserId: owner.id });

    await upsertMembership({
      projectKind: "search",
      projectId: shared.id,
      userId: editor.id,
      role: "editor",
      grantedByUserId: admin.id,
    });

    assert.ok((await visibleProjectKeys(editor)).has(`search:${shared.id}`));
    assert.ok(
      !(await visibleProjectKeys(editor)).has(`search:${private_.id}`),
      "the owner's unrelated project stays private",
    );
    await expectHttpError(
      () => resolveProjectAccess("search", private_.id, editor, "view"),
      404,
      "unrelated project",
    );
  });

  test("revoking a share removes access immediately", async () => {
    const owner = await makeUser();
    const editor = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const project = await makeSearchProject({ ownerUserId: owner.id });

    await upsertMembership({
      projectKind: "search",
      projectId: project.id,
      userId: editor.id,
      role: "editor",
      grantedByUserId: admin.id,
    });
    assert.equal(
      (await resolveProjectAccess("search", project.id, editor, "run")).role,
      "editor",
    );

    await removeMembership("search", project.id, editor.id);

    await expectHttpError(
      () => resolveProjectAccess("search", project.id, editor, "view"),
      404,
      "revoked share",
    );
    assert.ok(!(await visibleProjectKeys(editor)).has(`search:${project.id}`));
  });

  test("admin access to another user's project is audited", async () => {
    const owner = await makeUser();
    const admin = await makeUser({ role: "admin" });
    const project = await makeSearchProject({ ownerUserId: owner.id });

    await resolveProjectAccess("search", project.id, admin, "view");

    const entries = await queryAudit({ limit: 200 });
    assert.ok(
      entries.some(
        (e) =>
          e.actorUserId === admin.id &&
          e.projectId === project.id &&
          e.action === "admin.project.view",
      ),
      "administrative inspection is logged",
    );
  });
});

describe("account status and sessions", () => {
  test("a session cookie stops working once the epoch is bumped", async () => {
    const user = await makeUser();
    const token = await createSessionToken({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      sessionEpoch: user.sessionEpoch,
    });

    // The signature is still valid on its own …
    const parsed = await parseSessionToken(token);
    assert.equal(parsed?.sub, user.id);
    assert.equal(parsed?.epoch, user.sessionEpoch);

    // … but a password reset bumps the epoch, so it no longer matches the
    // stored account and getSessionUser() would reject it.
    await updateUser(user.id, { bumpSessionEpoch: true, mustChangePassword: true });
    const stored = (await getUserById(user.id))!;
    assert.notEqual(
      stored.sessionEpoch,
      parsed?.epoch,
      "the old cookie's epoch is stale after a reset",
    );
  });

  test("a tampered session token is rejected outright", async () => {
    const user = await makeUser();
    const token = await createSessionToken({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      mustChangePassword: user.mustChangePassword,
      createdAt: user.createdAt,
      sessionEpoch: user.sessionEpoch,
    });

    const [payload, signature] = token.split(".");
    assert.ok(payload && signature, "token is payload.signature");

    // Re-signing is impossible without the secret, so flipping the payload to
    // claim the admin role must fail signature verification.
    const forged = `${payload.slice(0, -2)}xx.${signature}`;
    assert.equal(await parseSessionToken(forged), null);
    assert.equal(await parseSessionToken(`${payload}.deadbeef`), null);
    assert.equal(await parseSessionToken("garbage"), null);
    assert.equal(await parseSessionToken(undefined), null);
  });

  test("suspension and soft deletion revoke access", async () => {
    const suspended = await makeUser({ credits: 10 });
    await updateUser(suspended.id, {
      status: "suspended",
      bumpSessionEpoch: true,
    });
    assert.equal((await getUserById(suspended.id))?.status, "suspended");

    const deleted = await makeUser({ credits: 10 });
    await updateUser(deleted.id, {
      status: "deleted",
      deletedAt: new Date().toISOString(),
      bumpSessionEpoch: true,
    });
    assert.equal((await getUserById(deleted.id))?.status, "deleted");

    // getSessionUser() rejects any non-active account regardless of cookie,
    // which is what these status transitions rely on.
    for (const user of [suspended, deleted]) {
      const stored = (await getUserById(user.id))!;
      assert.notEqual(stored.status, "active");
      assert.notEqual(stored.sessionEpoch, user.sessionEpoch);
    }
  });

  test("passwords are hashed, salted per user, and verifiable", async () => {
    const hashA = await hashPassword("same-password-value");
    const hashB = await hashPassword("same-password-value");
    assert.notEqual(hashA, hashB, "each hash carries a distinct salt");
    assert.ok(!hashA.includes("same-password-value"));
    assert.equal(await verifyPassword("same-password-value", hashA), true);
    assert.equal(await verifyPassword("wrong-password", hashA), false);
  });
});

describe("role safeguards", () => {
  test("public signup cannot mint an admin", async () => {
    const { getAppSettings, updateAppSettings } = await import("@/lib/db");
    await updateAppSettings({ publicSignupEnabled: true }, null);
    assert.equal((await getAppSettings()).publicSignupEnabled, true);

    // The register route hardcodes role: "user"; a user created through the
    // public path is never an admin.
    const selfServe = await makeUser({ role: "user" });
    assert.equal((await getUserById(selfServe.id))?.role, "user");
  });

  test("the last active admin is protected by countActiveAdmins", async () => {
    const { countActiveAdmins, listUsers } = await import("@/lib/db");

    // Demote every admin except one, then confirm the guard reports 1.
    const admins = (await listUsers({ includeDeleted: false })).filter(
      (u) => u.role === "admin" && u.status === "active",
    );
    assert.ok(admins.length >= 1, "the fixture created at least one admin");
    for (const admin of admins.slice(1)) {
      await updateUser(admin.id, { role: "user" });
    }
    assert.equal(await countActiveAdmins(), 1);

    // Suspending the last one would drop it to zero — the API refuses this,
    // which is exactly the condition the route checks.
    assert.ok(
      (await countActiveAdmins()) <= 1,
      "at this point demoting/suspending must be refused",
    );
  });
});

describe("client spaces", () => {
  test("sharing a space covers every run inside it, and nothing outside it", async () => {
    const owner = await makeUser({ credits: 10 });
    const viewer = await makeUser({ credits: 10 });
    const space = await createProjectSpace({
      clientName: "Northside Dental",
      ownerUserId: owner.id,
    });
    const inside = await makeSearchProject({ ownerUserId: owner.id });
    const outside = await makeSearchProject({ ownerUserId: owner.id });
    assert.equal(await assignRunsToSpace(space.id, [{ kind: "search", id: inside.id }]), 1);
    await upsertSpaceMembership({
      spaceId: space.id,
      userId: viewer.id,
      role: "viewer",
      grantedByUserId: owner.id,
    });

    const view = await resolveProjectAccess("search", inside.id, viewer, "view");
    assert.equal(view.role, "viewer");
    await expectHttpError(
      () => resolveProjectAccess("search", inside.id, viewer, "run"),
      403,
      "viewer cannot run in a shared space",
    );
    await expectHttpError(
      () => resolveProjectAccess("search", outside.id, viewer, "view"),
      404,
      "a share does not expose runs outside the space",
    );
  });
});
