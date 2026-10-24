/*
 * Recreated pages moved out of the database to Storage. Task 8 implements the
 * Storage side; until then every archived read fails with
 * ArchivedPageUnavailableError.
 */

/** An archived page whose file could not be read (missing, unreachable, corrupt, or no archive configured). */
export class ArchivedPageUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ArchivedPageUnavailableError";
  }
}

/** The stored (gzip) bytes of an archived page. */
export function fetchArchived(path: string): Promise<Buffer> {
  return Promise.reject(new ArchivedPageUnavailableError(`archive not configured (${path})`));
}
