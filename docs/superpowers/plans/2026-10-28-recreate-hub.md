# Recreate Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Up to 3 landing-page recreations per user run at once, with a server-side queue, a Find / Recreate / History navigation, a Recreate tab with live progress and every recreated version, and one "Add to Recreate" button everywhere.

**Architecture:** Each recreation becomes its own competitor record (a "version", `recreateOnly.variantOf` set), so the Manus pipeline, billing and access code, all keyed by competitor id, run unchanged. A new `recreate_jobs` table holds the queue; a server-side dispatcher starts queued jobs when a slot frees. Recreate builds get their own concurrency count inside credit reservations. The UI lifts job polling into `page.tsx` so progress survives tab switches.

**Tech Stack:** Next.js (app router), TypeScript, Postgres (pglite in tests), `tsx --test` with `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-28-recreate-hub-design.md`

## Global Constraints

- Recreate concurrency: 3 per user, separate from `maxConcurrentRunsPerUser`. Searches never block recreations and vice versa.
- Queue advances server-side with no browser open; a 4th request shows "Added to queue".
- Add-time popup is pre-filled with defaults; one click confirms; all details are stored on the job so queued jobs never wait for input.
- Every version of the same source page is kept; archived 14 days after finishing (read-time filter, never deleted, applies to old pages too).
- Credits are reserved when a job starts, not when queued. A job that cannot be paid for fails with a clear message on the Recreate tab.
- Missing days running / active ads render as "—".
- Nothing starts a paid build without an explicit click on "Add to Recreate".
- Do not change Manus prompts or outputs. No full `next build` in checks; verify with `npx tsc --noEmit` and the targeted test files. Prod build type-checks tests, so `tsc` must pass before any push.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Add every new test file to the `test` script in `package.json`.

## Review Focus

- Same source page and identical details added twice by a double click: second request is refused as "already in progress", not duplicated. (Task 5)
- Server restarts with jobs queued and running: both continue and the queue still drains. (Task 4)
- A queued job reaches the front but the user is suspended or out of credits: it fails visibly and the next job still starts. (Task 4)
- A viewer-role member tries to add a page: refused. (Task 5)
- Stopping or removing a job: stop frees the slot and starts the next one; removing a queued job leaves no version behind. (Task 4)

---

### Task 1: Separate concurrency scope for recreate builds

**Files:**
- Create: `src/lib/accounting/scope.ts`
- Modify: `src/lib/data/accountingService.ts:461-488,1225-1235` (reserveCredits, countOpenReservationsIn), `src/lib/accounting/run.ts:60-80,117-153` (precheck and runBillable), `src/lib/types.ts` (AppSettings), `src/lib/data/legacyStore.ts:26`, `src/app/api/admin/settings/route.ts:60-101`, `src/app/admin/AdminSettings.tsx`
- Test: `tests/recreateScope.test.ts`

**Interfaces:**
- Produces: `RECREATE_BUILD_OPERATION = "recreate.generate_page"`, `type ConcurrencyScope = "recreate" | "other"`, `scopeOf(operation: string): ConcurrencyScope`; `reserveCredits({..., scope?: ConcurrencyScope})` counts only open reservations in that scope; `countOpenReservations(userId: string, scope?: ConcurrencyScope): Promise<number>`; `AppSettings.maxConcurrentRecreationsPerUser: number` (default 3).

- [ ] **Step 1: Create branch** `git switch -c recreate-hub`.
- [ ] **Step 2: Write the failing tests** in `tests/recreateScope.test.ts` (pglite setup as in `tests/accounting.test.ts`): `three recreate holds do not block a search`, `a fourth recreate hold is refused with too_many_concurrent_runs and limit 3`, `three search-type holds do not block a recreate`, `edit_page counts as other (shared limit)`.
- [ ] **Step 3: Run** `npx tsx --test tests/recreateScope.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** `scope.ts` and the scope filter in `countOpenReservationsIn` (match on the reservation's stored operation; check whether it is a column or inside `data`). `runBillable` and the precheck derive scope from `options.operation` and pick the limit: recreate uses `settings.maxConcurrentRecreationsPerUser`, other keeps `user.maxConcurrentRuns ?? maxConcurrentRunsPerUser`.
- [ ] **Step 5: Add the setting** to types, default, admin route validation (same rules as `maxConcurrentRunsPerUser`) and one field in `AdminSettings.tsx`.
- [ ] **Step 6: Run** the new test plus `tests/accounting.test.ts`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(accounting): separate concurrency limit for recreate builds`.

### Task 2: Recreation versions (one record per recreation)

**Files:**
- Modify: `src/lib/types.ts:385-390` (add `variantOf?: string | null` to `recreateOnly`), `src/lib/pipeline/landingRecreateBridge.ts` (add function; skip variants in `landingPageRecordsByKey`), `src/lib/data/competitors.ts` (listing, below)
- Test: `tests/recreateVersions.test.ts`

**Interfaces:**
- Produces: `createRecreationVersion(source: CompetitorRecord): Promise<CompetitorRecord>`: saves a clone with id `rv-<16 hex>`, same `runId`, copied `pageAnalysis`, `recreatedPage: null`, `recreateOnly: { sourceUrl, matchKey, fromCompetitorId, variantOf: source.id }`. `listRecreationsForUser(userId: string, spaceId: string | null): Promise<CompetitorRecord[]>` in `competitors.ts`: every record owned by the user with a `recreatedPage` or a non-queued job, scoped to the space by joining the run's job.

- [ ] **Step 1: Write failing tests:** `creating two versions of one page keeps both`, `versions do not replace the source in landingPageRecordsByKey`, `versions are excluded from getCompetitorsByRun`, `listRecreationsForUser scopes to the space`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateVersions.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the type change, `createRecreationVersion` (source must have `pageAnalysis.status === "completed"`, else throw), the `variantOf` skip, and `listRecreationsForUser` (also returns legacy source records that already hold a `recreatedPage`, so old pages appear).
- [ ] **Step 4: Run** the new test plus `tests/landingRecreate.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(recreate): one record per recreation version`.

### Task 3: Queue table and repository

**Files:**
- Create: `db/migrations/004_recreate_jobs.sql`, `src/lib/data/recreateJobs.ts`
- Test: `tests/recreateJobs.test.ts`

**Interfaces:**
- Produces:
  - `type RecreateJobStatus = "queued" | "running" | "finished" | "failed" | "stopped"`
  - `interface RecreateJobOptions { businessUrl: string; styleDirection: StyleDirection | null; userFeedback: string | null; targetIcp: { icpId: string; stage: AwarenessStage } | null }`
  - `interface RecreateJob { id; ownerUserId; competitorId; runId; spaceId: string | null; status; options: RecreateJobOptions; error: string | null; createdAt; startedAt: string | null; finishedAt: string | null }`
  - `insertJob(input: Omit<RecreateJob, "id"|"status"|"error"|"createdAt"|"startedAt"|"finishedAt">): Promise<RecreateJob>`
  - `listJobs(ownerUserId: string, spaceId: string | null): Promise<RecreateJob[]>`
  - `claimNextQueued(ownerUserId: string, maxRunning: number): Promise<RecreateJob | null>`: atomic, moves the oldest queued job to running only while running count is below `maxRunning`.
  - `finishJob(id: string, status: "finished" | "failed" | "stopped", error?: string | null): Promise<void>`
  - `removeQueued(id: string, ownerUserId: string): Promise<boolean>`
  - `usersWithQueuedJobs(): Promise<string[]>`, `listRunning(): Promise<RecreateJob[]>`

- [ ] **Step 1: Write failing tests:** `claimNextQueued returns oldest first`, `claimNextQueued returns null at the running limit`, `two simultaneous claims never exceed the limit`, `removeQueued only removes the owner's queued job`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateJobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write migration** (`recreate_jobs` with the fields above, index on `(owner_user_id, status, created_at)`) and implement the repository; use the same advisory-lock or transaction pattern as `reserveCredits` for the atomic claim. Confirm `migrate.ts` picks up the new file.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(recreate): queue table and repository`.

### Task 4: Dispatcher (server-side queue)

**Files:**
- Create: `src/lib/pipeline/recreateQueue.ts`
- Modify: `src/lib/data/startup.ts` (call `sweepRecreateQueue()` in `startSchedulers`)
- Test: `tests/recreateQueue.test.ts` (fake Manus as in `tests/manusRunAsync.test.ts`)

**Interfaces:**
- Consumes: Task 1 `RECREATE_BUILD_OPERATION`, `runBillable`; Task 3 repository; `runManusRecreation`, `stopManusRecreation`, `resumeManusRecreation` from `src/lib/pipeline/manus/run.ts`.
- Produces:
  - `dispatchRecreateQueue(ownerUserId: string): Promise<void>`: claims jobs up to `maxConcurrentRecreationsPerUser` and runs each in the background via `runBillable({ operation: RECREATE_BUILD_OPERATION, projectKind: "search", projectId: runId, runId }, () => runManusRecreation(competitorId, options))`. When a job settles it records `finished`, `failed` (page failed or credit/account error, message kept) or `stopped`, then calls `dispatchRecreateQueue` again.
  - `stopRecreateJob(jobId: string, ownerUserId: string): Promise<void>`: queued, then `removeQueued` and delete the empty version record; running, then `stopManusRecreation`, mark `stopped`, dispatch next.
  - `sweepRecreateQueue(): Promise<void>`: for every running row call `resumeManusRecreation`, mark rows whose page already settled, then dispatch for `usersWithQueuedJobs()`.

- [ ] **Step 1: Write failing tests:** `a fourth job stays queued and starts when one finishes`, `a failed job frees its slot and the next starts`, `a job for a user without credits fails with a message and the next still starts`, `stopping a running job starts the next queued one`, `removing a queued job deletes its empty version`, `sweep restarts the queue after a simulated restart (in-memory state cleared)`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateQueue.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the dispatcher. Load the owner with the existing identity reader (`src/lib/data/identity.ts`) for `runBillable`. Keep a module-level set of job ids in flight to avoid double starts in one process.
- [ ] **Step 4: Run** the test plus `tests/manusRecreate.test.ts` and `tests/manusRunAsync.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(recreate): server-side queue dispatcher`.

### Task 5: API (enqueue, list, stop/remove)

**Files:**
- Create: `src/app/api/recreate/jobs/route.ts`, `src/app/api/recreate/jobs/[id]/route.ts`, `src/lib/recreateList.ts`
- Test: `tests/recreateApi.test.ts`, `tests/recreateList.test.ts`

**Interfaces:**
- Consumes: Tasks 2-4; `requireUser`, `resolveProjectAccess` (`src/lib/authz.ts`); `ensureLandingPageRecord`; `analyzeCompetitorLandingPage` billed as `competitor.analyze_landing_page`.
- Produces:
  - `POST /api/recreate/jobs` body `{ competitorId } | { jobId, url }` plus `{ businessUrl?, styleDirection?, userFeedback?, icpId? }`. Requires `"run"` access on the source's run. Resolves the source (analysing the page first when needed), creates a version, inserts a job, dispatches, and returns 202 `{ job, queuedAhead: number }`. A second request with the same source and identical options while one is queued or running returns 409 `already in progress`. A changed `businessUrl` is saved on the run like the existing `set_business_url` action.
  - `GET /api/recreate/jobs?spaceId=` runs `sweepRecreateQueue` for the user, then returns `{ limit: number, items: RecreateListItem[] }`.
  - `DELETE /api/recreate/jobs/[id]` calls `stopRecreateJob`.
  - `interface RecreateListItem { id: string; competitorId: string; jobId: string | null; state: "queued" | "running" | "finished" | "failed" | "stopped" | "legacy"; sourceUrl: string; sourceName: string; businessName: string | null; keyword: string | null; styleDirection: string | null; targetIcp: { icpId: string; stage: string } | null; progress: { pct: number; message: string } | null; daysRunning: number | null; activeAds: number | null; createdAt: string; finishedAt: string | null; archived: boolean; hasPage: boolean; openPath: string; error: string | null }`
  - `isArchived(finishedAt: string | null, now: Date): boolean`: true when finished more than 14 days ago; `buildRecreateList(...)` in `recreateList.ts` merges jobs and versions, most recent first.

- [ ] **Step 1: Write failing tests:** `isArchived is false at 13 days and true at 15 days`, `isArchived uses the finish date, not the creation date`, `legacy source records with a recreatedPage appear as legacy items with "—" fields`, `POST by a viewer returns 403`, `POST twice with identical details returns 409 the second time`, `POST with a changed businessUrl saves it on the run`, `GET is scoped to the requested space`.
- [ ] **Step 2: Run** the two test files. Expected: FAIL.
- [ ] **Step 3: Implement** the routes and list builder. Errors follow the existing pattern (`isCreditError` returns 402, `errorResponse` for the rest).
- [ ] **Step 4: Run** both files plus `tests/apiSurface.test.ts`, `tests/authorization.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(recreate): jobs API and list`.

### Task 6: Decision signals (days running, active ads)

**Files:**
- Create: `src/lib/recreateSignals.ts`
- Modify: `src/lib/offerInsights.ts` (export the existing `adDays` and the active-ad rule), `src/components/SearchOffersReportPanel.tsx:1030-1032` (landing-page rows)
- Test: `tests/recreateSignals.test.ts`

**Interfaces:**
- Produces: `pageSignals(ads: Array<Pick<SearchCompetitorAdRecord, "daysRunning" | "startDateString" | "endDateString">>): { daysRunning: number | null; activeAds: number | null }`: longest running days among the page's ads (null when none known), count of active ads using the same rule as `offerInsights.ts`. `formatSignal(n: number | null): string` returns "—" for null.

- [ ] **Step 1: Write failing tests:** `pageSignals returns the longest days and active count`, `pageSignals returns nulls for no ads`, `formatSignal(null) is "—"`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateSignals.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** and show both numbers on the Offers landing-page rows. Run `tests/offerInsights.test.ts` (unchanged behaviour). Expected: PASS.
- [ ] **Step 4: Commit** `feat(recreate): days running and active ads on landing-page rows`.

### Task 7: Add to Recreate button and details popup

**Files:**
- Create: `src/components/recreate/AddToRecreateButton.tsx`, `src/components/recreate/RecreateDetailsDialog.tsx`, `src/lib/recreateClient.ts`
- Modify (replace each existing Recreate link or router push): `src/components/CompetitorTable.tsx:612-623`, `src/components/SearchOffersReportPanel.tsx:607-630,1112-1138`, `src/components/OfferInsights.tsx` (new button on best-offer rows), `src/components/ab/AbPageCard.tsx:118`, `src/components/ab/IcpDrawer.tsx:276`, `src/components/ab/AbTestingPanel.tsx:216-265`, `src/components/LookupResults.tsx:194,437-456`
- Test: `tests/recreateClient.test.ts` (pure helpers only)

**Interfaces:**
- Consumes: Task 5 endpoint; Task 6 `pageSignals`, `formatSignal`.
- Produces:
  - `AddToRecreateButton` props: `{ source: { competitorId: string } | { runId: string; url: string }; signals?: { daysRunning: number | null; activeAds: number | null }; icp?: { icpId: string; stage: string }; versionCount?: number; disabled?: boolean }`. It renders the signals beside the button, opens the dialog, and shows "Added to queue" or "Started" from the response. It never navigates. With `versionCount > 0` it also shows a "View versions" link to `?mode=recreate`.
  - `enqueueRecreation(body: EnqueueBody): Promise<{ job: RecreateJobDto; queuedAhead: number }>` (throws a typed error for 402/403/409) and `defaultDetails(job: SearchJob | null): { businessUrl: string; styleDirection: StyleDirection }` (pure, tested).
  - Popup fields: business URL (pre-filled from the run, required), style direction (default `brand`), optional notes; one Confirm button.

- [ ] **Step 1: Write failing tests** for `defaultDetails` (uses the run's `businessUrl`, falls back to `businessProfile.url`, style `brand`) and for the error mapping of `enqueueRecreation`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateClient.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the button and the dialog. Replace each entry point listed above with the button; delete the now-unused `prepareLandingPage` navigation path. `/recreate/<id>` stays as the editor.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit`. Expected: PASS and no type errors.
- [ ] **Step 5: Commit** `feat(recreate): Add to Recreate button everywhere`.

### Task 8: Recreate tab

**Files:**
- Create: `src/components/recreate/useRecreateJobs.ts`, `src/components/recreate/RecreateHub.tsx`, `src/components/recreate/SlotCard.tsx`
- Test: `tests/recreateHubState.test.ts` (pure helpers)

**Interfaces:**
- Consumes: Task 5 `GET /api/recreate/jobs`, `DELETE /api/recreate/jobs/[id]`.
- Produces: `useRecreateJobs(spaceId: string | null): { items: RecreateListItem[]; limit: number; running: number; queued: number; refresh(): Promise<void>; stop(jobId: string): Promise<void> }` (polls every 3 s while anything is running or queued, otherwise every 15 s); pure `splitItems(items): { slots: RecreateListItem[]; queue: RecreateListItem[]; recent: RecreateListItem[]; archived: RecreateListItem[] }`; `RecreateHub` props `{ jobs: ReturnType<typeof useRecreateJobs> }`.
- UI: three slot cards (source URL, brand, days running, active ads, stage and progress, Stop), empty slots labelled "Pick a page to recreate", queue list with Remove, then recent versions with an expandable sandboxed `iframe srcDoc` preview (content fetched on expand from `/api/competitors/recreate-page?competitorId=`), source URL, business, keyword, style, ICP, date, and an Open link to `openPath`. An "Archived" filter shows pages finished more than 14 days ago.

- [ ] **Step 1: Write failing tests:** `splitItems puts three running jobs in slots and the rest in queue`, `splitItems moves finished items older than 14 days to archived`, `splitItems keeps legacy items in recent when newer than 14 days`.
- [ ] **Step 2: Run** `npx tsx --test tests/recreateHubState.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the hook, `splitItems` and components.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(recreate): Recreate tab with live slots, queue and versions`.

### Task 9: Navigation (Find / Recreate / History)

**Files:**
- Modify: `src/app/page.tsx:34,58,74,533-660,779-830` (Mode, URL mirror, tab bar, render branches), `src/lib/urlState.ts` if mode parsing lives there
- Test: `tests/navModes.test.ts` (pure helpers)

**Interfaces:**
- Produces: `Mode` gains `"recreate"` (stays `"search" | "lookup" | "ab" | "recreate" | "history"`, so existing URLs and the saved last view keep working); `topTabOf(mode: Mode): "find" | "recreate" | "history"` and `FIND_MODES = ["search", "lookup", "ab"] as const` in `src/lib/navModes.ts`.
- Behaviour: top row shows Find, Recreate (badge "N running" plus "M queued") and History. Selecting Find shows a second row with Keyword search, Competitor lookup and A/B testing and remembers the last one used (default search). `useRecreateJobs` is called once in `page.tsx`, so polling and the badge continue while other tabs are shown. Platform picker shows only for search and lookup, as today.

- [ ] **Step 1: Write failing tests:** `topTabOf maps search, lookup and ab to find`, `topTabOf maps recreate and history to themselves`, `an unknown mode value falls back to search`.
- [ ] **Step 2: Run** `npx tsx --test tests/navModes.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `navModes.ts` and the two-row tab bar; mount `RecreateHub` for `mode === "recreate"`; pass `activeSpace` to the hook.
- [ ] **Step 4: Run** the test and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(nav): Find, Recreate and History tabs`.

### Task 10: Wrap-up and verification

**Files:**
- Modify: `package.json` (add all new test files to `test`), `docs/RECREATE_PIPELINE.md` (short section on versions, queue and the 3-slot limit)

- [ ] **Step 1: Add** the ten new test files (`recreateScope`, `recreateVersions`, `recreateJobs`, `recreateQueue`, `recreateApi`, `recreateList`, `recreateSignals`, `recreateClient`, `recreateHubState`, `navModes`) to the `test` script.
- [ ] **Step 2: Run** `npx tsc --noEmit` (limit 5 minutes). Expected: no errors.
- [ ] **Step 3: Run** each new test file plus `tests/manusRecreate.test.ts`, `tests/manusRunAsync.test.ts`, `tests/landingRecreate.test.ts`, `tests/accounting.test.ts`. Expected: PASS.
- [ ] **Step 4: Hand the user this manual checklist** (they test manually): add 3 pages and watch progress while switching tabs; add a 4th and see "Added to queue"; stop one and see the 4th start; run a search while 3 recreations run; restart the server mid-run and confirm everything resumes.
- [ ] **Step 5: Commit** `docs(recreate): hub, queue and versions`.
