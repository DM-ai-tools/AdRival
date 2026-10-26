/**
 * Next.js calls register() once when the server starts, for every runtime.
 * The server start work (migrations, recovery, schedulers) lives in a
 * Node-only module loaded behind the NEXT_RUNTIME check, so the Edge bundle
 * never pulls in `pg` or a `process.exit` call.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
