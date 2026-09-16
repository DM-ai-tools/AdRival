import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

/**
 * Writes a v1-shaped store.json — the schema as it existed before workspaces,
 * credits and roles — then loads the app's db module against it and asserts the
 * migration is non-destructive.
 */
const dir = mkdtempSync(join(tmpdir(), "adrival-migration-"));
process.env.ADRIVAL_DATA_DIR = dir;
process.env.SESSION_SECRET = "test-session-secret-do-not-use-in-production";
after(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_STORE = {
  // No schemaVersion: that is exactly what a pre-migration store looks like.
  jobs: [
    {
      id: "legacy-search-1",
      keyword: "plumber melbourne",
      keywords: ["plumber melbourne"],
      platform: "facebook",
      geo: "AU",
      countries: ["AU"],
      status: "completed",
      progress: {
        stage: "done",
        scannedAds: 120,
        scannedPages: 8,
        accepted: 5,
        target: 5,
        rejected: 3,
        message: "Done",
      },
      competitorIds: ["legacy-competitor-1"],
      createdAt: "2025-01-05T00:00:00.000Z",
      updatedAt: "2025-01-05T01:00:00.000Z",
    },
  ],
  competitors: [
    {
      id: "legacy-competitor-1",
      runId: "legacy-search-1",
      pageId: "111",
      pageName: "Legacy Plumbing Co",
      country: "AU",
      platform: "facebook",
      activeAdsCount: 42,
      services: [],
      sampleAd: {
        adArchiveId: "900",
        title: "Blocked drain?",
        body: "24/7 emergency plumbing",
        daysRunning: 31,
        adLibraryUrl: "https://example.invalid/ad/900",
      },
      brand: { website: "https://legacyplumbing.invalid" },
      createdAt: "2025-01-05T00:30:00.000Z",
    },
  ],
  seenPageIds: ["111", "222"],
  lookupJobs: [
    {
      id: "legacy-lookup-1",
      queryName: "Legacy Brand",
      platform: "facebook",
      status: "completed",
      progress: { stage: "done", message: "Done" },
      candidates: [],
      adIds: ["legacy-ad-1"],
      createdAt: "2025-01-06T00:00:00.000Z",
      updatedAt: "2025-01-06T00:10:00.000Z",
    },
  ],
  lookupAds: [
    {
      id: "legacy-ad-1",
      lookupId: "legacy-lookup-1",
      pageId: "333",
      pageName: "Legacy Brand",
      platform: "facebook",
      createdAt: "2025-01-06T00:05:00.000Z",
      updatedAt: "2025-01-06T00:05:00.000Z",
    },
  ],
  searchCompetitorAds: [],
  // An account from before roles existed.
  users: [
    {
      id: "legacy-user-1",
      username: "earlyadopter",
      displayName: "Early Adopter",
      passwordHash: "scrypt$1$abc$def",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    },
  ],
};

writeFileSync(
  join(dir, "store.json"),
  JSON.stringify(LEGACY_STORE, null, 2),
  "utf8",
);

const db = await import("@/lib/db");
const { listVisibleProjects, resolveProjectAccess, HttpError } = await import(
  "@/lib/authz"
);

describe("v1 → v2 store migration", () => {
  test("existing jobs, competitors and history survive untouched", () => {
    const job = db.getJob("legacy-search-1");
    assert.ok(job, "the legacy search run is still present");
    assert.equal(job?.keyword, "plumber melbourne");
    assert.equal(job?.progress.accepted, 5);
    assert.equal(job?.createdAt, "2025-01-05T00:00:00.000Z");

    const competitors = db.getCompetitorsByRun("legacy-search-1");
    assert.equal(competitors.length, 1);
    assert.equal(competitors[0].pageName, "Legacy Plumbing Co");
    assert.equal(competitors[0].activeAdsCount, 42);
    assert.equal(competitors[0].sampleAd.adArchiveId, "900");

    const lookup = db.getLookupJob("legacy-lookup-1");
    assert.equal(lookup?.queryName, "Legacy Brand");
    assert.equal(db.getLookupAds("legacy-lookup-1").length, 1);

    assert.ok(db.getSeenPageIds().has("111"));
    assert.ok(db.getSeenPageIds().has("222"));
  });

  test("the schema version is stamped and persisted to disk", () => {
    assert.equal(db.readDb().schemaVersion, db.SCHEMA_VERSION);
    const onDisk = JSON.parse(
      readFileSync(join(dir, "store.json"), "utf8"),
    ) as { schemaVersion?: number };
    assert.equal(
      onDisk.schemaVersion,
      db.SCHEMA_VERSION,
      "the migration was written back, not just held in memory",
    );
  });

  test("the accounting collections are seeded", () => {
    const store = db.readDb();
    assert.ok(Array.isArray(store.creditPeriods));
    assert.ok(Array.isArray(store.creditLedger));
    assert.ok(Array.isArray(store.creditReservations));
    assert.ok(Array.isArray(store.providerCalls));
    assert.ok(Array.isArray(store.projectMemberships));
    assert.ok(Array.isArray(store.auditLogs));

    // Conversion rules start at version 1 so every historical charge can name
    // the ruleset it was priced with.
    assert.equal(store.conversionRuleSets?.length, 1);
    assert.equal(store.conversionRuleSets?.[0].version, 1);

    const settings = db.getAppSettings();
    assert.equal(
      settings.publicSignupEnabled,
      false,
      "signup is closed until an admin opens it",
    );
    assert.equal(
      settings.defaultAllowanceSubunits,
      0,
      "new users start with zero credits by default",
    );
  });

  test("a pre-roles account becomes a regular active user, never an admin", () => {
    const user = db.getUserById("legacy-user-1");
    assert.ok(user);
    assert.equal(user?.role, "user");
    assert.equal(user?.status, "active");
    assert.equal(user?.mustChangePassword, false);
    assert.equal(typeof user?.sessionEpoch, "number");
    assert.equal(
      user?.passwordHash,
      "scrypt$1$abc$def",
      "the existing password hash is preserved so the user can still log in",
    );
    assert.equal(
      db.countActiveAdmins(),
      0,
      "migration never invents an admin — bootstrap must create the first one",
    );
  });

  test("legacy projects have no owner and stay restricted", () => {
    const job = db.getJob("legacy-search-1")!;
    assert.ok(
      job.ownerUserId === undefined || job.ownerUserId === null,
      "ownership was not guessed",
    );

    const legacyUser = db.getUserById("legacy-user-1")!;
    assert.deepEqual(
      listVisibleProjects(legacyUser),
      [],
      "the only existing account sees nothing until an admin assigns it",
    );
    assert.throws(
      () => resolveProjectAccess("search", "legacy-search-1", legacyUser, "view"),
      (err: unknown) => err instanceof HttpError && err.status === 404,
    );

    // They surface in the admin-only unassigned list.
    const unassigned = db.listProjects({ unassignedOnly: true });
    assert.equal(unassigned.length, 2, "both legacy projects await assignment");
    assert.deepEqual(
      unassigned.map((p) => p.id).sort(),
      ["legacy-lookup-1", "legacy-search-1"],
    );
  });

  test("assignment makes a legacy project visible to exactly one owner", () => {
    const legacyUser = db.getUserById("legacy-user-1")!;
    assert.equal(db.setProjectOwner("search", "legacy-search-1", "legacy-user-1"), true);

    const visible = listVisibleProjects(legacyUser);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, "legacy-search-1");
    assert.equal(visible[0].accessRole, "owner");
    assert.equal(
      resolveProjectAccess("search", "legacy-search-1", legacyUser, "run").role,
      "owner",
    );

    // The lookup project is still unassigned, so it remains hidden.
    assert.deepEqual(
      db.listProjects({ unassignedOnly: true }).map((p) => p.id),
      ["legacy-lookup-1"],
    );
  });

  test("a second load of the migrated store is a no-op", () => {
    const before = readFileSync(join(dir, "store.json"), "utf8");
    const parsed = JSON.parse(before) as { schemaVersion: number };
    assert.equal(parsed.schemaVersion, db.SCHEMA_VERSION);

    // Re-reading must not re-run migrations or drop the collections again.
    const store = db.readDb();
    assert.equal(store.jobs.length, 1);
    assert.equal(store.users?.length, 1);
    assert.equal(store.conversionRuleSets?.length, 1);
  });
});
