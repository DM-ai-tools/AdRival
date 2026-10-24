import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../src/lib/data/client";
import * as identity from "../src/lib/data/identity";
import * as settings from "../src/lib/data/settings";
import * as spaces from "../src/lib/data/spaces";
import * as audit from "../src/lib/data/audit";
import * as runs from "../src/lib/data/runs";
import { SEED_RULE_VERSION } from "../src/lib/accounting/conversion";
import type { LookupJob, SearchJob } from "../src/lib/types";
import { useTestDb } from "./helpers/testDb";

let cleanup: () => Promise<void> = async () => {};

before(async () => {
  ({ cleanup } = await useTestDb("identity"));
});

after(async () => {
  await cleanup();
});

let seq = 0;

function makeJob(overrides: Partial<SearchJob> = {}): SearchJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `job-${seq}`,
    keyword: `keyword ${seq}`,
    status: "done",
    progress: {
      stage: "done",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 10,
      rejected: 0,
      message: "Done",
    },
    competitorIds: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as SearchJob;
}

function makeLookup(overrides: Partial<LookupJob> = {}): LookupJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `lookup-${seq}`,
    queryName: `brand ${seq}`,
    status: "done",
    progress: { stage: "done", message: "Done" },
    candidates: [],
    adIds: [],
    createdAt: at,
    updatedAt: at,
    ...overrides,
  } as unknown as LookupJob;
}

async function newUser(name: string, extra: Partial<Parameters<typeof identity.createUser>[0]> = {}) {
  return identity.createUser({
    username: name,
    displayName: ` ${name} display `,
    passwordHash: "hash",
    ...extra,
  });
}

/* ── users ── */

test("createUser, getUserById, updateUser", async () => {
  const user = await newUser("  Alice ");
  assert.equal(user.username, "alice");
  assert.equal(user.displayName, "Alice  display");
  assert.equal(user.role, "user");
  assert.equal(user.status, "active");
  assert.equal(user.sessionEpoch, 1);
  assert.equal(user.orgId, null);

  assert.deepEqual(await identity.getUserById(user.id), user);
  assert.equal(await identity.getUserById("missing"), null);

  const updated = await identity.updateUser(user.id, {
    displayName: "  New Name ",
    lastLoginAt: "2026-10-01T00:00:00.000Z",
    bumpSessionEpoch: true,
  });
  assert.ok(updated);
  assert.equal(updated.displayName, "New Name");
  assert.equal(updated.sessionEpoch, 2);
  assert.equal(updated.lastLoginAt, "2026-10-01T00:00:00.000Z");
  assert.equal("bumpSessionEpoch" in updated, false);
  assert.deepEqual(await identity.getUserById(user.id), updated);
  assert.equal(await identity.updateUser("missing", { displayName: "x" }), null);

  const pub = identity.toPublicUser(updated);
  assert.equal("passwordHash" in pub, false);
  assert.equal(pub.username, "alice");
});

test("usernames are unique and looked up case-insensitively", async () => {
  const bob = await newUser("bob");
  await assert.rejects(newUser("BOB"), /Username already taken/);
  assert.equal((await identity.getUserByUsername("  BoB "))?.id, bob.id);
  assert.equal(await identity.getUserByUsername("nobody"), null);
});

test("listUsers hides deleted users unless asked", async () => {
  const gone = await newUser("gone-user");
  await identity.updateUser(gone.id, { status: "deleted", deletedAt: new Date().toISOString() });
  const visible = await identity.listUsers();
  assert.equal(visible.some((u) => u.id === gone.id), false);
  const all = await identity.listUsers({ includeDeleted: true });
  assert.equal(all.some((u) => u.id === gone.id), true);
});

test("countActiveAdmins counts only active admins; status and role columns follow updates", async () => {
  const before = await identity.countActiveAdmins();
  const a1 = await newUser("admin-one", { role: "admin" });
  await newUser("admin-two", { role: "admin", status: "suspended" });
  await newUser("plain-user");
  assert.equal(await identity.countActiveAdmins(), before + 1);
  await identity.updateUser(a1.id, { role: "user" });
  assert.equal(await identity.countActiveAdmins(), before);
});

test("updateUser guard runs in the transaction and blocks the write when it throws", async () => {
  const admin = await newUser("only-admin-guard", { role: "admin" });
  await assert.rejects(
    identity.updateUser(
      admin.id,
      { role: "user", bumpSessionEpoch: true },
      {
        guard: async (prev, tx) => {
          assert.equal(prev.role, "admin");
          const n = await identity.countActiveAdmins(tx);
          if (n >= 1) throw new Error("last admin");
        },
      },
    ),
    /last admin/,
  );
  const still = await identity.getUserById(admin.id);
  assert.equal(still?.role, "admin");
  assert.equal(still?.sessionEpoch, 1);
});

test("createUser guard can refuse (bootstrap only when no admin exists)", async () => {
  await assert.rejects(
    identity.createUser(
      { username: "second-bootstrap", displayName: "x", passwordHash: "h", role: "admin" },
      {
        guard: async (tx) => {
          if ((await identity.countActiveAdmins(tx)) > 0) throw new Error("admin exists");
        },
      },
    ),
    /admin exists/,
  );
  assert.equal(await identity.getUserByUsername("second-bootstrap"), null);
});

/* ── organisations ── */

test("organisations: create, rename, duplicates, orgUserIds", async () => {
  const org = await identity.createOrganization({ name: "  Acme   Corp ", createdByUserId: null });
  assert.equal(org.name, "Acme Corp");
  assert.equal(org.archivedAt, null);
  await assert.rejects(
    identity.createOrganization({ name: "acme corp", createdByUserId: null }),
    /already exists/,
  );
  await assert.rejects(identity.createOrganization({ name: "   ", createdByUserId: null }), /required/);

  const renamed = await identity.renameOrganization(org.id, " Acme  Two ");
  assert.equal(renamed?.name, "Acme Two");
  assert.equal((await identity.getOrganization(org.id))?.name, "Acme Two");
  assert.equal(await identity.renameOrganization("missing", "x"), null);
  await assert.rejects(identity.renameOrganization(org.id, "  "), /required/);
  assert.equal(await identity.getOrganization(null), null);
  assert.ok((await identity.listOrganizations()).some((o) => o.id === org.id));

  const u1 = await newUser("org-user-1", { orgId: org.id });
  const u2 = await newUser("org-user-2");
  await identity.updateUser(u2.id, { orgId: org.id, status: "suspended" });
  await newUser("org-user-3");
  const ids = await identity.orgUserIds(org.id);
  assert.deepEqual([...ids].sort(), [u1.id, u2.id].sort());
});

/* ── settings and alerts ── */

test("app settings: defaults, then patch round trip", async () => {
  const defaults = await settings.getAppSettings();
  assert.equal(defaults.publicSignupEnabled, false);
  const next = await settings.updateAppSettings({ publicSignupEnabled: true, maxConcurrentRunsPerUser: 7 }, "actor-1");
  assert.equal(next.publicSignupEnabled, true);
  assert.equal(next.maxConcurrentRunsPerUser, 7);
  assert.equal(next.updatedByUserId, "actor-1");
  assert.deepEqual(await settings.getAppSettings(), next);
  const again = await settings.updateAppSettings({ disabledModels: ["m1"] }, null);
  assert.equal(again.maxConcurrentRunsPerUser, 7);
  assert.deepEqual(again.disabledModels, ["m1"]);
  assert.equal(again.updatedByUserId, null);
});

test("provider credit alerts dedupe per user+provider and acknowledge once", async () => {
  const input = { userId: "u-alert", username: "u", displayName: "U", provider: "sociavault" as const, runId: "r1" };
  await settings.recordProviderCreditAlert(input);
  await settings.recordProviderCreditAlert({ ...input, runId: "r2" });
  await settings.recordProviderCreditAlert({ ...input, provider: "openai" });
  await settings.recordProviderCreditAlert({ ...input, userId: "u-other" });
  const alerts = (await settings.listAdminAlerts()).filter((a) => a.userId === "u-alert");
  assert.equal(alerts.length, 2);
  assert.ok(alerts.every((a) => a.kind === "provider_credits_exhausted"));

  const all = await settings.listAdminAlerts();
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt);

  const ids = alerts.map((a) => a.id);
  assert.equal(await settings.acknowledgeAdminAlerts([ids[0], "missing"], "admin-x"), 1);
  assert.equal(await settings.acknowledgeAdminAlerts(ids, "admin-x"), 1);
  assert.equal(await settings.acknowledgeAdminAlerts(ids, "admin-x"), 0);
  const acked = (await settings.listAdminAlerts()).filter((a) => ids.includes(a.id));
  assert.ok(acked.every((a) => a.acknowledgedAt && a.acknowledgedByUserId === "admin-x"));
});

test("an alert older than the dedupe window does not block a new one", async () => {
  const old = new Date(Date.now() - 16 * 60 * 1000).toISOString();
  await getDb().query(
    "insert into admin_alerts (id, created_at, data) values ($1, $2::timestamptz, $3::jsonb)",
    [
      "old-alert",
      old,
      JSON.stringify({
        id: "old-alert",
        kind: "provider_credits_exhausted",
        userId: "u-old",
        username: "o",
        displayName: "O",
        provider: "runway",
        runId: null,
        createdAt: old,
      }),
    ],
  );
  await settings.recordProviderCreditAlert({
    userId: "u-old",
    username: "o",
    displayName: "O",
    provider: "runway",
    runId: null,
  });
  assert.equal((await settings.listAdminAlerts()).filter((a) => a.userId === "u-old").length, 2);
});

/* ── projects and spaces ── */

test("createProjectSpace + assignRunsToSpace update run rows", async () => {
  const org = await identity.createOrganization({ name: "Space Org", createdByUserId: null });
  const owner = await newUser("space-owner", { orgId: org.id });
  const space = await spaces.createProjectSpace({ clientName: "  Client A ", ownerUserId: owner.id });
  assert.equal(space.clientName, "Client A");
  assert.equal(space.archivedAt, null);
  assert.deepEqual(await spaces.getProjectSpace(space.id), space);
  const { rows } = await getDb().query<{ org_id: string | null }>(
    "select org_id from project_spaces where id = $1",
    [space.id],
  );
  assert.equal(rows[0]?.org_id, org.id);

  const unowned = makeJob({ ownerUserId: null });
  const owned = makeJob({ ownerUserId: "someone-else" });
  const lookup = makeLookup();
  assert.equal(await runs.saveJob(unowned), true);
  assert.equal(await runs.saveJob(owned), true);
  assert.equal(await runs.saveLookupJob(lookup), true);

  const moved = await spaces.assignRunsToSpace(space.id, [
    { kind: "search", id: unowned.id },
    { kind: "search", id: owned.id },
    { kind: "lookup", id: lookup.id },
    { kind: "search", id: "missing-run" },
  ]);
  assert.equal(moved, 3);

  const a = await runs.getJob(unowned.id);
  assert.equal(a?.spaceId, space.id);
  assert.equal(a?.ownerUserId, owner.id);
  const b = await runs.getJob(owned.id);
  assert.equal(b?.spaceId, space.id);
  assert.equal(b?.ownerUserId, "someone-else");
  const l = await runs.getLookupJob(lookup.id);
  assert.equal(l?.spaceId, space.id);

  // The copied columns follow the data.
  const cols = await getDb().query<{ space_id: string; owner_user_id: string }>(
    "select space_id, owner_user_id from jobs where id = $1",
    [unowned.id],
  );
  assert.deepEqual(cols.rows[0], { space_id: space.id, owner_user_id: owner.id });

  const project = await spaces.getProject("search", unowned.id);
  assert.equal(project?.spaceId, space.id);
  assert.equal(project?.title, unowned.keyword);
  assert.equal(await spaces.getProject("lookup", "missing"), null);

  assert.ok((await spaces.listProjectSpaces({ ownerUserId: owner.id })).some((s) => s.id === space.id));
});

test("assignRunsToSpace does not resurrect a deleted run and refuses an archived space", async () => {
  const owner = await newUser("deleted-run-owner");
  const space = await spaces.createProjectSpace({ clientName: "Client Del", ownerUserId: owner.id });
  const job = makeJob({ ownerUserId: owner.id });
  await runs.saveJob(job);
  await runs.deleteHistoryRun(job.id);
  assert.equal(await spaces.assignRunsToSpace(space.id, [{ kind: "search", id: job.id }]), 0);
  assert.equal(await runs.getJob(job.id), null);

  const archived = await spaces.createProjectSpace({ clientName: "Client Arch", ownerUserId: owner.id });
  await spaces.archiveProjectSpace(archived.id);
  const job2 = makeJob({ ownerUserId: owner.id });
  await runs.saveJob(job2);
  assert.equal(await spaces.assignRunsToSpace(archived.id, [{ kind: "search", id: job2.id }]), 0);
  assert.equal(await spaces.assignRunsToSpace("missing-space", [{ kind: "search", id: job2.id }]), 0);
  assert.equal((await runs.getJob(job2.id))?.spaceId ?? null, null);
});

test("archive and restore a space with its runs", async () => {
  const owner = await newUser("archive-owner");
  const space = await spaces.createProjectSpace({ clientName: "Client Archive", ownerUserId: owner.id });
  const j1 = makeJob({ ownerUserId: owner.id });
  const j2 = makeJob({ ownerUserId: owner.id });
  const l1 = makeLookup({ ownerUserId: owner.id });
  for (const j of [j1, j2]) await runs.saveJob(j);
  await runs.saveLookupJob(l1);
  await spaces.assignRunsToSpace(space.id, [
    { kind: "search", id: j1.id },
    { kind: "search", id: j2.id },
    { kind: "lookup", id: l1.id },
  ]);
  // j2 was archived on its own before the space.
  assert.equal(await spaces.setProjectArchived("search", j2.id, true), true);
  const separateArchive = (await runs.getJob(j2.id))?.archivedAt;
  assert.ok(separateArchive);

  const archived = await spaces.archiveProjectSpace(space.id);
  assert.deepEqual(archived, { ok: true, runsArchived: 2 });
  const stored = await spaces.getProjectSpace(space.id);
  assert.ok(stored?.archivedAt);
  assert.equal((await runs.getJob(j1.id))?.archivedAt, stored.archivedAt);
  assert.equal((await runs.getLookupJob(l1.id))?.archivedAt, stored.archivedAt);
  assert.equal((await spaces.listProjectSpaces()).some((s) => s.id === space.id), false);
  assert.equal((await spaces.listProjectSpaces({ includeArchived: true })).some((s) => s.id === space.id), true);

  assert.deepEqual(await spaces.archiveProjectSpace("missing"), { ok: false, runsArchived: 0 });

  const restored = await spaces.restoreProjectSpace(space.id);
  assert.deepEqual(restored, { ok: true, runsRestored: 2 });
  assert.equal((await spaces.getProjectSpace(space.id))?.archivedAt, null);
  assert.equal((await runs.getJob(j1.id))?.archivedAt, null);
  assert.equal((await runs.getLookupJob(l1.id))?.archivedAt, null);
  assert.equal((await runs.getJob(j2.id))?.archivedAt, separateArchive);
  assert.deepEqual(await spaces.restoreProjectSpace(space.id), { ok: false, runsRestored: 0 });
});

test("space owner, rename, project owner and listProjects", async () => {
  const org = await identity.createOrganization({ name: "Owner Org", createdByUserId: null });
  const a = await newUser("proj-a");
  const b = await newUser("proj-b", { orgId: org.id });
  const space = await spaces.createProjectSpace({ clientName: "Client Own", ownerUserId: a.id });
  assert.equal(await spaces.setProjectSpaceOwner(space.id, b.id), true);
  assert.equal(await spaces.setProjectSpaceOwner("missing", b.id), false);
  assert.equal((await spaces.getProjectSpace(space.id))?.ownerUserId, b.id);
  const { rows } = await getDb().query<{ org_id: string | null; owner_user_id: string }>(
    "select org_id, owner_user_id from project_spaces where id = $1",
    [space.id],
  );
  assert.deepEqual(rows[0], { org_id: org.id, owner_user_id: b.id });

  assert.equal(await spaces.renameProjectSpace(space.id, "Renamed"), true);
  assert.equal((await spaces.getProjectSpace(space.id))?.clientName, "Renamed");
  assert.equal(await spaces.renameProjectSpace("missing", "x"), false);

  const job = makeJob({ ownerUserId: a.id });
  const internal = makeLookup({ ownerUserId: a.id, internalOnly: true } as Partial<LookupJob>);
  await runs.saveJob(job);
  await runs.saveLookupJob(internal);
  assert.equal(await spaces.setProjectOwner("search", job.id, b.id), true);
  assert.equal(await spaces.setProjectOwner("search", "missing", b.id), false);
  const mine = await spaces.listProjects({ ownerUserId: b.id });
  assert.ok(mine.some((p) => p.id === job.id && p.kind === "search"));
  const all = await spaces.listProjects();
  assert.equal(all.some((p) => p.id === internal.id), false);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].createdAt >= all[i].createdAt);
  await spaces.setProjectOwner("search", job.id, null);
  assert.ok((await spaces.listProjects({ unassignedOnly: true })).some((p) => p.id === job.id));
  assert.equal(await spaces.setProjectArchived("search", job.id, false), true);
  assert.equal((await runs.getJob(job.id))?.archivedAt, null);
});

test("space memberships: upsert, list, remove", async () => {
  const m = await spaces.upsertSpaceMembership({ spaceId: "sp-1", userId: "u-1", role: "viewer", grantedByUserId: "g-1" });
  const again = await spaces.upsertSpaceMembership({ spaceId: "sp-1", userId: "u-1", role: "editor", grantedByUserId: "g-2" });
  assert.equal(again.id, m.id);
  assert.equal(again.role, "editor");
  assert.equal(again.grantedByUserId, "g-1");
  await spaces.upsertSpaceMembership({ spaceId: "sp-2", userId: "u-1", role: "viewer", grantedByUserId: "g-1" });
  assert.equal((await spaces.listSpaceMemberships("sp-1")).length, 1);
  assert.ok((await spaces.listSpaceMemberships()).length >= 2);
  assert.equal(await spaces.removeSpaceMembership("sp-1", "u-1"), true);
  assert.equal(await spaces.removeSpaceMembership("sp-1", "u-1"), false);
  assert.equal((await spaces.listSpaceMemberships("sp-1")).length, 0);
});

/* ── audit, project memberships, conversion rules ── */

test("audit seq strictly increases and queryAudit filters newest first", async () => {
  const entries = [];
  for (let i = 0; i < 4; i++) {
    entries.push(
      await audit.recordAudit({
        actorUserId: i % 2 ? "actor-odd" : "actor-even",
        actorUsername: "a",
        action: i === 3 ? "user.login" : `admin.credits.op${i}`,
        targetUserId: i === 0 ? "target-1" : null,
        details: { i },
      }),
    );
  }
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].seq > entries[i - 1].seq);
  assert.equal(typeof entries[0].seq, "number");

  const all = await audit.queryAudit();
  assert.deepEqual(all.map((e) => e.seq), [...entries].reverse().map((e) => e.seq));
  assert.deepEqual(all[0], entries[3]);

  assert.equal((await audit.queryAudit({ actorUserId: "actor-odd" })).length, 2);
  assert.equal((await audit.queryAudit({ actionPrefix: "admin.credits" })).length, 3);
  assert.equal((await audit.queryAudit({ action: "user.login" })).length, 1);
  assert.equal((await audit.queryAudit({ excludeActions: new Set(["user.login"]) })).length, 3);
  assert.equal((await audit.queryAudit({ targetUserId: "target-1" })).length, 1);
  assert.equal((await audit.queryAudit({ limit: 2 })).length, 2);
  assert.equal((await audit.queryAudit({ userIds: new Set(["target-1"]) })).length, 1);
  assert.equal((await audit.queryAudit({ userIds: new Set() })).length, 0);
  assert.equal((await audit.queryAudit({ from: "2999-01-01T00:00:00.000Z" })).length, 0);
  assert.equal((await audit.queryAudit({ to: "2000-01-01T00:00:00.000Z" })).length, 0);
});

test("project memberships: upsert, get, list, remove", async () => {
  const m = await audit.upsertMembership({
    projectKind: "search",
    projectId: "p-1",
    userId: "u-1",
    role: "viewer",
    grantedByUserId: "g-1",
  });
  const again = await audit.upsertMembership({
    projectKind: "search",
    projectId: "p-1",
    userId: "u-1",
    role: "editor",
    grantedByUserId: "g-2",
  });
  assert.equal(again.id, m.id);
  assert.equal(again.role, "editor");
  assert.equal(again.grantedByUserId, "g-2");
  assert.deepEqual(await audit.getMembership("search", "p-1", "u-1"), again);
  assert.equal(await audit.getMembership("lookup", "p-1", "u-1"), null);
  await audit.upsertMembership({ projectKind: "lookup", projectId: "p-1", userId: "u-1", role: "viewer", grantedByUserId: "g" });
  assert.equal((await audit.listMemberships({ userId: "u-1" })).length, 2);
  assert.equal((await audit.listMemberships({ projectKind: "lookup" })).length, 1);
  assert.equal(await audit.removeMembership("search", "p-1", "u-1"), true);
  assert.equal(await audit.removeMembership("search", "p-1", "u-1"), false);
  assert.equal((await audit.listMemberships({ projectId: "p-1" })).length, 1);
});

test("conversion rule sets: seed fallback, publish makes the new version active", async () => {
  const seeded = await audit.listConversionRuleSets();
  assert.deepEqual(seeded.map((r) => r.version), [SEED_RULE_VERSION]);
  assert.equal((await audit.getActiveConversionRuleSet()).version, SEED_RULE_VERSION);

  const base = seeded[0];
  const created = await audit.publishConversionRuleSet({
    rates: base.rates,
    perCallReservationCeiling: base.perCallReservationCeiling,
    note: "v next",
    actorUserId: "admin-1",
  });
  assert.equal(created.version, SEED_RULE_VERSION + 1);
  assert.equal((await audit.getActiveConversionRuleSet()).version, created.version);
  assert.equal((await settings.getAppSettings()).activeConversionRuleVersion, created.version);
  assert.equal((await settings.getAppSettings()).updatedByUserId, "admin-1");
  assert.deepEqual(await audit.getConversionRuleSet(created.version), created);
  assert.equal((await audit.getConversionRuleSet(SEED_RULE_VERSION))?.version, SEED_RULE_VERSION);
  assert.deepEqual((await audit.listConversionRuleSets()).map((r) => r.version), [created.version, SEED_RULE_VERSION]);

  const third = await audit.publishConversionRuleSet({
    rates: base.rates,
    perCallReservationCeiling: base.perCallReservationCeiling,
    note: null,
    actorUserId: "admin-2",
  });
  assert.equal(third.version, created.version + 1);
  assert.equal((await audit.getActiveConversionRuleSet()).version, third.version);
});
