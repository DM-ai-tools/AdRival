# Postgres Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `data/store.json` with Supabase Postgres so 5 to 6 users can work at once, keeping every recreated page openable.

**Architecture:** A new async data layer under `src/lib/data/` (node-postgres, hand-written SQL, one table per collection with real filter columns plus a `jsonb` record). `src/lib/db.ts` becomes a thin barrel re-exporting the same function names, now async, so the 60 importing files keep their import paths. Recreated-page heavy content moves to its own gzip table and, after a retention window, to Supabase Storage. Credits use SQL transactions with row locks.

**Tech Stack:** Node 22, Next.js 15, TypeScript, `pg` (node-postgres), `@electric-sql/pglite` (tests), `typescript-eslint` (type-aware lint rules), Supabase Postgres (US West) + Supabase Storage via plain `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-23-postgres-migration-design.md`

## Global Constraints

- One app instance; Supabase used as plain Postgres + Storage. No supabase-js, no RLS, no Supabase auth.
- Runtime connects through the Supabase transaction pooler (`DATABASE_URL`); migrations, import and backup use the direct connection (`DATABASE_DIRECT_URL`). No named prepared statements, no session-level advisory locks.
- Every existing recreated page stays openable from history. Nothing is deleted. `sourceArchive` is NOT dropped without asking the owner.
- Archive window default 14 days (`RECREATED_PAGE_ARCHIVE_DAYS`); archived content is gzip in Storage bucket `recreated-pages-archive`.
- No feature behavior changes: same screens, same results.
- Credit reservations serialize per period (row lock); ledger/audit sequence numbers increase, gaps allowed.
- Gate every task on `npx tsc --noEmit`. No full `next build`, no long test runs inside checks; run only the named test files. The owner tests manually.
- Work on branch `postgres-migration`, from a git tag `pre-postgres-migration-2026-10-23` on current main. `data/store.json` is never modified or deleted by this work.
- The Supabase free plan has no backups and pauses after ~1 week idle: backups and keep-alive are in scope (Task 10).

## Review Focus

1. Two simultaneous `reserveCredits` on one period must not overspend (staging-DB test, Task 5).
2. Run and competitor list/history queries must never select recreated-page heavy content (query-spy test, Task 4).
3. A run deleted or stopped mid-flight must not be re-created by a later progress save (Task 3).
4. Opening an archived page whose Storage file is missing or unreadable shows a clear error, and the archive job never removes DB content before the upload is verified (Task 8).
5. Re-running the import is safe: no duplicated ledger entries, jobs left `running` become interrupted, the 46 MB record imports within pooler/statement limits (Task 9).
6. Database unreachable or project paused: `/api/health` reports it and requests fail with a clear error instead of crash-looping (Task 10).

---

## File Structure

- Create `src/lib/data/client.ts` — `Queryable`, `getDb()`, `withTx()`, `setClientForTests()`, `closeDb()`.
- Create `src/lib/data/migrate.ts` + `db/migrations/001_init.sql` (and later numbered files) — migration runner and schema.
- Create `src/lib/data/{runs,competitors,recreatedPages,lookups,icps,identity,spaces,settings,audit}.ts` — repositories, one per area, SQL only.
- Create `src/lib/data/credits.ts` — periods, ledger, reservations, provider calls (used by `accounting/*`).
- Create `src/lib/data/legacyStore.ts` — `migrateDb()` and shape types moved out of `db.ts`, pure, used only by the import.
- Create `src/lib/data/archive.ts`, `storageClient.ts` — Storage upload/download/delete and the archive job.
- Create `src/instrumentation.ts` — run migrations, interrupted-job recovery, schedulers on server start.
- Create `scripts/import-store.mjs`, `scripts/verify-import.mjs`, `scripts/backup-db.mjs`, `scripts/load-test.mjs`.
- Modify `src/lib/db.ts` → barrel. Modify `src/lib/accounting/{service,records}.ts`, `src/lib/auth/rateLimit.ts`, `src/lib/manus/usage.ts`, admin routes, and callers (tsc-driven).
- Modify `tests/helpers/store.ts`, `eslint.config.mjs`, `Dockerfile`, `package.json`, `src/app/api/health/route.ts`.

---

### Task 1: Safety net, branch, lint rules

**Files:**
- Modify: `eslint.config.mjs`, `package.json`
- Create: none

**Interfaces:**
- Produces: `npm run lint:async` that fails on floating or misused promises.

- [ ] **Step 1:** `git tag pre-postgres-migration-2026-10-23`, `git checkout -b postgres-migration`. Copy `data/store.json` to `data/store.pre-postgres.json` (untracked backup). Expected: `git tag -l` lists the tag.
- [ ] **Step 2:** `npm i -D typescript-eslint`. In `eslint.config.mjs` add an extra config block for `src/**/*.{ts,tsx}` and `tests/**/*.ts` with `languageOptions.parserOptions.projectService: true` and rules `@typescript-eslint/no-floating-promises: "error"`, `@typescript-eslint/no-misused-promises: "error"`, `@typescript-eslint/await-thenable: "error"`.
- [ ] **Step 3:** Put those three rules in a separate flat config `eslint.async.config.mjs` (type-aware, only those rules) and add script `"lint:async": "eslint -c eslint.async.config.mjs src tests"`. Run `npm run lint:async`. Expected: passes today (nothing async-misused); to prove it works, temporarily add `Promise.resolve(); ` in a file, see the error, remove it.
- [ ] **Step 4:** Commit `chore: type-aware async lint rules and rollback tag`.

### Task 2: Database client, migrations, schema

**Files:**
- Create: `src/lib/data/client.ts`, `src/lib/data/migrate.ts`, `db/migrations/001_init.sql`, `tests/helpers/testDb.ts`
- Test: `tests/dataClient.test.ts`

**Interfaces:**
- Produces (client.ts):
  - `interface Queryable { query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount: number }> }`
  - `function getDb(): Queryable` — a `pg.Pool` from `DATABASE_URL` (max 10, `statement_timeout` 30 s) unless a test client is set.
  - `function withTx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>` — BEGIN/COMMIT, ROLLBACK on throw, one connection.
  - `function setClientForTests(c: (Queryable & { tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T> }) | null): void`
  - `function closeDb(): Promise<void>`
- Produces (migrate.ts): `function migrate(db: Queryable, dir?: string): Promise<string[]>` — applies `db/migrations/*.sql` in name order, records in `schema_migrations(name text primary key, applied_at timestamptz)`, returns names applied this call; idempotent.
- Produces (tests/helpers/testDb.ts): `async function useTestDb(label: string): Promise<{ cleanup(): Promise<void> }>` — creates an in-process PGlite database, runs `migrate`, calls `setClientForTests`. Also `function hasStagingDb(): boolean` (true when `DATABASE_TEST_URL` is set) and `useStagingSchema(label)` which creates schema `t_<random>` on that URL, sets `search_path`, migrates, and drops the schema on cleanup (used only by concurrency tests).

Schema (`001_init.sql`), every table has `data jsonb not null` holding the full TypeScript record; listed columns are real, indexed where noted:
| table | real columns |
|---|---|
| `users` | `id pk, username unique (lower), org_id, role, status` |
| `organizations` | `id pk, archived_at` |
| `project_spaces` | `id pk, org_id, owner_user_id, archived_at` |
| `project_memberships`, `space_memberships` | `id pk, space_id/project_id, user_id` (index on both) |
| `jobs` | `id pk, owner_user_id, space_id, status, created_at` (index owner, space, created_at desc) |
| `lookup_jobs` | same as jobs |
| `competitors` | `id pk, run_id, owner_user_id, created_at` (index run_id) |
| `recreated_pages` | `competitor_id pk fk, content bytea null, archive_path text null, bytes int, updated_at, archived_at` — check `(content is not null) <> (archive_path is not null)` |
| `lookup_ads` | `id pk, lookup_id` (index) |
| `search_competitor_ads` | `id pk, run_id, competitor_id` (indexes) |
| `icps` | `id pk, source_kind, source_id, stage` unique (kind, id, stage) |
| `credit_periods` | `id pk, user_id, status` + partial unique index one `current` per user; `allowance, consumed, reserved bigint` mirrored from data |
| `credit_ledger` | `seq bigint pk default nextval('ledger_seq'), user_id, period_id, created_at` |
| `credit_reservations` | `id pk, user_id, period_id, status, expires_at` |
| `provider_calls` | `id pk, user_id, run_id, provider, created_at` (indexes) |
| `audit_logs` | `seq bigint pk default nextval('audit_seq'), created_at` |
| `conversion_rule_sets` | `version int pk` |
| `app_settings` | `id text pk default 'singleton'` |
| `admin_alerts`, `login_attempts` | `id pk, created_at` |
| `deleted_run_ids` | `id pk, created_at` |
| `seen_page_ids` | `id pk` |

- [ ] **Step 1: Write failing test** `tests/dataClient.test.ts`: `useTestDb("client")`; assert `migrate` returns `["001_init.sql"]` the first time and `[]` the second; assert `withTx` rolls back an insert when the callback throws (`select count(*) from seen_page_ids` is 0); assert the partial unique index rejects two `current` periods for one user.
- [ ] **Step 2:** Run `npx tsx --test tests/dataClient.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** `npm i pg @electric-sql/pglite` and `npm i -D @types/pg`. Implement `client.ts`, `migrate.ts`, `001_init.sql`, `testDb.ts` per the interfaces above.
- [ ] **Step 4:** Run the test. Expected: PASS. Run `npx tsc --noEmit`. Expected: clean.
- [ ] **Step 5:** Commit `feat: postgres client, migrations and schema`.

### Task 3: Runs and lookup jobs repositories

**Files:**
- Create: `src/lib/data/runs.ts`, `src/lib/data/legacyStore.ts` (move `migrateDb`, `emptyDb` and shape helpers out of `db.ts`; db.ts still compiles by importing them)
- Test: `tests/dataRuns.test.ts`

**Interfaces:**
- Consumes: `getDb`, `withTx` from Task 2.
- Produces `runs.ts` (same names and semantics as today's `db.ts`, now async, taking/returning the existing record types): `saveJob(job): Promise<boolean>`, `getJob(id)`, `updateJob(id, patch)`, `listJobs(limit)`, `listHistoryRuns(limit)`, `deleteHistoryRun(runId)`, `clearAllHistory()`, same set for lookup (`saveLookupJob`, `getLookupJob`, `updateLookupJob`, `listLookupJobs`, `listLookupHistory`, `deleteLookupHistoryRun`, `clearAllLookupHistory`), `stopSearchJob`, `stopLookupJob`, `stopAllInFlightWork`, `isSearchJobSuppressed`, `isLookupJobSuppressed`, `clearSearchJobSuppression`, `clearLookupJobSuppression`, `isSearchWorkInFlight`, `isLookupWorkInFlight`, `getSeenPageIds`, `markPageSeen`, plus `saveJobProgress` / `saveLookupJobProgress` with the existing throttle (`PROGRESS_WRITE_MS`) kept in-process.
- New: `markInterruptedJobs(): Promise<number>` — every job/lookup job still `running` becomes `failed` with `progress.message = "Interrupted by restart"`.

- [ ] **Step 1: Write failing tests** in `tests/dataRuns.test.ts` (PGlite): save/get roundtrip returns an equal job; `saveJob` returns `false` and does not re-create the row after `deleteHistoryRun(id)` (Review Focus 3); a job with `progress.stopRequested` is not overwritten by a later `saveJob`; `listHistoryRuns` returns newest first and respects `limit`; `markInterruptedJobs` returns 1 for one running job and leaves finished jobs untouched.
- [ ] **Step 2:** Run `npx tsx --test tests/dataRuns.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `runs.ts`. Delete-then-save race: the existence check against `deleted_run_ids` and the upsert run in one `withTx`. Port behavior from `db.ts` lines 148-430, 923-1150, 1200-1420; read those before writing.
- [ ] **Step 4:** Tests PASS, `npx tsc --noEmit` clean. Commit `feat: async runs repository`.

### Task 4: Competitors, recreated pages, ads, ICPs

**Files:**
- Create: `src/lib/data/competitors.ts`, `src/lib/data/recreatedPages.ts`, `src/lib/data/lookups.ts` (lookup ads + search competitor ads), `src/lib/data/icps.ts`
- Modify: `src/lib/types.ts` (add `RecreatedPageLight` and `RecreatedPageHeavy`)
- Test: `tests/dataCompetitors.test.ts`

**Interfaces:**
- Produces types: `RecreatedPageHeavy = { html: string; sourceArchive?: ...; previousHtml?: string; generatedImages?: ... }` (the heavy fields, taken from the real `recreatedPage` shape: `html`, `sourceArchive`, `generatedImages`, `previousHtml`); `RecreatedPageLight` = everything else, plus `{ hasPage: true; pageBytes: number; pageUpdatedAt: string }`. `CompetitorRecord.recreatedPage` becomes `RecreatedPageLight`.
- Produces: `saveCompetitor(c: CompetitorRecord & { recreatedPageHeavy?: RecreatedPageHeavy }): Promise<boolean>` (splits heavy content into `recreated_pages`, gzip of JSON), `getCompetitor(id): Promise<CompetitorRecord | null>` (light), `getCompetitorsByRun`, `getRecreateOnlyPagesByRun`, `listAllCompetitors`, `updateCompetitor` (never loads heavy content), `getRecreatedPage(competitorId): Promise<RecreatedPageHeavy | null>` (loads from DB or, if `archive_path` is set, from Storage via `fetchArchived` from Task 8; throws `ArchivedPageUnavailableError` if the file cannot be read), `setRecreatedPage(competitorId, heavy): Promise<void>` (clears `archive_path`, resets `archived_at`).
- Lookup and ICP functions keep today's names: `saveLookupAd(s)`, `getLookupAd`, `updateLookupAd`, `getLookupAds`, `saveSearchCompetitorAd(s)`, `getSearchCompetitorAdsByRun`, `getSearchCompetitorAdsByCompetitor`, `getIcps`, `getIcp`, `upsertIcp`.

- [ ] **Step 1: Write failing tests** `tests/dataCompetitors.test.ts`: (a) save a competitor with a 2 MB heavy `html`, `getCompetitor` returns it without `html`/`sourceArchive`; `getRecreatedPage` returns the identical html; (b) with the DB client wrapped in a spy that records SQL text, call `getCompetitorsByRun`, `listAllCompetitors`, `listHistoryRuns`, `updateCompetitor`; assert none of the recorded statements reference `recreated_pages` (Review Focus 2); (c) `upsertIcp` twice with the same kind/id/stage leaves one row.
- [ ] **Step 2:** Run; Expected: FAIL.
- [ ] **Step 3:** Implement. Gzip with `node:zlib` (`gzipSync(JSON.stringify(heavy))`); a competitor delete cascades to its page row.
- [ ] **Step 4:** PASS and `tsc` — the type change will break callers of `recreatedPage.html`; list the broken files in the commit message but fix them in Task 6. To keep this task's `tsc` gate green, add the new types and repositories without changing `CompetitorRecord` yet; switch the field type in Task 6 Step 1.
- [ ] **Step 5:** Commit `feat: async competitors, recreated pages, ads, icps repositories`.

### Task 5: Identity, spaces, settings, audit, credits

**Files:**
- Create: `src/lib/data/{identity,spaces,settings,audit,credits}.ts`
- Test: `tests/dataCredits.test.ts`, `tests/dataIdentity.test.ts`

**Interfaces:**
- Produces: async versions, same names and signatures minus `db` params, of `db.ts` lines 1467-1995 (users, organizations, app settings, projects and spaces, memberships, admin alerts) and of `accounting/records.ts` (`appendLedgerEntries`, `queryLedger`, `recordAudit`, `queryAudit`, memberships, conversion rule sets) and `accounting/service.ts`. Service functions that previously took `db: DatabaseShape` (`recoverAbandonedReservations`) take a `Queryable` transaction instead. `credits.ts` exposes the building blocks: `lockCurrentPeriod(tx, userId): Promise<CreditPeriod | null>` (`SELECT ... FOR UPDATE`), `savePeriod(tx, period)`, `insertLedger(tx, entry): Promise<CreditLedgerEntry>` (sequence from `ledger_seq`), `insertReservation`, `updateReservation`, `insertProviderCall`.
- `reserveCredits`, `settleProviderCall`, `releaseReservation`, `extendReservation`, `addCredits`, `setAllowance`, `recordAdjustment`, `resolveReconciliation` each run inside one `withTx` and lock the user's current period row first. Any function that today writes user + ledger + audit in one `transaction()` keeps doing so in one SQL transaction (spec: preserve atomicity everywhere).
- Keep `availableSubunits(period)` and `userHasUnlimitedCredits` unchanged (pure).

- [ ] **Step 1: Write failing tests.** `tests/dataCredits.test.ts` (PGlite): reserve → settle → balance equals allowance minus charge; reserve more than available returns `ok: false`; unlimited-org user reserves past allowance; ledger `seq` strictly increases; a throwing step inside `settleProviderCall` leaves ledger, period and reservation unchanged (rollback). Concurrency test (skipped unless `hasStagingDb()`): two `Promise.all` reservations of 60 against an allowance of 100 → exactly one `ok`. `tests/dataIdentity.test.ts`: create/get/update user, case-insensitive username lookup, `countActiveAdmins`, `orgUserIds`.
- [ ] **Step 2:** Run both; Expected: FAIL.
- [ ] **Step 3:** Implement by porting from `accounting/service.ts` and `db.ts`; the service files are rewritten in place to call `credits.ts` and become async.
- [ ] **Step 4:** Run both tests and the staging concurrency test once with `DATABASE_TEST_URL` set to the staging project's direct URL. Expected: PASS. `tsc` is allowed to fail only in files still importing the old sync API; those are fixed in Task 6.
- [ ] **Step 5:** Commit `feat: async identity, settings, audit and credit repositories`.

### Task 6: Switch `db.ts` to the new layer and fix callers

**Files:**
- Modify: `src/lib/db.ts` (becomes barrel), `src/lib/types.ts` (`CompetitorRecord.recreatedPage: RecreatedPageLight`), all tsc-reported callers, `tests/helpers/store.ts`, existing tests
- Modify: `src/lib/auth/rateLimit.ts`, `src/lib/manus/usage.ts`, `src/app/api/admin/{overview,spaces,usage,runs}/route.ts`, `src/lib/accounting/*`

**Interfaces:**
- `db.ts` re-exports every name it exported before (list in the spec's source: `grep -n "^export" src/lib/db.ts` before editing), from `src/lib/data/*`. `readDb()`, `transaction()`, `replaceStore`, `mergeStore`, `getStoreStats` are removed from the public API; their callers are rewritten to specific repository calls (the 70 call sites across `accounting/*`, `rateLimit.ts`, `manus/usage.ts` and four admin routes). `replaceStore`/`mergeStore` (history import) get a Postgres implementation in `src/lib/data/importHistory.ts` used by `api/admin/import-history/route.ts` and `scripts/import-history.mjs`.
- `tests/helpers/store.ts`: `useTempStore(label)` keeps its name but now returns `Promise<{ cleanup(): Promise<void> }>` using `useTestDb`; existing test files change from `const store = useTempStore(...)` to `const store = await useTempStore(...)` and `await` their db calls.

- [ ] **Step 1:** Change `CompetitorRecord.recreatedPage` to `RecreatedPageLight`; rewrite `db.ts` as the barrel. Run `npx tsc --noEmit` and record the error count in the commit body.
- [ ] **Step 2:** Fix callers in this order, running `tsc` after each group and committing when the group's errors are zero: (1) `src/lib/accounting/*`, `rateLimit.ts`, `manus/usage.ts`, admin routes; (2) `src/lib/pipeline/**` and `src/lib/openai|openrouter/**`; (3) `src/app/api/**`; (4) `src/app/**` pages and components. Where a caller used `recreatedPage.html` or `sourceArchive` (`api/competitors/recreate-page`, `api/search/landing-recreate`, `app/recreate/[competitorId]`, `competitorView`, `fullReportExcel`, `landingRecreateBridge`, `lookupRecreateBridge`, `manus/run`), call `getRecreatedPage(id)` / `setRecreatedPage` explicitly; `fullReportExcel` loads pages in a separate per-competitor query at export time. Components that only need "has a page" use `hasPage`.
- [ ] **Step 3:** Convert the per-process pieces that used sync db calls: `manus/assets.ts` keeps its disk directory (`recreate-assets/`) — decide per the file's use; if the Railway volume is going away, move assets into a `recreate_assets` table (flag this to the owner if so, do not decide silently).
- [ ] **Step 4:** Run `npm run lint:async`. Expected: zero errors. Fix every floating/misused promise (`if (getJob(id))` style bugs).
- [ ] **Step 5:** Convert tests: update `tests/helpers/store.ts` and each test file; delete `tests/migration.test.ts` here and recreate it in Task 9 against the import. Run, in two batches, `npx tsx --test tests/accounting.test.ts tests/authorization.test.ts tests/adminTools.test.ts tests/icp.test.ts tests/landingRecreate.test.ts tests/brandReviewAccuracy.test.ts tests/lookupStop.test.ts tests/stopRestart.test.ts tests/progressThrottle.test.ts tests/importOwners.test.ts` then the remaining files named in `package.json` `test`. Expected: PASS; `adminTools.test.ts` reads `data/store.json` today — change it to build its own fixtures.
- [ ] **Step 6:** `npx tsc --noEmit` clean, commit `refactor: db.ts is now the async postgres layer`.

### Task 7: Server start: migrations, recovery, health

**Files:**
- Create: `src/instrumentation.ts`
- Modify: `src/app/api/health/route.ts`, `Dockerfile` (copy `db/migrations`), `.env.example`, `next.config.*` if needed to include the migrations folder in standalone output
- Test: `tests/startup.test.ts`

**Interfaces:**
- Produces: `register()` in `instrumentation.ts` (Node runtime only): `migrate(getDb())`, `markInterruptedJobs()`, `sweepAbandonedReservations()`, then starts the schedulers from Tasks 8 and 10. `/api/health` returns `{ ok, db: "up" | "down", error? }` with status 503 when the database cannot answer `select 1` within 3 s.
- Env documented in `.env.example`: `DATABASE_URL`, `DATABASE_DIRECT_URL`, `DATABASE_TEST_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RECREATED_PAGE_ARCHIVE_DAYS`.

- [ ] **Step 1: Write failing test:** with a test client whose `query` rejects, the health handler returns 503 with `db: "down"` (Review Focus 6); with PGlite it returns 200 `db: "up"`.
- [ ] **Step 2:** Run; Expected: FAIL.
- [ ] **Step 3:** Implement the above. A failed startup migration logs and exits non-zero (Railway retry policy handles it); other startup tasks log and continue.
- [ ] **Step 4:** Test PASS, `tsc` clean. Commit `feat: startup migrations, interrupted-job recovery, db health`.

### Task 8: Archive recreated pages to Storage

**Files:**
- Create: `src/lib/data/storageClient.ts`, `src/lib/data/archive.ts`
- Modify: `src/lib/data/recreatedPages.ts` (use `fetchArchived`)
- Test: `tests/archive.test.ts`

**Interfaces:**
- `storageClient.ts`: `putObject(bucket: string, path: string, body: Buffer): Promise<void>`, `getObject(bucket, path): Promise<Buffer>`, `deleteObject(bucket, path): Promise<void>` using `fetch` to `${SUPABASE_URL}/storage/v1/object/...` with the service-role key; `setStorageForTests(impl | null)` swaps in an in-memory implementation.
- `archive.ts`: `archiveOldPages(opts?: { olderThanDays?: number; now?: Date }): Promise<{ archived: number; failed: number }>` — for each `recreated_pages` row with `content` older than the window: upload gzip to `recreated-pages-archive/<competitor_id>.json.gz`, read it back and compare byte length and sha-256, only then `update ... set content = null, archive_path = $1, archived_at = now()`. `fetchArchived(path): Promise<Buffer>`. `class ArchivedPageUnavailableError extends Error`.
- Scheduler: `startArchiveScheduler()` runs `archiveOldPages()` hourly; a manual route `POST /api/admin/archive-pages` (platform admin only) runs it now.

- [ ] **Step 1: Write failing tests** (in-memory storage): page older than 14 days is archived and `getRecreatedPage` returns identical html afterwards; page younger than the window is untouched; when `putObject` throws, the DB `content` is still present (`failed: 1`); when `getObject` returns different bytes the content is NOT removed; `getRecreatedPage` on an archived row whose object is gone throws `ArchivedPageUnavailableError` (Review Focus 4); `setRecreatedPage` on an archived page brings content back into the DB.
- [ ] **Step 2:** Run; Expected: FAIL.
- [ ] **Step 3:** Implement. The recreate page UI (`app/recreate/[competitorId]/RecreatePageClient.tsx` / its API route) shows a plain "This archived page could not be loaded, try again" message on `ArchivedPageUnavailableError`.
- [ ] **Step 4:** PASS, `tsc` clean. Commit `feat: archive old recreated pages to Supabase Storage`.

### Task 9: Import script, verification, rehearsal

**Files:**
- Create: `scripts/import-store.mjs`, `scripts/verify-import.mjs`, `src/lib/data/importStore.ts`, `src/lib/data/verifyImport.ts`
- Test: `tests/importStore.test.ts` (replaces the deleted `migration.test.ts`)

**Interfaces:**
- `importStore(db: Queryable, store: DatabaseShape, opts?: { archiveOlderThanDays?: number }): Promise<ImportReport>` — runs `migrateDb` from `legacyStore.ts` on the raw store, inserts every collection in FK order, one `withTx` per collection, in batches of 200 rows; each `recreatedPage` is its own statement with split light/heavy content; jobs still `running` are inserted as `failed` with `progress.message = "Interrupted by cutover"`; every insert is `on conflict (id) do update` (ledger/audit by `seq`), then sequences are set with `setval(max(seq))`. `ImportReport = { counts: Record<string, number>; pageBytes: number }`.
- `verifyImport(db, store): Promise<{ ok: boolean; mismatches: string[] }>` compares row counts per collection, every recreated page's byte length against the original JSON of its heavy fields, per-user period `allowance/consumed/reserved` and ledger sums.
- Scripts take `--store <path>` (default `data/store.json`) and `--url <DATABASE_DIRECT_URL>`; `import-store.mjs --dry-run` parses, migrates and prints counts without connecting.

- [ ] **Step 1: Write failing tests** with a small fixture store built in the test: counts match after import; importing twice leaves identical counts and no duplicate ledger rows (Review Focus 5); a v1-shaped store (reuse the old `tests/migration.test.ts` fixture) imports and `getUserById` finds its owner-attributed runs; a `running` job becomes `failed`; `verifyImport` reports a mismatch when one page's html is altered.
- [ ] **Step 2:** Run; Expected: FAIL.
- [ ] **Step 3:** Implement. For the 46 MB record: insert heavy content via a single parameterized statement with `bytea`; the import script uses `DATABASE_DIRECT_URL` and a 120 s statement timeout. If the 50 MB `bytea` insert exceeds the pooler limit on staging, fall back to `COPY` — decide from the rehearsal.
- [ ] **Step 4:** Tests PASS, `tsc` clean. Commit `feat: idempotent store.json import and verification`.
- [ ] **Step 5 (rehearsal, needs the owner's staging project):** with `DATABASE_DIRECT_URL` set to the staging Supabase project, run `node scripts/import-store.mjs --store data/store.pre-postgres.json`, then `node scripts/verify-import.mjs`. Expected: `ok: true`, zero mismatches; record elapsed time and database size (`select pg_size_pretty(pg_database_size(current_database()))`, must stay far under 500 MB after archiving: run `POST /api/admin/archive-pages` and recheck). Save results in `docs/superpowers/plans/2026-10-23-postgres-rehearsal-notes.md`.

### Task 10: Backups, keep-alive, load test

**Files:**
- Create: `scripts/backup-db.mjs`, `scripts/load-test.mjs`, `src/lib/data/backup.ts`
- Modify: `package.json` (`backup:run`, `backup:pull`, `loadtest`), `src/instrumentation.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- `backup.ts`: `runBackup(db: Queryable, storage: StorageLike, opts?: { keep?: number }): Promise<{ path: string; tables: number; bytes: number }>` — streams every table as gzip NDJSON (cursor reads, no `pg_dump`) into bucket `db-backups/<ISO date>.tar`-style folder `db-backups/<date>/<table>.ndjson.gz`, keeps the newest `keep` (default 3) dates, deletes older ones. Nightly scheduler `startBackupScheduler()` (02:00 server time) plus keep-alive `select 1` every 12 h.
- `backup:pull` downloads the newest backup folder to `backups/<date>/` on the machine it runs on, so a copy exists outside the Supabase project.
- `scripts/load-test.mjs --base <url> --users 6`: logs in six test users (env `LOADTEST_USERS` JSON), each loops history list, live-results poll for a running job, and a credit reservation, for 60 s; prints p50/p95 latency per endpoint and the number of non-2xx responses.

- [ ] **Step 1: Write failing test:** `runBackup` on a PGlite DB with seeded rows writes one object per table to the in-memory storage and a restore of those objects (`restoreBackup(db, storage, date)` in the same file) reproduces equal row counts; with `keep: 2` after three runs only two dates remain.
- [ ] **Step 2:** Run; Expected: FAIL. **Step 3:** Implement. **Step 4:** PASS, `tsc` clean.
- [ ] **Step 5:** Commit `feat: nightly db backup, keep-alive and load test script`.
- [ ] **Step 6:** Write `docs/POSTGRES_OPERATIONS.md` (env vars, how to restore from `db-backups`, how to run the archive manually, how to move to the paid plan). Commit `docs: postgres operations`.

### Task 11: Cutover runbook and execution

**Files:**
- Create: `docs/superpowers/plans/2026-10-23-postgres-cutover-runbook.md`

- [ ] **Step 1:** Write the runbook with exact commands and an "abort and roll back" line after each step: (1) announce window; (2) in the app, stop new runs and wait for running jobs to finish or stop them; (3) stop the Railway service; (4) `git tag pre-postgres-cutover`, copy `data/store.json` off the volume to a safe location; (5) run `import-store.mjs` against the production Supabase direct URL, then `verify-import.mjs`; (6) set `DATABASE_URL`, `DATABASE_DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in Railway and deploy the `postgres-migration` branch; (7) smoke test: log in, open history, open an old recreated page, open a page that was archived, start and stop a search, reserve and settle credits; (8) run `npm run loadtest` against production off-hours; (9) reopen. Rollback: redeploy the previous build; `store.json` is untouched and still current to the cutover.
- [ ] **Step 2:** Rehearse steps 5 to 8 against staging with the owner and time them. Expected: under 30 minutes total for steps 3 to 7.
- [ ] **Step 3:** The owner runs the real cutover. Do not delete `store.json` or its backup for at least 14 days.
