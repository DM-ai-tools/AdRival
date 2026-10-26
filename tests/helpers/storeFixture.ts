import { seedConversionRuleSet } from "../../src/lib/accounting/conversion";
import { SCHEMA_VERSION, defaultAppSettings } from "../../src/lib/data/legacyStore";
import type { DatabaseShape } from "../../src/lib/types";

/*
 * A store.json-shaped fixture with every collection filled (shared by
 * importStore.test.ts and backup.test.ts).
 */

export const T0 = "2026-01-10T00:00:00.000Z";
export const T1 = "2026-01-11T00:00:00.000Z";
export const T2 = "2026-01-12T00:00:00.000Z";

/** ~3 MB of page content that does not compress to nothing. */
export function bigHtml(bytes: number): string {
  const parts: string[] = ["<!doctype html><html><body>"];
  let size = parts[0].length;
  let i = 0;
  while (size < bytes) {
    const chunk = `<p data-i="${i}">Section ${i} ${(i * 2654435761) % 1000003} lorem ipsum</p>`;
    parts.push(chunk);
    size += chunk.length;
    i += 1;
  }
  parts.push("</body></html>");
  return parts.join("");
}

export const HTML = bigHtml(2_200_000);
export const SOURCE_HTML = bigHtml(900_000);

export function ledger(seq: number | undefined, id: string, userId: string, delta: number, type = "adjustment") {
  const row: Record<string, unknown> = {
    id,
    userId,
    periodId: userId === "u-alice" ? "p-alice" : "p-admin",
    type,
    deltaSubunits: delta,
    balanceAfterSubunits: null,
    reason: "fixture",
    actorUserId: null,
    providerCallId: null,
    reservationId: null,
    projectKind: null,
    projectId: null,
    runId: null,
    provider: null,
    conversionRuleVersion: null,
    idempotencyKey: null,
    createdAt: T1,
  };
  if (seq !== undefined) row.seq = seq;
  return row;
}

export function providerCall(id: string, key: string, userId = "u-alice") {
  return {
    id,
    idempotencyKey: key,
    initiatedByUserId: userId,
    chargedUserId: userId,
    projectKind: "search",
    projectId: "job-1",
    runId: "job-1",
    provider: "openai",
    model: "gpt",
    endpoint: null,
    operation: "chat",
    providerRequestId: null,
    usage: {},
    usageConfidence: "reported",
    creditsCharged: 10,
    estimatedCostUsdMicros: null,
    conversionRuleVersion: 1,
    status: "succeeded",
    errorMessage: null,
    reservationId: null,
    startedAt: T1,
    completedAt: T1,
    durationMs: 5,
    settledAt: T1,
  };
}

export function user(id: string, username: string, role: "admin" | "user", orgId: string | null) {
  return {
    id,
    username,
    displayName: username,
    passwordHash: `scrypt$1$${id}$hash`,
    role,
    status: "active",
    sessionEpoch: 3,
    mustChangePassword: false,
    orgId,
    createdAt: T0,
    updatedAt: T0,
  };
}

export function period(id: string, userId: string, status: "current" | "closed", allowance: number, consumed: number, reserved: number) {
  return {
    id,
    userId,
    startsAt: T0,
    endsAt: status === "closed" ? T1 : null,
    nextResetAt: null,
    resetCadence: "none",
    allowanceSubunits: allowance,
    consumedSubunits: consumed,
    reservedSubunits: reserved,
    status,
    createdAt: T0,
    updatedAt: T1,
  };
}

/** A store with every collection filled, including one ~3 MB recreated page. */
export function fixtureStore(): DatabaseShape {
  const store = {
    schemaVersion: SCHEMA_VERSION,
    organizations: [{ id: "org-1", name: "Acme", createdAt: T0, updatedAt: T0, createdByUserId: null, archivedAt: null }],
    users: [user("u-admin", "boss", "admin", null), user("u-alice", "alice", "user", "org-1")],
    appSettings: { ...defaultAppSettings(), maxConcurrentRunsPerUser: 5, updatedAt: T0 },
    conversionRuleSets: [{ ...seedConversionRuleSet(), createdAt: T0 }],
    creditPeriods: [
      period("p-alice-old", "u-alice", "closed", 500, 500, 0),
      period("p-alice", "u-alice", "current", 10_000, 1_500, 200),
      period("p-admin", "u-admin", "current", 0, 0, 0),
    ],
    creditLedger: [
      ledger(1, "l-1", "u-alice", 10_000, "allowance_set"),
      ledger(2, "l-2", "u-alice", -1_000, "charge"),
      ledger(3, "l-3", "u-admin", 0, "period_open"),
      ledger(4, "l-4", "u-alice", -500, "charge"),
      ledger(5, "l-5", "u-alice", -200, "reservation_hold"),
    ],
    ledgerSeq: 7,
    creditReservations: [
      {
        id: "r-1",
        userId: "u-alice",
        periodId: "p-alice",
        projectKind: "search",
        projectId: "job-1",
        runId: "job-1",
        operation: "search",
        amountSubunits: 200,
        settledSubunits: 0,
        status: "open",
        expiresAt: T2,
        createdAt: T1,
        updatedAt: T1,
        closedAt: null,
        note: null,
      },
    ],
    providerCalls: [providerCall("pc-1", "key-1"), providerCall("pc-2", "key-2")],
    projectMemberships: [
      {
        id: "m-1",
        projectKind: "search",
        projectId: "job-1",
        userId: "u-admin",
        role: "viewer",
        grantedByUserId: "u-alice",
        createdAt: T1,
        updatedAt: T1,
      },
    ],
    projectSpaces: [{ id: "s-1", clientName: "Client", ownerUserId: "u-alice", createdAt: T0, updatedAt: T0, archivedAt: null }],
    spaceMemberships: [
      { id: "sm-1", spaceId: "s-1", userId: "u-admin", role: "editor", grantedByUserId: "u-alice", createdAt: T1, updatedAt: T1 },
    ],
    auditLogs: [
      { id: "a-1", seq: 1, actorUserId: "u-admin", actorUsername: "boss", action: "user.create", createdAt: T0 },
      { id: "a-2", seq: 2, actorUserId: "u-admin", actorUsername: "boss", action: "credits.add", createdAt: T1 },
    ],
    auditSeq: 2,
    adminAlerts: [
      {
        id: "al-1",
        kind: "provider_credits_exhausted",
        userId: "u-alice",
        username: "alice",
        displayName: "alice",
        provider: "openai",
        runId: "job-1",
        createdAt: T1,
      },
    ],
    loginAttempts: [{ key: "mallory", attempts: 3, firstAttemptAt: T1, lockedUntil: T2 }],
    jobs: [
      {
        id: "job-1",
        keyword: "plumber",
        keywords: ["plumber"],
        status: "completed",
        progress: { stage: "done", message: "Done" },
        competitorIds: ["c-1", "c-2"],
        ownerUserId: "u-alice",
        spaceId: "s-1",
        createdAt: T0,
        updatedAt: T1,
      },
      {
        id: "job-running",
        keyword: "electrician",
        keywords: ["electrician"],
        status: "running",
        progress: { stage: "scanning", message: "Scanning ads" },
        competitorIds: [],
        ownerUserId: "u-alice",
        createdAt: T1,
        updatedAt: T1,
      },
    ],
    lookupJobs: [
      {
        id: "lk-1",
        queryName: "Brand",
        platform: "facebook",
        status: "completed",
        progress: { stage: "done", message: "Done" },
        candidates: [],
        adIds: ["la-1"],
        ownerUserId: "u-alice",
        createdAt: T0,
        updatedAt: T1,
      },
      {
        id: "lk-running",
        queryName: "Other",
        platform: "facebook",
        status: "running",
        progress: { stage: "analyzing_offers", message: "Offers" },
        candidates: [],
        adIds: [],
        ownerUserId: "u-alice",
        createdAt: T1,
        updatedAt: T1,
      },
    ],
    competitors: [
      {
        id: "c-1",
        runId: "job-1",
        pageId: "111",
        pageName: "Big Page Co",
        activeAdsCount: 3,
        createdAt: T0,
        recreatedPage: {
          status: "completed",
          createdAt: T0,
          updatedAt: T1,
          businessUrl: "https://example.invalid",
          keyword: "plumber",
          sourceCompetitorName: "Big Page Co",
          sourceAnalyzedUrl: "https://big.invalid",
          brandColors: {},
          html: HTML,
          sourceArchive: { html: SOURCE_HTML, url: "https://big.invalid" },
          generatedImages: [{ id: "img-1", url: "https://img.invalid/1.png" }],
          previousHtml: "<html>older</html>",
          canUndo: true,
        },
      },
      { id: "c-2", runId: "job-1", pageId: "222", pageName: "No Page Co", activeAdsCount: 1, createdAt: T0 },
      {
        id: "c-3",
        runId: "job-1",
        pageId: "333",
        pageName: "Pending Page Co",
        activeAdsCount: 1,
        createdAt: T0,
        recreateOnly: { at: T1 },
        recreatedPage: {
          status: "failed",
          createdAt: T0,
          updatedAt: T1,
          businessUrl: "https://example.invalid",
          keyword: "plumber",
          sourceCompetitorName: "Pending Page Co",
          sourceAnalyzedUrl: "https://pending.invalid",
          brandColors: {},
          html: null,
          error: "boom",
        },
      },
    ],
    lookupAds: [{ id: "la-1", lookupId: "lk-1", pageId: "444", pageName: "Brand", platform: "facebook", createdAt: T0 }],
    searchCompetitorAds: [{ id: "sca-1", runId: "job-1", competitorId: "c-1", pageId: "111", createdAt: T0 }],
    seenPageIds: ["111", "222", "999"],
    deletedRunIds: ["gone-run-1"],
    icps: [
      { id: "icp-1", source: { kind: "search", id: "job-1" }, stage: "problem_aware", createdAt: T0, summary: "one" },
    ],
  };
  return store as unknown as DatabaseShape;
}
