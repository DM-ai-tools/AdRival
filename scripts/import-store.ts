/*
 * store.json → Postgres import (the cutover data move).
 *
 *   npx tsx scripts/import-store.ts [--store data/store.json] [--url <direct url>]
 *                                   [--dry-run] [--archive-days N] [--allow-existing]
 *   npm run import:store -- --store data/store.pre-postgres.json
 *
 * - Run it while the app is STOPPED: the import takes no run locks.
 * - --url defaults to DATABASE_DIRECT_URL: the direct connection, never the
 *   transaction pooler (DDL, a 120 s statement timeout and a ~25 MB bytea
 *   parameter all need a session connection).
 * - --dry-run parses and migrates the file and prints the counts and warnings,
 *   without connecting to any database.
 * - The import refuses a database that already has users (a live database)
 *   unless --allow-existing is passed (checked before anything is written,
 *   migrations included; the target's migrations are applied next);
 *   re-running into a rehearsal database needs that flag (the import is
 *   idempotent: the same file gives the same rows).
 * - --archive-days N moves page content older than N days to Storage after the
 *   import (needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).
 * - store.json is only read.
 * Exits non-zero on any failure. Then run scripts/verify-import.ts.
 */
import { expectedHeavy } from "../src/lib/data/verifyImport";
import { assertEmptyTarget, importStore, planCounts, planImport } from "../src/lib/data/importStore";
import { migrate } from "../src/lib/data/migrate";
import { connectDirect, describeUrl, elapsed, loadStore, parseArgs } from "./storeScriptArgs";

function printWarnings(warnings: string[]): void {
  console.log(`warnings: ${warnings.length}`);
  for (const warning of warnings) console.log(`  - ${warning}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  console.log(`reading ${args.store} (read-only)`);
  const store = await loadStore(args.store);
  console.log(`parsed in ${elapsed(started)}`);

  if (args.dryRun) {
    const plan = planImport(store);
    const counts = planCounts(plan);
    let pages = 0;
    let pageBytes = 0;
    for (const competitor of plan.competitors) {
      const heavy = expectedHeavy(competitor.recreatedPage);
      if (!heavy) continue;
      pages += 1;
      pageBytes += Buffer.byteLength(JSON.stringify(heavy));
    }
    console.log("dry run: no database connection");
    console.log(`rows to write per collection:`);
    for (const [name, n] of Object.entries(counts)) console.log(`  ${name}: ${n}`);
    console.log(`  recreatedPages (content rows): ${pages}, ${(pageBytes / 1e6).toFixed(1)} MB uncompressed`);
    console.log(`running jobs/lookups to import as failed ("Interrupted by cutover"): ${plan.interruptedJobs}`);
    console.log(`ledgerSeq ${plan.prepared.ledgerSeq}, auditSeq ${plan.prepared.auditSeq}`);
    printWarnings(plan.warnings);
    const lost = plan.drops.filter((d) => d.lost).length;
    console.log(`records left out: ${plan.drops.length} (${lost} lost, ${plan.drops.length - lost} collapsed duplicates)`);
    console.log(`done in ${elapsed(started)}`);
    return;
  }

  if (!args.url) throw new Error("no database: pass --url or set DATABASE_DIRECT_URL (or use --dry-run)");
  console.log(`target ${describeUrl(args.url)}`);
  const conn = connectDirect(args.url);
  try {
    // Before anything is written (migrations included): a live database is refused.
    await assertEmptyTarget(conn.client, args.allowExisting);
    const applied = await migrate(conn.client);
    console.log(applied.length ? `applied migrations: ${applied.join(", ")}` : "schema is current");
    const report = await importStore(conn.client, store, {
      archiveOlderThanDays: args.archiveDays ?? undefined,
      log: (message) => console.log(`[${elapsed(started)}] ${message}`),
    });
    console.log("rows written per collection:");
    for (const [name, n] of Object.entries(report.counts)) console.log(`  ${name}: ${n}`);
    console.log(`page content: ${(report.pageBytes / 1e6).toFixed(1)} MB uncompressed`);
    console.log(`interrupted jobs/lookups: ${report.interruptedJobs}`);
    if (report.archive) {
      console.log(
        `archive: ${report.archive.archived} archived, ${report.archive.failed} failed, ${report.archive.leftInDatabase} left in the database`,
      );
    }
    printWarnings(report.warnings);
    const lost = report.drops.filter((d) => d.lost);
    if (lost.length) {
      console.log(`records NOT imported (lost; verify will fail): ${lost.length}`);
      process.exitCode = 1;
    }
    const { rows } = await conn.client.query<{ size: string }>("select pg_size_pretty(pg_database_size(current_database())) as size");
    console.log(`database size: ${rows[0]?.size}`);
    console.log(`import finished in ${elapsed(started)}; now run scripts/verify-import.ts`);
    if (report.archive && report.archive.failed > 0) process.exitCode = 1;
  } finally {
    await conn.close();
  }
}

main().catch((err: unknown) => {
  console.error(`import failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exitCode = 1;
});
