import type { AppSettings, AppUser, DatabaseShape } from "../types";
import { GPT_IMAGE_RATE, GPT_IMAGE_RATE_KEY, seedConversionRuleSet, conversionRulesNeedSoftening } from "../accounting/conversion";
import { creditsToSubunits } from "../accounting/units";

/*
 * Pure helpers for the legacy store.json shape (DatabaseShape): building an
 * empty store, forward migrations and owner remapping for imports. No file or
 * database access here; the history import (importHistory.ts) uses them.
 */

/** Current store shape. Bump whenever migrateDb() gains a step. */
export const SCHEMA_VERSION = 4;

/** How many deleted run ids the store remembers (oldest are dropped first). */
export const MAX_DELETED_RUN_IDS = 500;

export function defaultAppSettings(): AppSettings {
  return {
    // Closed by default: a fresh deployment should not accept signups before
    // the operator has bootstrapped the first admin.
    publicSignupEnabled: false,
    // Zero credits for new users unless an admin raises this.
    defaultAllowanceSubunits: 0,
    defaultResetCadence: "none",
    lowCreditWarningSubunits: creditsToSubunits(25),
    maxConcurrentRunsPerUser: 3,
    maxConcurrentRecreationsPerUser: 3,
    maxRunReservationSubunits: creditsToSubunits(500),
    disabledProviders: [],
    disabledModels: [],
    activeConversionRuleVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedByUserId: null,
  };
}

export function emptyDb(): DatabaseShape {
  return migrateDb({
    schemaVersion: 0,
    jobs: [],
    competitors: [],
    seenPageIds: [],
    lookupJobs: [],
    lookupAds: [],
    searchCompetitorAds: [],
    users: [],
  });
}

/**
 * Forward-only store migrations.
 *
 * v1 → v2 (multi-user workspaces, credits, admin):
 *   - adds the accounting/authorization collections
 *   - seeds settings and conversion rule set v1
 *   - backfills role/status/sessionEpoch on pre-existing users
 *   - deliberately does NOT infer ownership for pre-existing jobs. Rows keep
 *     `ownerUserId === undefined` and are only reachable from the admin
 *     "Unassigned projects" screen until an admin assigns an owner.
 */
export function migrateDb(parsed: DatabaseShape): DatabaseShape {
  if (!parsed.jobs) parsed.jobs = [];
  if (!parsed.competitors) parsed.competitors = [];
  if (!parsed.seenPageIds) parsed.seenPageIds = [];
  if (!parsed.lookupJobs) parsed.lookupJobs = [];
  if (!parsed.lookupAds) parsed.lookupAds = [];
  if (!parsed.icps) parsed.icps = [];
  if (!parsed.searchCompetitorAds) parsed.searchCompetitorAds = [];
  if (!parsed.deletedRunIds) parsed.deletedRunIds = [];
  if (!parsed.users) parsed.users = [];

  const from = parsed.schemaVersion ?? 1;

  if (from < 2) {
    if (!parsed.appSettings) parsed.appSettings = defaultAppSettings();
    if (!parsed.conversionRuleSets?.length) {
      parsed.conversionRuleSets = [seedConversionRuleSet()];
    }
    for (const user of parsed.users) {
      // Existing accounts predate roles. They become regular users; the first
      // admin must be created through the documented bootstrap.
      if (!user.role) user.role = "user";
      if (!user.status) user.status = "active";
      if (typeof user.sessionEpoch !== "number") user.sessionEpoch = 1;
      if (typeof user.mustChangePassword !== "boolean") {
        user.mustChangePassword = false;
      }
    }
  }

  if (!parsed.appSettings) parsed.appSettings = defaultAppSettings();
  if (!parsed.conversionRuleSets?.length) {
    parsed.conversionRuleSets = [seedConversionRuleSet()];
  }

  // Soften redesign pricing / reservation ceilings for lean Claude usage.
  if (from < 4) {
    const activeVersion = parsed.appSettings.activeConversionRuleVersion ?? 1;
    const active =
      parsed.conversionRuleSets.find((rule) => rule.version === activeVersion) ||
      parsed.conversionRuleSets[0];
    if (active && conversionRulesNeedSoftening(active)) {
      const soft = seedConversionRuleSet();
      const nextVersion =
        Math.max(0, ...parsed.conversionRuleSets.map((rule) => rule.version)) + 1;
      soft.version = nextVersion;
      soft.note =
        `Auto-migrated lean redesign rates (schema v4). Previous active rule was v${active.version}.`;
      parsed.conversionRuleSets.push(soft);
      parsed.appSettings.activeConversionRuleVersion = nextVersion;
      parsed.appSettings.updatedAt = new Date().toISOString();
    }
  }
  // Images moved from Runway to OpenAI GPT Image: give the active rules a
  // per-image rate so an image is not billed like a short chat call.
  {
    const activeVersion = parsed.appSettings.activeConversionRuleVersion ?? 1;
    const active =
      parsed.conversionRuleSets.find((rule) => rule.version === activeVersion) ||
      parsed.conversionRuleSets[0];
    if (active?.rates.openai && !active.rates.openai[GPT_IMAGE_RATE_KEY]) {
      active.rates.openai[GPT_IMAGE_RATE_KEY] = { ...GPT_IMAGE_RATE };
    }
  }
  if (!parsed.creditPeriods) parsed.creditPeriods = [];
  if (!parsed.creditLedger) parsed.creditLedger = [];
  if (!parsed.creditReservations) parsed.creditReservations = [];
  if (!parsed.providerCalls) parsed.providerCalls = [];
  if (!parsed.projectMemberships) parsed.projectMemberships = [];
  if (!parsed.projectSpaces) parsed.projectSpaces = [];
  if (!parsed.spaceMemberships) parsed.spaceMemberships = [];
  if (!parsed.auditLogs) parsed.auditLogs = [];
  if (!parsed.adminAlerts) parsed.adminAlerts = [];
  if (!parsed.loginAttempts) parsed.loginAttempts = [];
  if (typeof parsed.ledgerSeq !== "number") {
    parsed.ledgerSeq = parsed.creditLedger.length;
  }
  if (typeof parsed.auditSeq !== "number") {
    parsed.auditSeq = parsed.auditLogs.length;
  }

  parsed.schemaVersion = SCHEMA_VERSION;
  return parsed;
}

/**
 * Shape an imported payload into a store. Only run/history collections are
 * taken from the import — accounts, credits, ledger, audit and settings are
 * always preserved from the live store so a history import can never clobber
 * billing or authorization data.
 */
export type ImportOwnerOptions = {
  /** Server account that receives imported runs whose owner is unknown here (or unowned). */
  fallbackOwnerUserId?: string | null;
};

export type ImportOwnerSummary = {
  kept: number;
  matchedByUsername: number;
  assignedToFallback: number;
  unresolved: number;
};

/**
 * Imported runs carry the owner ids of the machine they came from. Keep an
 * owner that exists on this server, otherwise match the account by username
 * (the import file carries its own users), otherwise use the fallback owner.
 */
export function remapImportedOwners(
  db: DatabaseShape,
  incomingUsers: AppUser[] | undefined,
  options: ImportOwnerOptions,
): ImportOwnerSummary {
  const serverIds = new Set((db.users ?? []).map((u) => u.id));
  const serverByUsername = new Map((db.users ?? []).map((u) => [u.username.toLowerCase(), u.id]));
  const idMap = new Map<string, string>();
  for (const user of incomingUsers ?? []) {
    const match = serverByUsername.get(String(user.username || "").toLowerCase());
    if (match) idMap.set(user.id, match);
  }
  const summary: ImportOwnerSummary = { kept: 0, matchedByUsername: 0, assignedToFallback: 0, unresolved: 0 };
  const fallback = options.fallbackOwnerUserId && serverIds.has(options.fallbackOwnerUserId)
    ? options.fallbackOwnerUserId
    : null;
  const fix = (row: { ownerUserId?: string | null }) => {
    if (row.ownerUserId && serverIds.has(row.ownerUserId)) {
      summary.kept += 1;
      return;
    }
    const mapped = row.ownerUserId ? idMap.get(row.ownerUserId) : undefined;
    if (mapped) {
      row.ownerUserId = mapped;
      summary.matchedByUsername += 1;
    } else if (fallback) {
      row.ownerUserId = fallback;
      summary.assignedToFallback += 1;
    } else {
      summary.unresolved += 1;
    }
  };
  for (const job of db.jobs) fix(job);
  for (const job of db.lookupJobs ?? []) fix(job);
  return summary;
}
