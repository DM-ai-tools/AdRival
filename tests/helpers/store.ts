import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { useTestDb } from "./testDb";

/**
 * Every test file gets its own fresh database: an in-process PGlite, migrated
 * and installed behind getDb()/withTx() (see useTestDb). Call it with top-level
 * await at the top of a test file, before app code runs any query.
 *
 * ADRIVAL_DATA_DIR still points at a throwaway directory: the only thing left
 * on disk is recreate assets (src/lib/pipeline/manus/assets.ts), and tests must
 * never write those into the repo's data/ folder.
 */
export async function useTempStore(label: string): Promise<{ cleanup(): Promise<void> }> {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET ?? "test-session-secret-do-not-use-in-production";
  const assetsDir = mkdtempSync(join(tmpdir(), `adrival-${label}-`));
  process.env.ADRIVAL_DATA_DIR = assetsDir;
  let db: { cleanup(): Promise<void> };
  try {
    db = await useTestDb(label);
  } catch (err) {
    rmSync(assetsDir, { recursive: true, force: true });
    throw err;
  }
  return {
    async cleanup() {
      try {
        await db.cleanup();
      } finally {
        rmSync(assetsDir, { recursive: true, force: true });
      }
    },
  };
}
