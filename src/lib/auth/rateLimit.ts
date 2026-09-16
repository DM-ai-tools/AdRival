import { readDb, transaction } from "@/lib/db";

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Login throttling, keyed by username and persisted in the store so the limit
 * survives a restart and applies across processes.
 */
export function isLoginLocked(username: string): { locked: boolean; retryAfterSec: number } {
  const key = username.trim().toLowerCase();
  const record = (readDb().loginAttempts ?? []).find((r) => r.key === key);
  if (!record?.lockedUntil) return { locked: false, retryAfterSec: 0 };
  const remaining = new Date(record.lockedUntil).getTime() - Date.now();
  if (remaining <= 0) return { locked: false, retryAfterSec: 0 };
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

export function recordFailedLogin(username: string): { locked: boolean } {
  const key = username.trim().toLowerCase();
  return transaction((db) => {
    if (!db.loginAttempts) db.loginAttempts = [];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let record = db.loginAttempts.find((r) => r.key === key);
    if (!record) {
      record = { key, attempts: 0, firstAttemptAt: nowIso, lockedUntil: null };
      db.loginAttempts.push(record);
    }
    // Start a fresh window once the old one has elapsed.
    if (nowMs - new Date(record.firstAttemptAt).getTime() > WINDOW_MS) {
      record.attempts = 0;
      record.firstAttemptAt = nowIso;
      record.lockedUntil = null;
    }
    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.lockedUntil = new Date(nowMs + LOCKOUT_MS).toISOString();
    }
    return { locked: Boolean(record.lockedUntil) };
  });
}

export function clearLoginAttempts(username: string): void {
  const key = username.trim().toLowerCase();
  transaction((db) => {
    if (!db.loginAttempts) return;
    db.loginAttempts = db.loginAttempts.filter((r) => r.key !== key);
  });
}
