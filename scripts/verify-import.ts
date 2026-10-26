/*
 * Checks a database against the store.json it was imported from.
 *
 *   npx tsx scripts/verify-import.ts [--store data/store.json] [--url <direct url>]
 *   npm run verify:import -- --store data/store.pre-postgres.json
 *
 * Compares row ids per collection, every recreated page's content (byte length
 * and sha-256; archived pages are read from Storage, which needs SUPABASE_URL
 * and SUPABASE_SERVICE_ROLE_KEY), credit period counters, ledger sums per user,
 * password hashes and roles, and run statuses. Prints every mismatch and exits
 * non-zero when there is any. Read-only on both the file and the database.
 */
import { verifyImport } from "../src/lib/data/verifyImport";
import { connectDirect, describeUrl, elapsed, loadStore, parseArgs } from "./storeScriptArgs";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun || args.archiveDays !== null || args.allowExisting) {
    throw new Error("verify-import takes only --store and --url");
  }
  const started = Date.now();
  console.log(`reading ${args.store} (read-only)`);
  const store = await loadStore(args.store);
  if (!args.url) throw new Error("no database: pass --url or set DATABASE_DIRECT_URL");
  console.log(`target ${describeUrl(args.url)}`);
  const conn = connectDirect(args.url);
  try {
    const result = await verifyImport(conn.client, store, {
      log: (message) => console.log(`[${elapsed(started)}] ${message}`),
    });
    if (result.skipped.length) {
      console.log(`left out by the import on purpose (collapsed duplicates): ${result.skipped.length}`);
      for (const line of result.skipped) console.log(`  - ${line}`);
    }
    if (result.ok) {
      console.log(`ok: no mismatches (${elapsed(started)})`);
    } else {
      console.log(`${result.mismatches.length} mismatch(es):`);
      for (const line of result.mismatches) console.log(`  - ${line}`);
      process.exitCode = 1;
    }
  } finally {
    await conn.close();
  }
}

main().catch((err: unknown) => {
  console.error(`verify failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
