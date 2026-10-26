import { Pool, type PoolConfig } from "pg";

import { getDb, poolConfigFor, poolTestClient } from "./client";
import { migrate } from "./migrate";
import { markInterruptedJobs } from "./runs";
import { sweepAbandonedReservations } from "./accountingService";
import { startArchiveScheduler } from "./archive";
import { startBackupScheduler, startKeepAlive } from "./backup";

export interface StartupResult {
  migrated: string[];
  interrupted: number;
  swept: number;
}

/** A migration may run longer than an app query: 10 minutes, one connection. */
export const MIGRATION_QUERY_TIMEOUT_MS = 10 * 60_000;

export function migrationPoolConfig(url: string): PoolConfig {
  return { ...poolConfigFor(url), max: 1, query_timeout: MIGRATION_QUERY_TIMEOUT_MS };
}

/**
 * Runs the migrations on a direct (session) connection when DATABASE_DIRECT_URL
 * is set: DDL and the advisory lock must not go through the transaction
 * pooler, which hands each statement to a different backend. The short-lived
 * pool is closed afterwards. Without it, the runtime client is used.
 */
async function migrateOnce(dir: string | undefined): Promise<string[]> {
  const direct = process.env.DATABASE_DIRECT_URL;
  if (!direct) return migrate(getDb(), dir);
  const pool = new Pool(migrationPoolConfig(direct));
  pool.on("error", (err) => console.error("[startup] migration connection error:", err.message));
  try {
    return await migrate(poolTestClient(pool), dir);
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Server start work. A failed migration rejects (the caller exits so the
 * platform restarts the container); the recovery steps log and carry on.
 */
export async function runStartup(opts: { migrationsDir?: string } = {}): Promise<StartupResult> {
  const migrated = await migrateOnce(opts.migrationsDir);
  if (migrated.length > 0) console.log(`[startup] applied migrations: ${migrated.join(", ")}`);

  let interrupted = 0;
  try {
    interrupted = await markInterruptedJobs();
    if (interrupted > 0) console.log(`[startup] marked ${interrupted} interrupted job(s) failed`);
  } catch (err) {
    console.error("[startup] markInterruptedJobs failed:", err instanceof Error ? err.message : err);
  }

  let swept = 0;
  try {
    swept = await sweepAbandonedReservations();
    if (swept > 0) console.log(`[startup] released ${swept} abandoned reservation(s)`);
  } catch (err) {
    console.error("[startup] sweepAbandonedReservations failed:", err instanceof Error ? err.message : err);
  }

  return { migrated, interrupted, swept };
}

/**
 * Starts the background jobs of this process (after runStartup succeeded).
 * Each scheduler decides on its own whether it can run and logs when it is off.
 * Returns which ones started.
 */
export function startSchedulers(): { archive: boolean; backup: boolean; keepAlive: boolean } {
  const start = (name: string, fn: () => boolean): boolean => {
    try {
      return fn();
    } catch (err) {
      console.error(`[startup] ${name} failed to start:`, err instanceof Error ? err.message : err);
      return false;
    }
  };
  return {
    archive: start("archive scheduler", startArchiveScheduler),
    backup: start("backup scheduler", startBackupScheduler),
    keepAlive: start("keep-alive", startKeepAlive),
  };
}
