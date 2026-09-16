import { readDb, transaction } from "@/lib/db";
import type {
  AuditLogEntry,
  ConversionRuleSet,
  CreditLedgerEntry,
  ProjectKind,
  ProjectMembership,
} from "@/lib/types";
import { seedConversionRuleSet } from "./conversion";

/* ─────────────────────────── Conversion rule sets ───────────────────────── */

export function listConversionRuleSets(): ConversionRuleSet[] {
  const sets = readDb().conversionRuleSets ?? [];
  return [...sets].sort((a, b) => b.version - a.version);
}

export function getConversionRuleSet(version: number): ConversionRuleSet | null {
  return (
    (readDb().conversionRuleSets ?? []).find((r) => r.version === version) ??
    null
  );
}

/** The rule set new charges are converted with. */
export function getActiveConversionRuleSet(): ConversionRuleSet {
  const db = readDb();
  const wanted = db.appSettings?.activeConversionRuleVersion;
  const sets = db.conversionRuleSets ?? [];
  return (
    sets.find((r) => r.version === wanted) ??
    sets.slice().sort((a, b) => b.version - a.version)[0] ??
    seedConversionRuleSet()
  );
}

/**
 * Rules are versioned, never edited in place: publishing appends a new version
 * and activates it, so historical charges keep resolving to the rates that
 * actually produced them.
 */
export function publishConversionRuleSet(input: {
  rates: ConversionRuleSet["rates"];
  perCallReservationCeiling: ConversionRuleSet["perCallReservationCeiling"];
  note: string | null;
  actorUserId: string;
}): ConversionRuleSet {
  return transaction((db) => {
    if (!db.conversionRuleSets) db.conversionRuleSets = [];
    const nextVersion =
      db.conversionRuleSets.reduce((max, r) => Math.max(max, r.version), 0) + 1;
    const created: ConversionRuleSet = {
      version: nextVersion,
      createdAt: new Date().toISOString(),
      createdByUserId: input.actorUserId,
      note: input.note,
      rates: input.rates,
      perCallReservationCeiling: input.perCallReservationCeiling,
    };
    db.conversionRuleSets.push(created);
    if (db.appSettings) {
      db.appSettings.activeConversionRuleVersion = nextVersion;
      db.appSettings.updatedAt = created.createdAt;
      db.appSettings.updatedByUserId = input.actorUserId;
    }
    return created;
  });
}

/* ──────────────────────────── Append-only ledger ────────────────────────── */

export type LedgerDraft = Omit<
  CreditLedgerEntry,
  "id" | "seq" | "createdAt"
> & { createdAt?: string };

/**
 * Append ledger rows. Must be called inside an open `transaction` so the entry
 * commits atomically with the balance change it describes.
 */
export function appendLedgerEntries(
  db: Parameters<Parameters<typeof transaction>[0]>[0],
  drafts: LedgerDraft[],
): CreditLedgerEntry[] {
  if (!db.creditLedger) db.creditLedger = [];
  const created: CreditLedgerEntry[] = [];
  for (const draft of drafts) {
    const seq = (db.ledgerSeq ?? db.creditLedger.length) + 1;
    db.ledgerSeq = seq;
    const entry: CreditLedgerEntry = {
      ...draft,
      id: crypto.randomUUID(),
      seq,
      createdAt: draft.createdAt ?? new Date().toISOString(),
    };
    db.creditLedger.push(entry);
    created.push(entry);
  }
  return created;
}

export interface LedgerQuery {
  userId?: string;
  periodId?: string;
  types?: CreditLedgerEntry["type"][];
  from?: string;
  to?: string;
  limit?: number;
}

export function queryLedger(query: LedgerQuery = {}): CreditLedgerEntry[] {
  const rows = (readDb().creditLedger ?? []).filter((entry) => {
    if (query.userId && entry.userId !== query.userId) return false;
    if (query.periodId && entry.periodId !== query.periodId) return false;
    if (query.types && !query.types.includes(entry.type)) return false;
    if (query.from && entry.createdAt < query.from) return false;
    if (query.to && entry.createdAt > query.to) return false;
    return true;
  });
  rows.sort((a, b) => b.seq - a.seq);
  return query.limit ? rows.slice(0, query.limit) : rows;
}

/* ─────────────────────────── Project memberships ────────────────────────── */

export function listMemberships(filter?: {
  userId?: string;
  projectKind?: ProjectKind;
  projectId?: string;
}): ProjectMembership[] {
  return (readDb().projectMemberships ?? []).filter((m) => {
    if (filter?.userId && m.userId !== filter.userId) return false;
    if (filter?.projectKind && m.projectKind !== filter.projectKind) return false;
    if (filter?.projectId && m.projectId !== filter.projectId) return false;
    return true;
  });
}

export function getMembership(
  projectKind: ProjectKind,
  projectId: string,
  userId: string,
): ProjectMembership | null {
  return (
    (readDb().projectMemberships ?? []).find(
      (m) =>
        m.projectKind === projectKind &&
        m.projectId === projectId &&
        m.userId === userId,
    ) ?? null
  );
}

export function upsertMembership(input: {
  projectKind: ProjectKind;
  projectId: string;
  userId: string;
  role: ProjectMembership["role"];
  grantedByUserId: string;
}): ProjectMembership {
  return transaction((db) => {
    if (!db.projectMemberships) db.projectMemberships = [];
    const now = new Date().toISOString();
    const existing = db.projectMemberships.find(
      (m) =>
        m.projectKind === input.projectKind &&
        m.projectId === input.projectId &&
        m.userId === input.userId,
    );
    if (existing) {
      existing.role = input.role;
      existing.grantedByUserId = input.grantedByUserId;
      existing.updatedAt = now;
      return existing;
    }
    const created: ProjectMembership = {
      id: crypto.randomUUID(),
      projectKind: input.projectKind,
      projectId: input.projectId,
      userId: input.userId,
      role: input.role,
      grantedByUserId: input.grantedByUserId,
      createdAt: now,
      updatedAt: now,
    };
    db.projectMemberships.push(created);
    return created;
  });
}

export function removeMembership(
  projectKind: ProjectKind,
  projectId: string,
  userId: string,
): boolean {
  return transaction((db) => {
    if (!db.projectMemberships) return false;
    const before = db.projectMemberships.length;
    db.projectMemberships = db.projectMemberships.filter(
      (m) =>
        !(
          m.projectKind === projectKind &&
          m.projectId === projectId &&
          m.userId === userId
        ),
    );
    return db.projectMemberships.length < before;
  });
}

/* ──────────────────────────────── Audit log ─────────────────────────────── */

export interface AuditDraft {
  actorUserId: string | null;
  actorUsername: string | null;
  action: string;
  targetUserId?: string | null;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  details?: Record<string, string | number | boolean | null> | null;
}

/** Never pass credentials, API keys or prompt content in `details`. */
export function recordAudit(draft: AuditDraft): AuditLogEntry {
  return transaction((db) => {
    if (!db.auditLogs) db.auditLogs = [];
    const seq = (db.auditSeq ?? db.auditLogs.length) + 1;
    db.auditSeq = seq;
    const entry: AuditLogEntry = {
      id: crypto.randomUUID(),
      seq,
      actorUserId: draft.actorUserId,
      actorUsername: draft.actorUsername,
      action: draft.action,
      targetUserId: draft.targetUserId ?? null,
      projectKind: draft.projectKind ?? null,
      projectId: draft.projectId ?? null,
      details: draft.details ?? null,
      createdAt: new Date().toISOString(),
    };
    db.auditLogs.push(entry);
    // Cap growth of the audit tail in the JSON store.
    if (db.auditLogs.length > 20_000) {
      db.auditLogs = db.auditLogs.slice(-20_000);
    }
    return entry;
  });
}

export function queryAudit(filter?: {
  actorUserId?: string;
  targetUserId?: string;
  action?: string;
  limit?: number;
}): AuditLogEntry[] {
  const rows = (readDb().auditLogs ?? []).filter((e) => {
    if (filter?.actorUserId && e.actorUserId !== filter.actorUserId) return false;
    if (filter?.targetUserId && e.targetUserId !== filter.targetUserId) {
      return false;
    }
    if (filter?.action && e.action !== filter.action) return false;
    return true;
  });
  rows.sort((a, b) => b.seq - a.seq);
  return rows.slice(0, filter?.limit ?? 200);
}
