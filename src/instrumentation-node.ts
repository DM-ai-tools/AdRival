import { runStartup, startSchedulers } from "./lib/data/startup";

/**
 * Node-runtime server start (loaded only from register() when NEXT_RUNTIME is
 * "nodejs"): migrations and recovery, then the background jobs (archive,
 * nightly backup, keep-alive). A failed migration exits the process so the
 * platform's restart policy retries; there is no working app without a schema.
 */
export async function registerNode(): Promise<void> {
  try {
    await runStartup();
  } catch (err) {
    console.error("[startup] migration failed, exiting:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
  startSchedulers();
}
