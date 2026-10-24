import { changeLoginAttempt, deleteLoginAttempt, getLoginAttempt } from "@/lib/data/loginAttempts";
import type { LoginAttemptRecord } from "@/lib/types";

const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

function keyOf(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Login throttling, keyed by username and persisted in the database so the
 * limit survives a restart and applies across processes.
 */
export async function isLoginLocked(username: string): Promise<{ locked: boolean; retryAfterSec: number }> {
  const record = await getLoginAttempt(keyOf(username));
  if (!record?.lockedUntil) return { locked: false, retryAfterSec: 0 };
  const remaining = new Date(record.lockedUntil).getTime() - Date.now();
  if (remaining <= 0) return { locked: false, retryAfterSec: 0 };
  return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

export async function recordFailedLogin(username: string): Promise<{ locked: boolean }> {
  const key = keyOf(username);
  const record = await changeLoginAttempt(key, (current) => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const next: LoginAttemptRecord = current ? { ...current } : { key, attempts: 0, firstAttemptAt: nowIso, lockedUntil: null };
    // Start a fresh window once the old one has elapsed.
    if (nowMs - new Date(next.firstAttemptAt).getTime() > WINDOW_MS) {
      next.attempts = 0;
      next.firstAttemptAt = nowIso;
      next.lockedUntil = null;
    }
    next.attempts += 1;
    if (next.attempts >= MAX_ATTEMPTS) {
      next.lockedUntil = new Date(nowMs + LOCKOUT_MS).toISOString();
    }
    return next;
  });
  return { locked: Boolean(record.lockedUntil) };
}

export async function clearLoginAttempts(username: string): Promise<void> {
  await deleteLoginAttempt(keyOf(username));
}
