# Postgres operations (Supabase)

How the app's database and file storage run on Supabase, and what to do for
backups, restores, archiving, the cutover import and moving to a paid plan.
All commands are run from the repo root.

## Environment variables

| Variable | Where | What it is for |
|---|---|---|
| `DATABASE_URL` | Railway (the app) | The runtime connection. Use the Supabase **transaction pooler** URL (port **6543**). Every app query and transaction goes through it. |
| `DATABASE_DIRECT_URL` | Railway (the app) and your shell (scripts) | A **session** connection for migrations at startup and for the scripts (import, verify, backup, restore). Use the direct connection, or the **session pooler on port 5432** if your network has no IPv6 (see below). Never the 6543 pooler: the scripts refuse it. |
| `SUPABASE_URL` | Railway and shell | Project URL (`https://<ref>.supabase.co`). Needed for Storage: page archive and backups. |
| `SUPABASE_SERVICE_ROLE_KEY` | Railway and shell | Service-role key for Storage. Server side only; it is never logged or sent to a browser. Without it (or `SUPABASE_URL`) archiving and the nightly backup are off, each with one log line at startup. |
| `RECREATED_PAGE_ARCHIVE_DAYS` | Railway (optional) | Days before recreated page content moves from the database to Storage. Default 14. |
| `DATABASE_TEST_URL` | Your shell, only for the staging tests | Direct URL of a **scratch** Supabase project (the tests create and drop their own schemas). |
| `LOADTEST_USERS` | Your shell, only for the load test | JSON array of test logins: `[{"username":"lt1","password":"..."}]`. |

**IPv4 note.** On the free plan the direct host (`db.<ref>.supabase.co:5432`)
is IPv6 only. From a machine or network without IPv6 (most home connections
and many CI runners), use the **session pooler**:
`postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
(Dashboard, Connect, "Session pooler"). Port 5432 on the pooler host is the
session pooler and is fine for scripts and migrations; port **6543** is the
transaction pooler and is only for `DATABASE_URL`.

## Free plan: what it means here

The Supabase free plan has **no automatic backups and no point-in-time
recovery**, and it **pauses a project after about a week without activity**.
The app covers both:

- **Nightly backup** at 02:00 server time (the Railway container's clock,
  usually UTC) into the Storage bucket `db-backups`. A failed run is retried
  once after 15 minutes. The newest 3 complete backups are kept.
- **Off-site copy**: a backup in `db-backups` lives inside the same Supabase
  project, so it is lost with the project. Pull a copy to your machine (or
  any other disk) regularly, at least weekly:
  `npm run backup:pull -- --out backups`
- **Keep-alive**: the app runs `select 1` every 12 hours (logged only when it
  fails). Normal traffic also counts. If the app itself is stopped for more
  than a week, the project can still pause; unpause it from the dashboard.

Budget: 500 MB database, 1 GB Storage. Measured on the real data before
cutover: 103 MB database **before** archiving page content (the recreated
pages are most of it); growth about 20 recreated pages, about 20 MB gzipped,
a month. Archiving keeps the database small; Storage holds the archive (about
70 MB gzipped now) plus three backups (each roughly the database size after
archiving, gzipped). Check sizes in the dashboard (Database, and Storage,
per bucket) once a month.

## Backups

What a backup is: every table of the app schema, streamed as gzip NDJSON (one
JSON object per row) to `db-backups/<YYYY-MM-DDTHHmmZ>/<table>.ndjson.gz`
(tables over 40 MB compressed are split into `<table>.1.ndjson.gz`,
`<table>.2.ndjson.gz`, ...), then `manifest.json` **last**, with row counts,
sizes and a sha-256 per file. A folder without `manifest.json` is an
incomplete backup: it is never restored, never counts as one of the 3 kept,
and is deleted once it is a day old.

**Not in the backup: archived page files.** Rows of `recreated_pages` whose
content was archived keep only `archive_path`; the files live in the Storage
bucket `recreated-pages-archive` and are not copied by the database backup.
To keep an off-site copy of those too, download that bucket from the
dashboard (Storage, `recreated-pages-archive`) now and then. After a restore
into the **same** project, archived pages open as before; into a **new**
project, copy the bucket over first or those pages show as unavailable.

The backup is not a single snapshot: tables are read one after another while
the app runs. A row written during the backup can be in one table and not a
related one; restore skips a page row whose competitor is missing and counts
it as skipped.

Run one now:

- From the app (platform admin): `POST /api/admin/backup` (audited). Returns
  `{ date, path, tables, rows, bytes }`. `409 backup_running` when one is
  running, `503 storage_not_configured` without Storage settings.
- List complete backups: `GET /api/admin/backup`.
- From a shell: `npm run backup:run` (uses `DATABASE_DIRECT_URL`, or
  `-- --url <url>`; `-- --keep 5` to keep more), or `npx tsx
  scripts/backup-db.ts list`.

## Restore from `db-backups`

1. Pick the backup: `GET /api/admin/backup`, or
   `npx tsx scripts/backup-db.ts list` (needs `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` in your shell).
2. Stop the app (Railway: scale to 0 or remove the start command), so nothing
   writes while you restore.
3. Restore into an **empty** database, best a new Supabase project (or a
   fresh one after deleting the broken one):
   ```sh
   npm run backup:restore -- --date 2026-10-26T0200Z --into-url "<direct or session-pooler URL of the target>"
   ```
   From a pulled copy instead of Storage (the project is gone):
   ```sh
   npm run backup:restore -- --date 2026-10-26T0200Z --from backups --into-url "<url>"
   ```
   The script refuses a target that has rows (pass `--allow-existing` only
   when you mean to add missing rows to an existing database; existing rows
   are left as they are), applies the migrations, checks every file's sha-256
   against the manifest **before inserting anything**, inserts table by table
   (re-running is safe: rows that are there are skipped), and moves the
   ledger/audit sequences past the restored rows.
4. If the target is a new project: copy the `recreated-pages-archive` bucket
   into it (see above), then point `DATABASE_URL`, `DATABASE_DIRECT_URL`,
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on Railway at it.
5. Start the app and smoke test: log in, open history, open an old (archived)
   recreated page, check a user's credit balance.

## Archive old recreated pages now

Page content older than `RECREATED_PAGE_ARCHIVE_DAYS` (default 14) moves to
Storage hourly. To run it now (platform admin):

```
POST /api/admin/archive-pages            {}                     # default window
POST /api/admin/archive-pages            {"olderThanDays": 0}   # every page
```

It returns `{ archived, failed }` and can take up to 5 minutes. A failed page
stays in the database and is tried again on the next run.

## Cutover import and verification

Run with the app **stopped** (see the cutover plan), against the direct or
session-pooler URL (never 6543):

```sh
npm run import:store -- --store data/store.pre-postgres.json --dry-run
npm run import:store -- --store data/store.pre-postgres.json --url "<session URL>" [--archive-days 14]
npm run verify:import -- --store data/store.pre-postgres.json --url "<session URL>"
```

The import refuses a database that already has users unless
`--allow-existing` (a rehearsal re-run); verify prints every mismatch and
exits non-zero when there is one. Take a backup right after a good verify:
`npm run backup:run`.

## Staging concurrency tests (run once before cutover)

The credit and run-lock races need real concurrent connections, which the
in-process test database cannot give. Against a scratch project (never the
production one):

```sh
DATABASE_TEST_URL="<direct URL of a scratch project>" npx tsx --test tests/dataCreditsStaging.test.ts tests/dataRunsStaging.test.ts
```

They skip themselves when `DATABASE_TEST_URL` is not set.

## Load test (optional, against staging)

```sh
LOADTEST_USERS='[{"username":"lt1","password":"..."}]' npm run loadtest -- --base https://<staging host> --users 6 --duration 60 [--job <run id>]
```

Read-only (history, unified history, a run's status, credit summary). Prints
p50/p95/max per endpoint; exits non-zero on errors or a p95 over
`--p95-ms` (default 2000).

## Moving to the paid plan

Only billing: upgrade the organization in the Supabase dashboard, then enable
point-in-time recovery (Database, Backups) if wanted. Nothing changes in the
app or its settings. The nightly backup and keep-alive can stay (an extra
copy is cheap) or be ignored.

## Single-instance limits

- Run state that lives in process memory (Manus recreate abort handles,
  suppressed-run sets, progress throttles, the brand-review "starting" mark)
  belongs to one container. Run **one** app instance.
- At startup the app marks every `running` job as failed (no live process
  owns it). During an **overlapping Railway deploy**, the new container's
  startup marks the **old** container's live runs failed while they are still
  running. Deploy when no run is in progress, or accept that runs in flight
  are marked failed and must be restarted. (Job leases would fix this; not
  built yet.)
- Migrations run at startup while the old container may still serve traffic,
  so every migration must stay **additive** (new tables, new nullable
  columns, new indexes). No renames or drops in the same deploy as the code
  that stops using them.
- Transactions are bounded server-side to 30 s (`SET LOCAL
  statement_timeout`), single queries to 30 s client-side; migrations get 10
  minutes.
