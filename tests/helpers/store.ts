import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every test file gets its own store directory, set before `@/lib/db` is first
 * imported. `db.ts` reads ADRIVAL_DATA_DIR at module load, so this must run at
 * the very top of a test file, before any dynamic import of app code.
 */
export function useTempStore(label: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `adrival-${label}-`));
  process.env.ADRIVAL_DATA_DIR = dir;
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET ?? "test-session-secret-do-not-use-in-production";
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
