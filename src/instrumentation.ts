/**
 * Next.js calls register() once when the server starts. Node runtime only, and
 * through a dynamic import so the Edge bundle never pulls in `pg`.
 * Schedulers of later tasks are started from here too.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartup } = await import("./lib/data/startup");
  try {
    await runStartup();
  } catch (err) {
    // No schema means no working app: exit so the platform's restart policy retries.
    console.error("[startup] migration failed, exiting:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
