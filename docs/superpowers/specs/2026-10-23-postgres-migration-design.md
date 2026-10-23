# Move the data store from store.json to Postgres (Supabase)

Status: draft for approval, 2026-10-23.

## Why

The app keeps everything in one file, `data/store.json` (142 MB on 2026-10-22).
Every save, and every read after another process saved, handles the whole file.
Measured on the real file:

| Step | Time |
|---|---|
| Read file | ~0.5 s |
| `JSON.parse` | ~0.5 s |
| `JSON.stringify` + write | ~0.8 s |

All of it is synchronous, so while one request does it, the Node process
answers nobody. Writes also take a whole-store lockfile, and each write
invalidates every other instance's in-memory copy, so each re-reads and
re-parses 142 MB. This is why, with three or more users at once, every screen
(history, live results, everything) slowed down, and why adding instances made
it worse.

124 MB of the 142 MB is `recreatedPage` HTML stored inside competitor records
(one record is 46 MB). The rest is small: lookup ads 7 MB, credit ledger 6 MB,
provider calls 3.6 MB, search competitor ads 2.8 MB.

## Goals

- 5 to 6 people using the app at once with no visible slowdown on any screen.
  This is the success bar the owner set.
- A real database in place of the JSON file.
- Every existing recreated page stays and stays openable from history. Nothing
  is archived or dropped.
- No change to what any feature does. Same screens, same results.
- Credit accounting stays correct under concurrency (no two runs can both
  reserve the same balance).

## Non-goals

- Running several app instances at once. Plan for one instance. The design must
  not make multi-instance harder, but job ownership/leases for in-flight runs
  are out of scope (see "Runs in flight").
- Using Supabase auth, storage, realtime or row-level security. Supabase is
  plain hosted Postgres here.
- Redesigning the data model or cleaning up old data.
- Changing the A/B, awareness or recreate features.

## Anti-goals

- A migration that loses or alters a user, credit entry, run or recreated page.
- Making the history page still load the HTML blobs in lists.
- A half-async codebase where a forgotten `await` silently passes a truthy
  Promise (`if (getJob(id))`).

## Decisions made with the owner

- Database: Supabase Postgres. Other Postgres hosts are acceptable; keep the
  code on a plain connection string so switching is configuration.
- Existing recreated pages are all kept and openable from history. Older pages
  may be archived to Supabase Storage after a few days, provided they stay
  openable (owner asked for this to stay on the free plan).
- Cutover may take the app offline for 15 to 30 minutes, outside working hours.
- Target is one instance for now.

## Design (the parts decided; builder fills the rest)

### Access layer
- Direct Postgres through the Supabase pooler, using node-postgres, with
  hand-written SQL in a repository layer. No ORM, no supabase-js. (Assistant's call.)
- Runtime connection through the transaction pooler. Migrations and the import
  script use the direct connection.
- `src/lib/db.ts` keeps its exported function names but they become `async`
  and read/write tables. `readDb()` and `transaction()` (70 uses across 9 files,
  mostly accounting) are replaced by specific queries and real SQL transactions;
  no function returns the whole store.
- The in-memory whole-store cache, the file stamp logic and the lockfile are
  deleted.

### Tables
- One table per current collection: jobs, competitors, lookup_jobs,
  lookup_ads, search_competitor_ads, icps, users, organizations, project_spaces,
  project_memberships, space_memberships, app_settings, conversion_rule_sets,
  credit_periods, credit_ledger, credit_reservations, provider_calls,
  audit_logs, admin_alerts, login_attempts, deleted_run_ids, seen_page_ids,
  plus counters for `ledgerSeq` and `auditSeq` (sequences).
- Each table has real columns for what is filtered, joined, sorted or scoped
  (ids, owner/space/org ids, status, timestamps, run ids) and a `jsonb` column
  for the rest of the record, so the TypeScript record types stay the source of
  truth. Exact column lists are the builder's job after reading each query site.
- Credit tables (periods, ledger, reservations) are relational with proper
  constraints, because balances must be right under concurrency.
- `recreated_pages` is its own table: competitor id, content, size,
  timestamps, and where the content lives (database or archive). The competitor
  row keeps only a small marker in place of the page. List and history queries
  never select the content; it is fetched only when a user opens that page.
- **Free-tier storage (owner is on the Supabase free plan, 500 MB database).**
  Measured on the real data: 67 recreated pages, 124 MB raw, 68 MB gzipped
  (only ~2x: the `html` field is 75 MB raw / 42 MB gz, `sourceArchive` 45 MB raw
  / 25 MB gz). Growth is roughly 20 pages a month, about 20 MB gzipped. So:
  1. All page content is gzip-compressed before storage.
  2. After a retention window (default 14 days, configurable; owner's call to
     archive after "a few days") the content moves from the database to
     Supabase Storage (1 GB free, separate from the 500 MB database) as a gzip
     file. The `recreated_pages` row stays with its marker and archive path.
  3. Archived pages stay openable from history: opening one fetches and
     decompresses the file, a little slower than a recent one. Nothing is
     deleted. This keeps the owner's earlier requirement that every page stays
     openable.
  4. Archiving is a scheduled job plus a manual "archive now". The first run
     archives everything older than the window during the import.
  Open for the builder: whether `sourceArchive` (the captured source of the
  competitor page) needs to be kept as is; it is 45 MB of the total and is not
  needed to show a recreated page. Do not drop it without asking the owner.
- Anything else in `competitors` over about 100 KB per record should be
  checked by the builder the same way (the next largest fields are small:
  sampleAd 0.4 MB, pageAnalysis 0.3 MB, brand 0.2 MB in total).

### Credit accounting
- Reservation, settlement and refund run as real transactions with row locks
  (`SELECT ... FOR UPDATE` on the period/user balance rows), replacing the
  whole-store lock that `transaction()` gives today. Behavior under two
  simultaneous reservations must match the current guarantee: they serialize,
  neither sees a stale balance.

### Runs in flight
- Run deletion and stop are already durable in the store (`deletedRunIds`,
  `progress.stopRequested`), so they carry over as table data.
- The per-process in-memory pieces (Manus recreate AbortController map in
  `manus/run.ts`, the suppressed-job sets and progress-throttle maps in
  `db.ts`) stay per-process. This is correct for one instance. It is a known
  limit for several instances; adding DB-backed job ownership later is a
  separate project.
- Progress saves become single-row updates, so the existing throttle can stay
  as is.

### Converting to async safely
- Turn on `@typescript-eslint/no-floating-promises` and
  `no-misused-promises` first, before converting, so missed awaits are lint
  errors, not silent bugs.
- Convert in layers: db.ts exports and the accounting service first, then call
  sites (74 files import db.ts; 39 files under `src/lib` use Maps/Sets, most
  probably just caches and need no change).
- Gate each step on `tsc` (the production build type-checks tests). No full
  builds or long test runs inside checks; the owner tests manually.

### Data move (cutover)
- An idempotent import script reads `store.json` and loads every collection,
  including `recreatedPage` HTML into `recreated_pages`. It can be re-run
  safely.
- Verification before go-live: row counts per collection match; every
  `recreatedPage` byte length matches; credit balances per period and user
  match what the file store computes; ledger sums match.
- Cutover: stop the app, take a final copy of `store.json`, run the import and
  checks, deploy the new build with the database URL, smoke test, reopen.
- Rollback: keep `store.json` untouched and the previous build tagged. If a
  check fails, redeploy the old build; the file is still the source of truth up
  to the cutover. Take a git tag before starting, matching the repo's existing
  practice (`pre-awareness-ab-merge-2026-10-22`).
- The Supabase free plan has no automatic backups or point-in-time recovery,
  and it pauses a project after about a week of inactivity. So: a nightly
  `pg_dump` (database) plus a copy of the Storage archive to somewhere else,
  run by a scheduled job, with a documented restore; and a keep-alive (the
  app's own traffic or a scheduled ping) so the project does not pause. The
  paid plan removes both problems; moving to it later is only a billing change.

### Tests
- The ~6 test files that touch the file store (`accounting`, `adminTools`,
  `brandReviewAccuracy`, `icp`, `landingRecreate`, `migration`) move to a
  throwaway Postgres. The builder chooses how (local Postgres, a container, or
  an in-process Postgres). Add a concurrency test for credit reservation and a
  test that history list queries do not select the HTML column.

## Calls made after the builder check (assistant's calls unless marked)

- **Runs in flight at cutover:** drain first. Stop new runs, let running ones
  finish or stop them, before taking the final copy of `store.json`. The import
  marks any job still `running` as interrupted. After go-live, on startup, any
  `running` job with no live process is marked interrupted (one instance makes
  this safe). Match what the app does on restart today.
- **Atomicity:** preserve it everywhere `transaction()` composes more than one
  collection (user + ledger + audit, reserve/settle/refund), not only in the
  accounting service. The builder audits all 70 `readDb()`/`transaction()`
  sites and wraps each multi-collection write in one SQL transaction.
- **Credit balance:** today a period stores its counters and
  `availableSubunits(period)` derives the balance; unlimited orgs skip the
  limit check. Keep the stored-counter model and lock the period row. Ledger and
  audit sequence numbers must be increasing; gaps are acceptable (a Postgres
  sequence is fine).
- **Other users of the data directory:** only `src/app/api/admin/import-history`,
  `scripts/import-history.mjs` and `src/lib/pipeline/manus/assets.ts` touch
  `store.json` or the data dir besides `db.ts`. Convert the history import to
  the database; check what `manus/assets.ts` needs from the data dir.
- **Other readers of `recreatedPage`:** the recreate page, landing-recreate
  routes, `competitorView`, `CompetitorTable`, `JourneySteps`, the Manus run,
  the lookup/landing recreate bridges and the full-run Excel export. Lists get
  a small marker only; the recreate page fetches the HTML on open; the Excel
  export fetches it in a separate query at export time. Nothing that lists
  competitors selects the HTML column.
- **Acceptance test:** the owner tests manually with 5 to 6 people. The builder
  also provides a small load script (5 to 6 concurrent sessions hitting the
  history, live results and a credit reservation) so before/after times can be
  compared.
- **Rehearsal:** the import runs at least once, end to end, on a copy of
  production data against a staging database, before the real cutover.

- **Region:** Railway's workspace default is US West (California); the existing
  Supabase project is in Seoul (ap-northeast-2). A Seoul database would add
  roughly 130 to 150 ms to every query. Create the real project (and a staging
  one) in Supabase's US West region and leave the Seoul project unused. The
  builder confirms the deployed Railway service's own region first, since the
  workspace default only applies to new services.

## Left to the builder
- Exact columns and indexes per table, from reading each query site.
- Migration tooling and file layout for SQL migrations.
- Test database approach.
- Order within the layers above, and how to split into reviewable commits.
- Connection pool sizing for one Railway instance.

## Open risks
- 74 importing files and ~30 accounting call sites make this a large change.
  Mitigation is the lint rules plus layered conversion.
- Anything that today mutates a record returned by `readDb()` and relies on it
  being saved by a later `transaction()` has to be found and made an explicit
  update.
- Railway and Supabase region should be close; a distant database adds latency
  to every query. Pick the Supabase region next to the Railway region.

## Success check
With 5 to 6 people running searches and browsing history and live results at
the same time, no screen noticeably stalls, and credit balances stay correct.
