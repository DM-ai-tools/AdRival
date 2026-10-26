# Postgres cutover runbook

For the product owner. Claude helps you run it. Follow the steps in order.
Each step says how to check it worked and how to undo it.

**Honest status.** All the code was tested against an in-memory test
database and against a real copy of your data in that test database. Nothing
has ever been run against a real Supabase project. Phase B (rehearsal) is
the first real run. Expect to find small problems there. That is why it exists.

Commands marked "(Git Bash)" run in Git Bash. Commands marked "(PowerShell)"
run in PowerShell. Run all `npm` commands from the repo folder
`C:\Users\Rithin\.cursor\projects\COmpetitor Finder`.

**Never paste a password, a connection string or a key into chat, into git,
or into a file that is committed.** Put them only in Railway variables, in
`.env.local` (it is git-ignored), or type them in your own terminal.

## 0. The four phases

| Phase | What | Where | Time |
|---|---|---|---|
| A | One-time checks before the day (incl. the maintenance switch, A9) | Supabase, Railway dashboards | 45-60 min |
| B | Rehearsal: the whole move, on a throwaway Supabase project | Your PC | 1-2 hours |
| C | Cutover: the real move | Railway + production Supabase | 15-30 min offline, outside working hours |
| D | After go-live: watch, back up, know the limits | Dashboards + your PC | first week |

Rule: **nothing is merged to `main` until the rehearsal has passed and the
cutover smoke test has passed.** The code lives on branch `postgres-migration`.
The restore point before any change is the git tag
`pre-postgres-migration-2026-10-23`.

Words used here:
- **Pooler**: a Supabase front door that shares database connections. It has
  two modes: *session* (port 5432) and *transaction* (port 6543).
- **Storage**: Supabase's file store. We use it for archived recreated pages
  and for database backups.
- **Rollback**: go back to how things were before the step.

---

## A. Before the day (owner only)

### A1. Create two Supabase projects

You need two: one **production**, one **scratch** (a throwaway for
rehearsal). The free plan allows two projects.

1. Go to https://supabase.com/dashboard and sign in.
2. Production project: you already created one in the Americas. Open it,
   then Project Settings, then General. Check the **Region**.
   Railway runs in **US West**. The best match is "West US (North
   California)" (or the nearest US West option offered). In your Railway
   service, Settings shows its region; compare the two.
   - If the regions are close (both US West): keep it.
   - If Supabase is far from Railway (for example South America or US East):
     every page load gets slower. Delete the project (it is empty) and
     create a new one in the US West region. The region cannot be changed
     later.
3. Create the scratch project: New project, name `adrival-scratch`, same
   region, any strong password. Save the password in your password manager.
4. In both projects, keep the **database password** safe. You need it for
   the connection strings. If you forget it: Project Settings, Database,
   Reset database password.

Check: both projects show "Healthy" in the dashboard.
Rollback: delete the project (Project Settings, General, Delete project).

### A2. Find the three things you need in each project

Open a project and click **Connect** (top bar).

1. **Session pooler string (port 5432). Used by scripts.**
   Connect, then "Session pooler". It looks like
   `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
   Replace `[YOUR-PASSWORD]` with the database password.
   - Why not the "Direct connection" (`db.<ref>.supabase.co:5432`)? On the
     free plan it works over IPv6 only. Most home networks have no IPv6, so
     it fails with a timeout or "host not found". The session pooler works
     over IPv4. If your network does have IPv6 you may use the direct one.
   - Why **never port 6543** for scripts? 6543 is the transaction pooler. It
     cannot hold a session open, and the import, verify, backup and restore
     scripts need that. They refuse a 6543 address on purpose.
2. **Transaction pooler string (port 6543). Used only by the app.**
   Connect, then "Transaction pooler". Same shape with `:6543`. This goes in
   Railway as `DATABASE_URL`.
3. **Project URL and service-role key. Used for Storage.**
   Project URL: Project Settings, Data API (or API), "Project URL"
   (`https://<ref>.supabase.co`). Service-role key: Project Settings, API
   Keys, the `service_role` key (click Reveal). Treat it like a root
   password. It can read and write everything.

Write all of these in a private note on your PC (not in the repo).

Check: you have, per project, 1 session string, 1 transaction string,
1 URL, 1 service-role key.

### A3. Local settings for the rehearsal

Create the file `.env.local` in the repo folder (it is git-ignored; if one
already exists, add these lines and keep your other keys). Use the
**scratch** project's values:

```
DATABASE_URL=<scratch transaction pooler string, port 6543>
DATABASE_DIRECT_URL=<scratch session pooler string, port 5432>
SUPABASE_URL=<scratch project URL>
SUPABASE_SERVICE_ROLE_KEY=<scratch service-role key>
RECREATED_PAGE_ARCHIVE_DAYS=14
```

Do **not** put `DATABASE_TEST_URL` here. It is only typed on one command
line in B1.

The scripts (`import:store`, `verify:import`, `backup:*`, `loadtest`) read
`.env.local` (then `.env`) themselves. Each prints one line first, for
example `env files loaded: .env.local (variables already set in this terminal
win)`: file names only, never values. A variable you `export` in the
terminal always wins over the file, and `--url` wins over
`DATABASE_DIRECT_URL`. That is how Phase C points the scripts at production
while this file keeps the scratch values.

Check (Git Bash): `git status --short` must not list `.env.local`.
If it does, stop and tell Claude.

### A4. Railway variables for the day (set them in Phase C, not now)

On the day you set these in Railway, Variables, using the **production**
project's values:

| Variable | Value |
|---|---|
| `DATABASE_URL` | production transaction pooler string (port 6543) |
| `DATABASE_DIRECT_URL` | production session pooler string (port 5432) |
| `SUPABASE_URL` | production project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | production service-role key |
| `RECREATED_PAGE_ARCHIVE_DAYS` | `14` (optional; 14 is the default) |

Do **not** set `DATABASE_TEST_URL` on Railway. Ever. The staging tests
create and drop schemas.

**Remove `HISTORY_IMPORT_SECRET`** from Railway at the cutover (C6) if it is
set. It enables `/api/admin/import-history`, whose default `replace` mode
would replace the Postgres runs with an old file's and wipe every run
created after the cutover.

`MAINTENANCE_MODE` is set and unset during the window (C3, C6, C7); it is not
a permanent variable.

Do not set them early: the current live app does not use them, but it is
cleaner to change everything in one window.

### A5. The Railway volume

Keep the volume mounted at `/app/data`. Reasons:
- Uploaded assets of recreated pages (images) still live on that volume.
  Removing it breaks those images.
- `store.json` stays on it, untouched, as the rollback copy.

Check: Railway, your service, Volumes: a volume at `/app/data` exists.
Do not delete or resize it.

**Deploys do not overlap while the volume is attached.** Railway stops the
old container before it starts the new one (a volume can only be mounted
once). That is what makes it safe that the new app, at startup, marks every
"running" job as failed: no old container is still running them. The flip
side: **a deploy that fails to start is downtime** until it is fixed or
rolled back, and every deploy (including a variable change) is a short
outage. Plan every deploy outside working hours.

### A6. How will you get `store.json` off the volume?

You need a copy of `/app/data/store.json` (about 142 MB) on your PC at
cutover, and one for the rehearsal. The app has no download button for it.
The file can only be read **from inside the running container**
(`railway ssh`). That is why the cutover keeps the old container running in
maintenance mode (A9, C3) while you copy it, and only then deploys the new
build.

- Rehearsal: use the local file `data/store.pre-postgres.json` (already in
  the repo folder, git-ignored; Task 9 used exactly this file). It may be
  older than production. For a realistic rehearsal that is fine.
- Cutover: the commands are in C4. **Practise them once in the rehearsal
  week** against the live service (reading the file is harmless; it may
  change between your hash and your copy while the app is live, which is
  fine for practice). If neither route in C4 works for you, stop and ask
  Claude before the day.

Railway CLI setup (once, PowerShell or Git Bash):
```sh
npm i -g @railway/cli
railway login
railway link        # pick the project, the environment and the AdRival service
railway ssh         # opens a shell in the running container; type exit to leave
```
**Not tested by Claude:** the exact `railway ssh` options and whether it
passes a command and its output through cleanly. Railway's CLI documents
`railway ssh [command]`; the C4 commands use `railway ssh -- sh -c '...'`.
If your CLI version rejects `--`, try the same without `--`.

Check: you hold a file of about the expected size on your PC, and its
SHA-256 matches the one printed inside the container.

### A7. Git safety

(Git Bash)
```sh
git tag --list "pre-postgres*"
git branch --show-current
```
Expected: `pre-postgres-migration-2026-10-23` listed; current branch
`postgres-migration`.

Rollback for the whole project: `git switch main`. `main` is untouched.

**Push both branches so Railway can see them (pre-day step, your decision).**
Railway deploys from GitHub, and neither branch is on origin yet. Before the
rehearsal week (and in any case before C6), in Git Bash:
```sh
git push origin postgres-migration
git push origin maintenance-on-main
```
This only uploads the branches so Railway can select them in Settings,
Source. It does not change `main` and does not deploy anything unless Railway
is pointed at that branch. Railway needs `maintenance-on-main` for A9 and
`postgres-migration` for C6. Both pushes are the owner's decision: Claude must
not push unless you ask it to. (A9 step 1 repeats the `maintenance-on-main`
push.)

### A8. Tell people

Choose the cutover window (evening or weekend). Tell users the app will be
offline for about 30 minutes (leave room for trouble: say 1 hour).

The maintenance switch has no bypass: you can only smoke-test after turning
maintenance off at C7. So announce the window as still closed until the smoke
test passes. If you would rather test while maintenance stays on, a bypass
cookie option exists as a follow-up (not implemented; ask Claude).

### A9. Deploy the maintenance switch on the old app (rehearsal week, off-hours)

The live app runs `main`, which has no maintenance switch. The branch
`maintenance-on-main` is `main` plus exactly one change: with
`MAINTENANCE_MODE=1`, every request except `/api/health` gets "503 down for
maintenance" (JSON `{"error":"maintenance"}` for `/api/...`, a short page
for the browser). It still reads and writes `store.json` exactly like
`main`. It exists only locally until you push it.

1. (Git Bash) Push the branch (it is not pushed yet):
   ```sh
   git log --oneline -3 maintenance-on-main
   git push origin maintenance-on-main
   ```
   Expect the top commits "test: run the maintenance middleware test in npm
   test" and "feat: MAINTENANCE_MODE=1 answers everything but /api/health
   with 503", on top of `main`'s newest commit.
2. Railway, your service, Settings, Source: set the deploy branch to
   `maintenance-on-main`, then Deploy. Wait for "Active". The app works
   exactly as before (the switch is off).
3. Test the toggle (each change is a redeploy, a minute or two offline):
   - Variables: add `MAINTENANCE_MODE` = `1`, deploy. Open the app: the
     "Down for maintenance" page. Open `https://<your app>/api/health`: it
     still answers (HTTP 200). In Git Bash,
     `curl -i https://<your app>/api/history` shows `503` and
     `Retry-After: 600`.
   - Variables: delete `MAINTENANCE_MODE`, deploy. The app works normally
     again.
   If the page does not appear with the variable set: Next.js reads the
   variable at run time in the middleware (verified only in unit tests, not
   on Railway). Send Claude the deploy log; do not rely on the switch until
   this works.
4. Practise the `store.json` copy (C4 steps 2-4) once, while the app is
   live.

Leave the service on `maintenance-on-main` until the cutover. It is the
build you roll back to as well.
Rollback: set the deploy branch back to `main` and Deploy.

---

## B. Rehearsal on the scratch project

Goal: run the real thing against real Supabase with no risk. Fill in the
table at the end of this section as you go. Everything here uses the
**scratch** project. Claude can read the output with you.

Set the scratch values in your terminal first (Git Bash). Type the real
strings in place of the `<...>` parts. They exist only in this terminal
window:

```sh
export SCRATCH_SESSION='<scratch session pooler string, port 5432>'
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come from `.env.local` (A3):
every script prints `env files loaded: .env.local ...` as its first line. If
it prints `env files loaded: none`, you are not in the repo folder or the
file is missing. Do not export production values in this terminal during
Phase B (a value set in the terminal wins over `.env.local`).

### B1. Concurrency tests (once)

These tests check that credits and run locks hold up under real parallel
connections. They create and drop their own temporary schemas in the
scratch database. They skip themselves if the variable is missing.

```sh
DATABASE_TEST_URL="$SCRATCH_SESSION" npx tsx --test --test-timeout=300000 tests/dataCreditsStaging.test.ts tests/dataRunsStaging.test.ts tests/backupStaging.test.ts
```
(Git Bash. Verified names: those three files exist in `tests/`.)

Expect: all tests pass, none "skipped". Note the total time. Each
staging test is bounded to 120 s by its own option, and every wait for a
blocked session to 15 s (message `waitForBlocked: expected ... within ...`).
`--test-timeout` is only a per-test default, not a whole-run limit; the run
as a whole should finish within a few minutes. If a test hangs, press Ctrl+C
and report which test it was.
If skipped: the variable did not reach the command. Retype it on the same line.
If a test fails: stop. Send Claude the test name and the message (it holds no
secrets). Do not go on to cutover. Rollback: nothing to undo; schemas are
dropped by the tests. If one is left behind (`t_...` schemas), they are
harmless on the scratch project.

### B2. Dry run of the import (changes nothing)

Use a **copy** of the real store. The import only reads the file.

```sh
npm run import:store -- --store data/store.pre-postgres.json --dry-run
```
Expect: a plan with counts; "records left out: 0 (0 lost, 0 collapsed
duplicates)"; at most one warning about a run that was running ("Interrupted
by cutover"). Rollback: none needed (no database is touched).
If "records left out" shows lost records: stop, send Claude the line.

### B3. Real import into the scratch database, with archiving

```sh
npm run import:store -- --store data/store.pre-postgres.json --url "$SCRATCH_SESSION" --archive-days 14
```
`--archive-days 14` moves recreated pages older than 14 days into Storage
right after the import. This is the first real use of Storage. The import
refuses to start (nothing read, nothing written) if `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY` are missing, or if `SUPABASE_URL` belongs to a
different Supabase project than the `--url` database.

Expect: counts matching the dry run (last time: 49 recreated pages, 511
competitors, 9277 ledger rows, 4265 provider calls, 3 users), then an archive
summary with `failed: 0`. **Write down how long it took.** In the test
database it took about 15 s. On Supabase it will be slower because of the
network. Over a few minutes is worth telling Claude.
Rollback: wipe the scratch database: Supabase SQL editor, run
`drop schema public cascade; create schema public;` then
`grant all on schema public to postgres, anon, authenticated, service_role;`.
Or just delete and recreate the scratch project.
Do not rerun the import over a filled database without `--allow-existing`
(it refuses on purpose).

### B4. Verify the import

```sh
npm run verify:import -- --store data/store.pre-postgres.json --url "$SCRATCH_SESSION"
```
Expect: it prints ok and **0 mismatches** (last time: 4.3 s in the test
database). Any mismatch is a stop: send Claude the whole output.

Note: if you used `--archive-days`, archived pages are checked from
Storage. "archived pages cannot be checked: Storage not configured" means
the Storage variables did not reach the script (check the `env files
loaded` line). Other complaints about archived pages: see "What to look
for" (Storage) below.

### B5. Run the app locally against the scratch database

This checks the real thing end to end: login, history, old pages, Storage.

**Only ever against the scratch project.** Never run `npm run dev` (or any
local copy of the app) with `DATABASE_URL` pointing at the production
database, now or later: at startup it marks every running job as failed
and starts the archive and nightly-backup schedulers, from your PC.

1. (Git Bash) `npm run dev`
2. Open http://localhost:3000. Log in with your own real admin login (users
   came from the import).
3. Check, one by one:
   - History list loads.
   - Open a **recently recreated** page (younger than 14 days): it opens.
   - Open an **older** one (it was archived in B3): it opens, same as before.
   - Log in as a normal user and as a client-org admin (use another browser
     window): both work.
   - http://localhost:3000/api/health shows `"db":"up"`.
4. Archive-now check (uploads and reads back from Storage). In the browser,
   while logged in as platform admin, press F12, open Console, paste:
   ```js
   fetch('/api/admin/archive-pages',{method:'POST',headers:{'content-type':'application/json'},body:'{"olderThanDays":0}'}).then(r=>r.json()).then(console.log)
   ```
   Expect `{archived: N, failed: 0}`. Then in the Supabase dashboard,
   Storage, bucket `recreated-pages-archive`: objects are listed, bucket is
   **private**. Open an archived page again in the app: it still opens.
   (This endpoint exists: `src/app/api/admin/archive-pages/route.ts`. The
   console snippet was not tested against a running server; if it returns
   403 or 400, ask Claude for the right call.)
5. **Do not start a real search in the rehearsal.** It would spend real
   provider credits and write to the scratch database.
6. Stop the dev server with Ctrl+C.

Rollback: stop the server. Nothing else changed outside scratch.

### B6. Backup, pull, restore into a second empty database

1. The restore needs an **empty** database. The free plan allows only two
   projects (production and scratch), so the route is: take the backup and
   pull it first (steps 2-3), then **wipe the scratch database** (the
   commands in the B3 rollback) and restore into it (step 4). If you have a
   paid plan, restore into a third empty project instead.
2. Backup (Git Bash):
   ```sh
   npm run backup:run -- --url "$SCRATCH_SESSION"
   ```
   Expect a line like `{ date, path, tables, rows, bytes }`. Write down the
   `date` (format `2026-10-26T0200Z`) and the time it took. Check in the
   dashboard: Storage, bucket `db-backups`, a folder with that date
   containing `manifest.json`.
   (The script reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
   `.env.local` by itself; its first line says `env files loaded:
   .env.local ...`. If it says `none`, or Storage is reported missing, run it
   from the repo folder or export the two variables in the terminal.)
3. Pull the backup to your PC:
   ```sh
   npm run backup:pull -- --out backups
   ```
   Expect a folder `backups/<date>/` with `.ndjson.gz` files and
   `manifest.json`. (The `backups` folder is not for git; do not commit it.)
4. Wipe the scratch database (commands in B3 rollback), then restore:
   ```sh
   npm run backup:restore -- --date <date from step 2> --into-url "$SCRATCH_SESSION"
   ```
   Also test the offline route:
   ```sh
   npm run backup:restore -- --date <date> --from backups --into-url "$SCRATCH_SESSION"
   ```
   (wipe again between the two restores.)
   Expect: sha-256 checks pass, then every table's rows land; it exits with
   no error. A message "fewer rows than the manifest" is a stop.
5. Run `verify:import` (B4) against the restored database. Expect ok.

Rollback: wipe the scratch database again. Nothing here touches production.

### B7. What to look for, and what to do if it fails

These are the points the code could not prove without real Supabase.

| What was never checked | What to look for | If it fails |
|---|---|---|
| Backup reads inside `BEGIN ... READ ONLY` plus an advisory lock through the **transaction pooler** (the app's nightly backup uses `DATABASE_URL`) | `POST /api/admin/backup` (or the nightly run) fails with a message about "transaction", "prepared", "advisory" or "read only" | Use `npm run backup:run -- --url "<session string>"` instead (this works over the session pooler). Tell Claude: the in-app backup will be moved to `DATABASE_DIRECT_URL`. Until then, run `backup:run` from your PC daily/weekly. |
| `SET LOCAL idle_in_transaction_session_timeout` | A backup dies mid-way with "terminating connection due to idle-in-transaction timeout" or the setting is rejected | Same fix as above: use the session string. Send the exact message to Claude. |
| 30 s client timeout on each backup read (one batch holds up to 2 big page rows) | Backup error "Query read timeout" on the `recreated_pages` table | Run the backup from your PC with `backup:run` (the script has a longer limit). Tell Claude to raise the per-read limit. |
| Storage REST calls (upload, download, list, delete, bucket create) | Archive result shows `failed` > 0, or logs like `storage ... 401/403` (wrong key), `... 413` (file over 50 MB), `... 404` | 401/403: the service-role key or URL is wrong or from another project; re-copy both. 413: a single page is over the size limit; send Claude the id. 404/400 "Bucket not found": the app creates buckets itself; make sure the key is the `service_role` one, then create `recreated-pages-archive` and `db-backups` by hand in the dashboard as **private** buckets and retry. Missing object on read: the app treats both 404 and a 400 with "not_found" as "not found"; if you see a different status, send Claude the status and body. |
| `SET LOCAL statement_timeout` through the session pooler (the scripts no longer send it as a connection parameter) | Import or migration stops with "canceling statement due to statement timeout" (the biggest page is a 31.7 MB write), or an error naming `statement_timeout` | Retry once. If it repeats, tell Claude; the scripts allow 10 minutes per statement. |
| Free-plan upload limit 50 MB | Backup error "row ... is X MB compressed, over the Y MB part limit" | Send Claude the competitor id named; the page must be shrunk or archived first. |
| IPv6 / network | `ENOTFOUND` or `ETIMEDOUT` to `db.<ref>.supabase.co` | You used the direct host. Use the session pooler string (A2). |
| Password characters | "password authentication failed" | The password has special characters (`@`, `/`, `#`, `:`). Reset the database password to letters and numbers only. |
| Sequence setting on restore (`pg_get_serial_sequence`/`setval`) | After a restore, a new ledger or audit write fails with "duplicate key" | Send Claude the message; do not use that restored database. |

### B8. Timing notes to record

Fill in during the rehearsal. The plan expects the offline window
(Phase C, steps 3-7, including the store.json copy) to be under 40 minutes.

| Step | Expected result | Actual | OK? |
|---|---|---|---|
| B1 staging tests | all pass, none skipped; note time | | |
| B2 dry run | counts shown, 0 lost, 0 collapsed | | |
| B3 import (time: ___ ) | counts match dry run; archive `failed: 0` | | |
| B4 verify (time: ___ ) | ok, 0 mismatches | | |
| B5 history, recent page, archived page | all open | | |
| B5 normal user and client-org admin login | both OK | | |
| B5 `/api/health` | `"db":"up"` | | |
| B5 archive-now with `olderThanDays: 0` | `failed: 0`; objects in bucket; bucket private | | |
| B6 `backup:run` (time: ___ ) | prints date/path/rows; manifest in `db-backups` | | |
| B6 `backup:pull` | folder `backups/<date>` with manifest | | |
| B6 restore from Storage into wiped scratch | no error, all rows land | | |
| B6 restore with `--from backups` | same | | |
| B6 verify after restore | ok, 0 mismatches | | |
| Scratch DB size in dashboard | about 103 MB before archiving; smaller after | | |
| Storage size in dashboard | archive about 70 MB | | |
| Total time of B3 + B4 | under 15 minutes | | |

Go/no-go for Phase C: every row OK, or each failure fixed and re-run.

---

## C. Cutover day

Total offline time expected: 20-40 minutes. Do it outside working hours.
Have a second person or a phone nearby. Keep the Phase B table open.

Before you start:
- you have the production session string and transaction string, project
  URL and service-role key (A2);
- the service runs `maintenance-on-main` and you tested the switch (A9);
- you practised the `store.json` copy (A6, C4);
- the folder `C:\Users\Rithin\cutover-2026` exists and is empty.

The order matters: the old container must **still be running** while you
copy `store.json` (C4), because the file can only be read from inside it.
Maintenance mode (C3) keeps users out so the file stops changing.

### C1. Announce the window

Tell users (message or banner) that the app goes offline at the chosen time.
Check: you sent it. Rollback: send "postponed".

### C2. Stop new runs and drain

1. In the app, as platform admin, check the running searches and recreate
   jobs (history shows "running"). Let them finish, or stop them with the
   Stop button.
2. Wait until nothing says "running".

Check: no running jobs. Any job still running at C3 is cut off by the
redeploy and imported as "failed (Interrupted by cutover)". That is safe but
the user has to rerun it.
Rollback: nothing changed yet.

### C3. Maintenance mode on the old app

Railway, your service (still on `maintenance-on-main`), Variables: add
`MAINTENANCE_MODE` = `1`, then deploy the change. With the volume attached
the old container stops and a new one of the **same old build** starts (a
minute or two).

Check (in the browser and Git Bash):
- the app shows "Down for maintenance";
- `curl -i https://<your app>/api/health` answers 200;
- `curl -i https://<your app>/api/history` answers `503` with
  `Retry-After: 600`.

From now on no request can change `store.json`.
Rollback: delete `MAINTENANCE_MODE`, deploy. The app is back as before.

### C4. Copy `store.json` from the running container

All in **Git Bash** (PowerShell's `>` would corrupt the download), from the
repo folder, after `railway link` (A6). **Not tested by Claude:** the
`railway ssh` command syntax and its output passing; you practised it in
the rehearsal week (A9 step 4).

1. Fingerprint inside the container, twice, a minute apart (the second must
   equal the first: the file has stopped changing):
   ```sh
   railway ssh -- sh -c 'sha256sum /app/data/store.json; stat -c %s /app/data/store.json'
   ```
   Write down the hash (64 hex characters) and the size in bytes. If the two
   readings differ, something still writes; wait two minutes and repeat. If
   it keeps changing, stop and ask Claude.
2. Download it, gzip-compressed and base64-encoded between two markers, so
   the text stream cannot damage it:
   ```sh
   cd /c/Users/Rithin/cutover-2026
   railway ssh -- sh -c 'echo ==BEGIN==; gzip -c /app/data/store.json | base64 -w0; echo; echo ==END==' > store.b64.txt
   sed -n '/==BEGIN==/,/==END==/p' store.b64.txt | sed '1d;$d' | tr -d '\r\n ' | base64 -d | gunzip > store.json
   sha256sum store.json; stat -c %s store.json
   ```
   Expect: the same hash and size as step 1.
3. Check again in PowerShell (it must match the container's hash; letter case
   does not matter):
   ```powershell
   Get-FileHash "C:\Users\Rithin\cutover-2026\store.json" -Algorithm SHA256
   (Get-Item "C:\Users\Rithin\cutover-2026\store.json").Length
   ```
4. Keep **two copies**: copy `store.json` to a second place (another disk or
   a cloud folder) and check the copy's `Get-FileHash` too.
5. Tag the OLD code (Git Bash). The tag goes on `maintenance-on-main`, the
   version that still reads `store.json`, not on the current HEAD (which is
   the new code):
   ```sh
   git tag pre-postgres-cutover maintenance-on-main
   git tag --list "pre-postgres*"
   ```
   (If `pre-postgres-cutover` already exists, stop and ask Claude. It
   means this was run before.)

**Fallback A, in parts** (if the single download breaks off or the hash
differs). Split inside the container, download each part, join:
```sh
railway ssh -- sh -c 'gzip -c /app/data/store.json > /tmp/s.gz && cd /tmp && split -b 20m -d s.gz s.part. && ls -l /tmp/s.part.* && sha256sum /tmp/s.gz'
# for each part listed (00, 01, 02, ...):
railway ssh -- sh -c 'echo ==BEGIN==; base64 -w0 /tmp/s.part.00; echo; echo ==END==' > part00.txt
sed -n '/==BEGIN==/,/==END==/p' part00.txt | sed '1d;$d' | tr -d '\r\n ' | base64 -d > s.part.00
# after all parts:
cat s.part.* > s.gz && sha256sum s.gz    # must equal the /tmp/s.gz hash
gunzip -c s.gz > store.json && sha256sum store.json
```
`/tmp` lives only as long as this container; do not redeploy between these
commands.

**Fallback B, through Supabase Storage** (if `railway ssh` cannot run a
command and only the interactive shell works). In the Supabase dashboard of
the **production** project, Storage, create a **private** bucket `cutover`.
Then `railway ssh` (interactive) and type, with your real values:
```sh
export U='<production project URL>' K='<production service-role key>'
gzip -c /app/data/store.json > /tmp/store.json.gz && ls -l /tmp/store.json.gz && sha256sum /app/data/store.json
node -e 'const fs=require("fs");fetch(process.env.U+"/storage/v1/object/cutover/store.json.gz",{method:"POST",headers:{Authorization:"Bearer "+process.env.K,"Content-Type":"application/gzip","x-upsert":"true"},body:fs.readFileSync("/tmp/store.json.gz")}).then(async r=>console.log(r.status,await r.text()))'
exit
```
Expect `200`. The free plan refuses files over 50 MB: if the `.gz` is
bigger, use Fallback A. Download `store.json.gz` from the dashboard into
`C:\Users\Rithin\cutover-2026`, then (Git Bash)
`gunzip -c store.json.gz > store.json && sha256sum store.json` and compare.
Delete the bucket's file after the cutover is done. (Also untested.)

`railway run` is **not** a fallback: it runs a command on your PC with the
Railway variables, not inside the container, so it cannot see the volume.

Check: you hold two copies whose SHA-256 equals the container's; the
original on the volume is untouched.
Rollback: nothing changed in the data. If no route works, delete
`MAINTENANCE_MODE` (C3 rollback) and postpone.

### C5. Import into production Supabase (app still in maintenance)

Use the **production session pooler string (port 5432)**. No
`--allow-existing`: the command refuses a database that already has users,
which protects you from importing twice.

`.env.local` still holds the **scratch** values. Export the production
values in this terminal first; the terminal wins over `.env.local`, and the
import refuses `--archive-days` if Storage belongs to another project than
the database.

Note: production passwords and keys typed into Git Bash may be saved in the
shell history. Run `export HISTCONTROL=ignorespace` first, then type a
leading space before each `export` line below (a line starting with a space
is not saved). Or enter a value with `read -rs VAR` (nothing is echoed or
saved), then `export VAR`. **Close this terminal when C5 is finished: it
holds production values; never run `npm run dev` in it.**

(Git Bash)
```sh
export PROD_SESSION='<production session pooler string, port 5432>'
export SUPABASE_URL='<production project URL>'
export SUPABASE_SERVICE_ROLE_KEY='<production service-role key>'
export DATABASE_DIRECT_URL="$PROD_SESSION"
npm run import:store -- --store "/c/Users/Rithin/cutover-2026/store.json" --url "$PROD_SESSION" --archive-days 14
npm run verify:import -- --store "/c/Users/Rithin/cutover-2026/store.json" --url "$PROD_SESSION"
```
Each prints `env files loaded: .env.local (variables already set in this
terminal win)` first; the exported values are the ones used.
Check: verify prints ok with **0 mismatches**, and the counts match the
numbers you saw in the rehearsal (scaled to today's data).
**If there is any mismatch, any "lost", or any error: STOP.** Do not
deploy. Rollback: delete `MAINTENANCE_MODE` on Railway and deploy (the old
build on `maintenance-on-main`, reading `store.json`, which was never
changed). Send Claude the full output.

Then take a first backup (same terminal; also tests the production setup):
```sh
npm run backup:run -- --url "$PROD_SESSION"
```
Check: it prints `{ date, path, tables, rows, bytes }`; Storage, `db-backups`
has a folder with `manifest.json`.

Close this terminal now (see the note above). If you need it for C7/C8
commands, open a new one and re-export `PROD_SESSION` only; a new terminal
otherwise falls back to the scratch values of `.env.local`.

### C6. Set Railway variables and deploy the new build (maintenance still on)

1. Railway, Variables: add the five variables from A4 (production values).
   Keep `MAINTENANCE_MODE` = `1`. **Delete `HISTORY_IMPORT_SECRET`** if it
   is there. (Changing variables on the old service may trigger an extra
   automatic restart of the old build; that is harmless.)
2. Deploy the branch **directly first** (safest, because `main` stays as it
   was): Railway, Settings, Source, set the deploy branch to
   `postgres-migration` (it must already be pushed: see the push step in A7),
   then Deploy. (If the branch setting is not where you
   expect, ask Claude to guide you.)
   Merging to `main` comes only after the smoke test in C7.
3. Watch the deploy logs. The old container stops first (volume), then the
   new one starts: migrations run, then the health check calls
   `/api/health` (it answers in maintenance mode too).

Check: the deploy goes "Active"; `https://<your app>/api/health` shows
`"ok":true,"db":"up"`; the app itself still shows "Down for maintenance".
Logs have no "DATABASE_URL" or "Storage" errors.
A deploy that stays "Unhealthy" for 5 minutes (the health-check limit) has
failed, and because deploys do not overlap, the app is down: roll back.
Rollback: see "Rollback procedure" below.

### C7. Open for yourself, smoke test (do all of it)

Maintenance mode blocks every page, also for you (there is no bypass). So:
delete `MAINTENANCE_MODE` and deploy, **but do not announce yet**. Users
were told the window is still open; the smoke test runs now.

- [ ] Log in as platform admin.
- [ ] Log in as a normal user.
- [ ] Log in as a client-org admin.
- [ ] History list loads (fast).
- [ ] Open a recently recreated page. It shows.
- [ ] Open an older (archived) recreated page. It shows.
- [ ] Start a small search and press Stop. It stops, no error.
- [ ] Credits: run something small that reserves and settles credits; check
      the balance goes down by the right amount and the ledger shows it.
- [ ] Admin overview loads.
- [ ] Admin: Backups: `GET /api/admin/backup` lists the C5 backup (or run
      `npm run backup:run -- --url "$PROD_SESSION"` once more, in the C5
      terminal).
- [ ] Reopen: tell users the app is back.

If any item fails: decide with Claude whether it is a quick fix or a
rollback. To keep users out while you decide, set `MAINTENANCE_MODE` = `1`
again and deploy. Do not leave a half-working app up.
Rollback: below.

### C8. Load test (off-hours, 6 users)

You need 6 test logins (or fewer real ones; the test only reads). Put them
in a variable (Git Bash; passwords are typed here, never committed):

```sh
export LOADTEST_USERS='[{"username":"lt1","password":"..."},{"username":"lt2","password":"..."}]'
npm run loadtest -- --base https://<your app URL> --users 6 --duration 60
```
(`--job <run id>` is optional and adds a run-status read. `LOADTEST_USERS`
may also live in `.env.local`; the script reads it.)
Expect: p50/p95/max per endpoint; exit status 0; total p95 under 2000 ms.
Write down the p95. A non-zero exit or p95 over 2000 ms is not an emergency.
It is a Phase D follow-up: send Claude the output.

### C9. Go / no-go gate

GO if: verify ok (C5), health up (C6), every smoke-test box ticked (C7).
Then merge to `main` (ask Claude to do it: `git switch main`, merge
`postgres-migration`, push) and set Railway back to deploy from `main`.
`maintenance-on-main` is then no longer needed (keep the branch until the
14 days of D1 are over).
NO-GO: roll back.

### Rollback procedure

When: any hard failure in C5-C7, or a serious problem later.

1. Railway, Variables: delete `DATABASE_URL`, `DATABASE_DIRECT_URL`,
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `MAINTENANCE_MODE`
   (unless you want users kept out a little longer). (The old build ignores
   the database variables, but remove them so nothing mixes.)
2. Settings, Source: set the deploy branch back to `maintenance-on-main`
   (the old app plus the switch; `main` works too) and Deploy. If you need
   the exact old code: the git tag `pre-postgres-cutover` is the same code as
   `maintenance-on-main` (the primary rollback: deploy that branch with
   `MAINTENANCE_MODE` unset); `pre-postgres-migration-2026-10-23` is the
   earlier snapshot.
3. The old code reads `/app/data/store.json`, which was never changed.
   Check: log in; the history is the same as before C3.

**Important: data created after the cutover is NOT in the old store.**
Anything users did after go-live (new runs, credits spent, new users) lives
only in Postgres. Rolling back loses it.

Rule:
- Rollback within the first hours (little new data): accept losing that
  data, or first export the important runs with the admin export, then roll back.
- Later than that: do **not** roll back. Fix forward with Claude. The
  Postgres data is now the source of truth.

---

## D. After go-live (first week and beyond)

1. **Keep `store.json` and your copy for at least 14 days.** Do not delete
   them. The same for the tags `pre-postgres-cutover` and
   `pre-postgres-migration-2026-10-23`. Keep the volume.
2. **Daily for the first week**: open the admin Alerts panel. An alert
   "Database backup failed" means both the nightly backup (02:00 server
   time) and its retry failed. Also check `GET /api/admin/backup`:
   `lastSuccess` should be from the last night.
3. **Weekly**: copy the backup to your PC:
   ```sh
   npm run backup:pull -- --out backups
   ```
   Also download the bucket `recreated-pages-archive` from the Supabase
   dashboard (Storage). The backup does **not** include those files.
4. **Watch sizes** in the Supabase dashboard once a week: Database (limit
   500 MB; it measured 103 MB before archiving) and Storage (limit 1 GB; the
   archive is about 70 MB, plus 3 backups). Growth is about 20 MB a month.
5. **When to move to the paid plan**: when the database is above about 350
   MB or Storage above about 700 MB; or when the project pauses (a week with
   no traffic; unpause it in the dashboard, and the app's own `select 1`
   every 12 hours normally prevents it); or when you want automatic
   point-in-time recovery. It is only billing: upgrade the organization in
   the dashboard. Nothing in the app changes.
6. **Run `npm run loadtest` again** if users report slowness.

### What is NOT done (known limits)

- **One app instance only.** Some run state lives in the server's memory.
  Do not scale to 2 or more instances.
- **Deploys while runs are in progress**: with the volume attached, Railway
  stops the old container before the new one starts (no overlap). Runs in
  flight are cut off and the new container's startup marks them failed.
  Deploy only when nothing is running. No overlap also means **a failed
  deploy is downtime** until it is fixed or rolled back. Without the volume
  (or with 2+ replicas) deploys would overlap and the new container would
  mark the old one's live runs failed.
- **Never run the app locally against the production database** (`npm run
  dev` with the production `DATABASE_URL`): startup marks running jobs
  failed and starts the archive and backup schedulers on your PC.
- **`HISTORY_IMPORT_SECRET` stays off Railway.** Setting it re-enables
  `/api/admin/import-history`, whose default `replace` mode would wipe every
  run created since the cutover. If you ever need it, use `--mode merge` and
  remove the secret right after.
- **Migrations must stay additive** (add only; no renames or drops in the
  same deploy as the code change).
- **No off-site copy of the archive bucket** by script. Download it by hand
  (D3). Pull of the archive via script is a follow-up.
- **A failed restore leaves a partial database.** Restore into an empty or
  fresh project.
- **Uploaded recreate assets live on the Railway volume**, not in Postgres.
  Lose the volume, lose those images.
- **The browser end-to-end tests** (`npm run test:e2e`) need a shared
  database and are not part of this cutover.
- **Performance follow-ups**: finding existing recreations for a URL scans
  many competitors; the admin overview reads all provider calls once, plus
  two 25-row reads. Both are fine at today's size.
- **Smaller deferred items** are in the migration log
  (`.superpowers/sdd/2026-10-23-postgres-migration/progress.md`, lines
  marked HARDENING and "minors deferred").

---

## If something goes wrong

| Symptom | What to do |
|---|---|
| Script says "this URL is the transaction pooler" | You used port 6543. Use the session pooler string (port 5432). |
| `ENOTFOUND` / `ETIMEDOUT` to `db.<ref>.supabase.co` | No IPv6. Use the session pooler string. |
| "password authentication failed" | Wrong password, or special characters. Reset the DB password (letters and digits). |
| Import says "already has N user row(s)" | The database is not empty (maybe an earlier import). On scratch: wipe it. On production: stop and ask Claude. Do not add `--allow-existing` without Claude. |
| verify prints any mismatch or "lost" | STOP. Do not deploy. Roll back (delete `MAINTENANCE_MODE`, deploy the old build). Send Claude the output. |
| verify prints "archived pages cannot be checked: Storage not configured" | The Storage variables did not reach the script. Export `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` of the database's project in the terminal (or check `.env.local`), then rerun verify. |
| Import says "--archive-days needs Storage" or "belongs to a different Supabase project" | Nothing was written. Export the Storage values of the same project as `--url` in this terminal and rerun. |
| The app shows "Down for maintenance" when it should not | `MAINTENANCE_MODE` is still set on Railway. Delete it and deploy. |
| A staging test fails with `waitForBlocked: expected ...` or a timeout | The race did not form within the time limit. Send Claude the test name and message; do not go on to cutover. |
| Deploy stays Unhealthy | Open the deploy logs. Wrong `DATABASE_URL` is the usual cause. Check it is the 6543 string for the right project. If not solved in 10 minutes: rollback. |
| `/api/health` shows `"db":"down"` | Check the Supabase project is not paused (dashboard). Check `DATABASE_URL`. |
| A user cannot log in after cutover | Check the user exists in the verify output counts. Platform admin can reset the password. |
| Archived page shows "unavailable" | Storage variables wrong, or the file is missing from `recreated-pages-archive`. Check `SUPABASE_URL` and the key belong to the same project. |
| Backup alert "Database backup failed" | Run `npm run backup:run -- --url "<session string>"` from your PC to see the error. Send it to Claude. |
| Supabase project paused | Dashboard, Restore project. The app reconnects by itself. |
| Database near 500 MB | Run archive-now (B5 step 4 with `olderThanDays` 14), or upgrade the plan. |
| Runs show "failed (Interrupted)" after a deploy | Expected when a deploy happens during a run. Rerun them. |
| Need to restore from backup | Follow `docs/POSTGRES_OPERATIONS.md`, "Restore from db-backups". |

---

## Which commands were checked

Verified by reading the files (not by running them): scripts in
`package.json` `import:store`, `verify:import`, `backup:run`,
`backup:pull`, `backup:restore`, `loadtest`; flags `--store`, `--url`,
`--dry-run`, `--archive-days`, `--allow-existing` (`scripts/storeScriptArgs.ts`);
`--url`, `--keep`, `--out`, `--date`, `--from`, `--into-url`,
`--allow-existing` (`scripts/backup-db.ts`); `--base`, `--users`,
`--duration`, `--job`, `--p95-ms`, `--allow-401` (`scripts/load-test.ts`);
staging test files and `DATABASE_TEST_URL` (`tests/helpers/testDb.ts`);
`/api/health`, `/api/admin/archive-pages`, `/api/admin/backup`.
Run locally (unit tests and a smoke run): the scripts' `.env.local`/`.env`
loading and its first line (`env files loaded: ...`), the `--archive-days`
refusal without Storage, `MAINTENANCE_MODE` in the middleware (503 JSON
with `Retry-After: 600`, HTML page, `/api/health` passes), on both
`postgres-migration` and `maintenance-on-main`; `--test-timeout` is a
standard Node test-runner flag.
Not tested: anything against real Supabase or Railway; the Railway
dashboard wording; `railway ssh` and every store.json download route (C4,
both fallbacks); `MAINTENANCE_MODE` read at run time on Railway (A9 step 3
tests it); the console `fetch` call.
