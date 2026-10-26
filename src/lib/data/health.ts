import { getDb } from "./client";

export interface HealthBody {
  ok: boolean;
  service: "adrival";
  db: "up" | "down";
  error?: string;
}

const HEALTH_TIMEOUT_MS = 3000;

/** A short message that cannot carry a connection string or credentials (for logs). */
export function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/** `select 1` against the database, answered within 3 s or reported as down. */
export async function checkHealth(): Promise<{ status: number; body: HealthBody }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = getDb().query("select 1");
    probe.catch(() => {}); // a late failure after the timeout must not be unhandled
    await Promise.race([
      probe,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database did not answer within 3s")), HEALTH_TIMEOUT_MS);
      }),
    ]);
    return { status: 200, body: { ok: true, service: "adrival", db: "up" } };
  } catch (err) {
    // The probe is unauthenticated: the detail goes to the server log only.
    console.error(`[health] database check failed: ${safeMessage(err)}`);
    return { status: 503, body: { ok: false, service: "adrival", db: "down", error: "database unreachable" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
