# A/B testing follow-up: offers-dashboard pages and a better run picker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) The A/B testing tab lists every landing page the offers dashboard analysed for a search run (not just the competitor records), labels them through the existing count-then-confirm "Label all", and can recreate them; (2) the run picker becomes a searchable, dated list.

**Architecture:** `abSource.ts` adds the offers-dashboard pages of a run (analysed ads of its hidden `search-offers:<runId>:<ts>` lookups) to the page list with an `origin` tag; labelling and recreate reuse existing functions and routes. The picker is a custom accessible dropdown fed by the existing `/api/history/unified` data.

**Tech Stack:** Next.js 15 / React 19 / TypeScript, node:test via `tsx --test`, JSON store in `src/lib/db.ts`.

**Spec:** `docs/superpowers/specs/2026-10-22-awareness-ab-testing-design.md`. This plan reverses one earlier ruling: level agents are NO LONGER skipped for `internalOnly` lookups (the pages are now shown in the A/B tab, so their labels are visible).

## Global Constraints

- Same constraints as the original plan: new fields optional; no billable call on mount, source switch or picker open; spend only after an explicit click (Label all spends only after Confirm); every route calls `requireUser(` or `resolveProjectAccess(`; client text from masked output; offline, pristine tests; focused tests + `npx tsc --noEmit` only (no `next build`, no whole suite, 5-minute limit per command); never run the app against the live store or click anything that spends credits.
- `tests/migration.test.ts` has one failing test ("the accounting collections are seeded") on original main: ignore it.
- Work on branch `feature/awareness-ab-testing` (already checked out). Append every new test file to the `test` script in `package.json`. Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Add only files you changed (never `git add -A`; leave untracked `.playwright-mcp/` and `docs/MANUS_REDESIGN_PIPELINE.md` alone).

## Review Focus

1. A page that is both a competitor record and an offers-dashboard page (same landing URL) appears once, not twice.
2. A search run with no offers dashboard (or an offers report that failed/has no analysed ads) still lists its competitor pages and does not crash.
3. Offers-dashboard pages analysed before levels existed show as "Not labelled" and are included in the Label all count; Label all never spends before Confirm.
4. Recreate for an offers-dashboard page uses the dashboard's existing route and does not spend credits before an explicit click.

---

### Task 1: List and label the offers dashboard's pages

**Files:**
- Modify: `src/lib/pipeline/awareness/abPages.ts` (AbPage gains `origin` and `analyzedAt`; new `mergeOfferPages`)
- Modify: `src/lib/pipeline/awareness/abSource.ts` (search sources also load the offers-dashboard pages)
- Modify: `src/lib/pipeline/landingPageAnalysis.ts` (stop skipping level agents for `internalOnly` lookups; remove or neutralise `shouldLabelLevels` and update its test in `tests/finalFixes.test.ts`)
- Modify: `src/app/api/ab-testing/label/route.ts` only if its page-dispatch does not already handle `source: "lookupAd"` pages of a search source (read it first)
- Test: `tests/abPages.test.ts` (extend), `tests/finalFixes.test.ts` (adjust)

**Interfaces:**
- Produces: `AbPage` gains `origin: "competitor" | "offers" | "lookup"` and `analyzedAt: string | null`. `buildAbPages` sets `origin` to `"competitor"` for competitor records and `"lookup"` for lookup ads of a standalone lookup. New `mergeOfferPages(competitorPages: AbPage[], offerAds: LookupAdRecord[]): AbPage[]` returns the competitor pages followed by one page per distinct analysed landing URL among `offerAds` (`origin: "offers"`, `source: "lookupAd"`, brand from `pageName`). Dedupe rules: normalise URLs for comparison (strip fragment and trailing slash, lower-case host; reuse an existing normaliser such as `normalizeLandingUrl` in `src/lib/pipeline/htmlFetch.ts` if it fits); a competitor page wins over an offers page with the same URL; among offers ads with the same URL prefer a completed analysis, then the one with `levels`, then the latest `analyzedAt`. Ads without a `pageAnalysis` are ignored.
- Consumes: `getLookupJob`, `getLookupAds`, and the way to enumerate lookup jobs in `src/lib/db.ts` (find the right function; synthetic lookups have ids starting with `search-offers:${runId}:`). A search run can have several (one per offers-report run): use all of them.

- [ ] **Step 1: Write failing tests** in `tests/abPages.test.ts`: (a) `mergeOfferPages` lists competitor pages plus offers pages with `origin` set correctly; (b) a competitor page and an offers ad with the same landing URL (differing only by trailing slash / fragment / host case) produce ONE page, the competitor one (Review Focus 1); (c) two offers ads with the same URL give one page, the completed+levelled one; (d) offers ads with no `pageAnalysis` are ignored and an empty `offerAds` returns the competitor pages unchanged (Review Focus 2); (e) an offers ad whose analysis has no `levels` key gives `levels: null` (Review Focus 3).
- [ ] **Step 2:** Run `npx tsx --test tests/abPages.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `origin`, `analyzedAt`, `mergeOfferPages`; wire `loadAbSource` (search branch) to load the run's offers ads and call it; keep the lookup branch's pages `origin: "lookup"`. Reverse the `internalOnly` skip in `landingPageAnalysis.ts` and adjust `tests/finalFixes.test.ts` accordingly (a standalone and an internal lookup both get levels).
- [ ] **Step 4:** Confirm the label route labels `lookupAd` pages of a search source via `labelLookupAdLevels` and that its access checks still go through the search run (`resolveProjectAccess("search", id, ...)`); fix only if needed.
- [ ] **Step 5:** Run `npx tsx --test tests/abPages.test.ts tests/finalFixes.test.ts tests/awarenessLevels.test.ts tests/apiSurface.test.ts` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 6:** Commit `feat: list offers-dashboard pages in the A/B tab and label them`.

---

### Task 2: Dated run picker, origin tags, and recreate for dashboard pages

**Files:**
- Modify: `src/components/ab/AbTestingPanel.tsx`; Create: `src/components/ab/RunPicker.tsx`; Modify: `src/components/ab/AbPageCard.tsx`; Modify: `src/app/globals.css` (`ab-` prefixed classes only)
- Create (pure helper, tested): `src/lib/pipeline/awareness/runLabels.ts`; Test: `tests/runLabels.test.ts`

**Interfaces:**
- Consumes: `/api/history/unified` runs (`id`, `kind`, `title`, `status`, `createdAt`, `updatedAt`, `count`, `countLabel`, `subtitle`, `platformLabel`); `AbPage.origin` (Task 1); the dashboard's recreate route `POST /api/search/landing-recreate` body `{ jobId, url }` → `{ page: { competitorId, recreatePath, ... } }` (it analyses the page first when needed, which spends credits — exactly like the offers dashboard's own Recreate button).
- Produces: `formatRunDate(iso: string | null | undefined, now?: Date): { label: string; relative: string }` (label like `28 Sep 2026, 2:05 pm` in the viewer's locale; relative like `24 days ago`/`today`; empty strings for missing or invalid input); `groupRuns(runs): Array<{ heading: "Keyword searches" | "Competitor lookups"; runs: RunItem[] }>` (newest `createdAt` first within a group, empty groups omitted); `filterRuns(runs, query): RunItem[]` (case-insensitive match on title, subtitle and the formatted date text).

Behaviour:
- **RunPicker** replaces the `<select>`. A button shows the selected run as: type chip (Search / Lookup), title, `Ran <date> (<relative>) · <count> <countLabel>`; clicking opens a popover with a search box and two groups (Keyword searches, Competitor lookups). Each row: title, type chip, `Ran <date>`, count, status chip, subtitle (business). Newest first. Selecting closes it. Accessible: `role="listbox"`/`option` (or a menu pattern), arrow-key navigation, Enter selects, Escape closes and returns focus to the button, click outside closes, search box filters live, "No runs match" empty state, scrollable with a max height. Opening it makes NO network call beyond the history data already loaded.
- Under the picker, a one-line summary of the loaded source: `Showing N pages · X from competitors · Y from the offers dashboard` (omit the zero parts).
- **AbPageCard**: a small origin tag ("Competitor" / "Offers dashboard" / "Lookup") and, when present, "Analysed <date>" from `analyzedAt`.
- **Recreate for my brand** on an `origin: "offers"` page: `POST /api/search/landing-recreate` with `{ jobId: source.id, url: page.url }`, then navigate to the returned `recreatePath`; the button label/title states it analyses the page first and uses credits when the page has not been analysed for recreation yet; guard double clicks; errors (including 402) shown in the panel. The ICP drawer's recreate must use the same path when its base page is an `origin: "offers"` page (append `?icp=<icpId>` to the returned path).
- Keep every existing spend gate and stale-source guard intact.

- [ ] **Step 1: Write failing tests** `tests/runLabels.test.ts`: `formatRunDate` (known ISO + fixed `now` gives the expected relative text for today / 1 day / 24 days; invalid and null give empty strings), `groupRuns` (grouping, newest first, empty group omitted), `filterRuns` (matches title, subtitle and date text; empty query returns all).
- [ ] **Step 2:** Run `npx tsx --test tests/runLabels.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `runLabels.ts`; build `RunPicker.tsx`; wire it into `AbTestingPanel.tsx` (defaulting rules unchanged: the open search run, else the open lookup, else the latest); add the summary line, the origin tag, the dashboard-page recreate path, and the CSS. Append `tests/runLabels.test.ts` to `package.json`.
- [ ] **Step 4:** Run `npx tsx --test tests/runLabels.test.ts tests/icpText.test.ts tests/abPages.test.ts` and `npx tsc --noEmit`; expect PASS. State plainly in the report that the UI was not run.
- [ ] **Step 5:** Commit `feat: dated run picker, origin tags, recreate for offers-dashboard pages`.
