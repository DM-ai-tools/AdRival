# Recreate hub: design

Date: 2026-10-28. Status: draft for approval.

## Intent and why

Landing-page recreation (Manus pipeline) is reachable from several places (Competitors tab, Offers dashboard landing-page section, A/B cards, Lookup) with different wording and different rules, and none of them show the data a user needs to decide which page is worth recreating (days the ad has run, number of active ads). The Insights view, where the best offers are shown, has no Recreate action at all. The user can also only follow one recreation at a time because progress lives on a separate `/recreate/<id>` page.

Goal: one place to run and watch recreations, one consistent way to start them from anywhere, and navigation that makes "find a page" and "recreate a page" clearly separate steps.

## Goals

1. Up to 3 landing-page recreations run at the same time per user.
2. A top-level **Recreate** tab shows all running recreations with live progress, and all finished ones. Progress keeps updating when the user switches tabs, and builds keep running on the server regardless.
3. Every place that offers recreation today uses the same "Add to Recreate" button, with days running and active ads shown next to it so the decision can be made on the spot.
4. A fourth request while 3 are running is queued ("Added to queue") and starts automatically when a slot frees, even if the user has left the page.
5. Simpler navigation (below).

## Non-goals

- Changing the Manus pipeline, its prompts or its outputs.
- Per-organisation concurrency limits.
- Side-by-side visual comparison of results (listing and opening only; may come later).
- Changing how credits are priced.

## Anti-goals

- A queued or running job must never be lost or silently dropped (restart, tab switch, navigating away).
- A running search must never block a recreation slot, and recreations must never block searches.
- Nothing may start a paid build without an explicit user click on "Add to Recreate".

## Navigation (decided)

Layout B. Top level has three tabs: **Find**, **Recreate**, **History**.
- Selecting Find reveals a second row: Keyword search, Competitor lookup, A/B testing. The user switches freely between them.
- Recreate shows a live badge with the number running, e.g. "2 running" (plus queued count if any), visible from every tab.
- The existing `?mode=` URL and last-view restore keep working; the old `search`, `lookup`, `ab` values map to Find plus a sub-tab.

## Recreate tab (decided)

- Three slot cards at the top. Each running slot shows: source page URL, competitor/brand, days running, active ads, progress and stage, and a Stop button. Empty slots say "Pick a page to recreate". Queued items are listed in order under the slots, with a Remove action.
- Below: every recreated page for the user, with its HTML preview and open/edit actions (the existing `/recreate/<id>` page remains the editor), the competitor/source URL, and which service/business it was created for (business name, keyword, style direction, target ICP when present), plus created date and status.
- Finished pages are **archived after 14 days**.

## "Add to Recreate" button (decided)

Used in: Competitors table, Offers dashboard landing-page rows, Offers Insights (new there), A/B page cards and drawer, Lookup results. It starts or queues the job and keeps the user on the current page (no navigation to `/recreate/<id>`). Days running and active ads are shown beside it everywhere; the Offers landing-page rows need these added (derive from the page's ads). If the page was already recreated the button reads "View recreated page" as today.

## Add-time details popup (decided)

Clicking "Add to Recreate" opens a small popup pre-filled with the user's defaults (business/service, business URL, style direction, target ICP when the click comes from the A/B tab). One click confirms. All details are collected here and stored on the queue/job record, so a queued job can start with nobody present and never waits on input. Anything that could previously pause for input must be resolved before queueing or use the pre-filled defaults.

## Multiple versions per source page (decided)

The same source page can be recreated many times, for different businesses, ICPs or styles. The Recreate tab keeps every version, each labelled with the business/ICP/style it was made for. The one-recreation-per-competitor assumption in the current data model (`recreatedPage` on the competitor record) must be replaced with a per-recreation record. "View recreated page" on a button means "this page has at least one version" and links to the Recreate tab filtered to it; adding another version is always possible.

## Concurrency and queue (decided)

- Recreations get their own limit of 3 concurrent per user, counted separately from the shared billable-run limit that search and offers analysis use today. Searches and recreations no longer compete for slots.
- The 4th and later requests are queued server-side and start automatically, in order, when a running one finishes, fails or is stopped. Advancing the queue must not depend on any browser being open.

## Constraints from the existing code (facts, not decisions)

- Entry points all navigate to `/recreate/[competitorId]`; start/poll/stop/edit logic is in `src/app/recreate/[competitorId]/RecreatePageClient.tsx` and `src/app/api/competitors/recreate-page/route.ts`.
- Job state is stored on the competitor record (`recreatedPage` status pending/design_pending/completed/failed, progress, Manus task id); HTML in `recreated_pages`. Server polls Manus every 10 s; browser polls every 2.5 s with `?light=1`.
- The current limit is `maxConcurrentRunsPerUser` (default 3) enforced in `runBillable` / `reserveCredits`, shared by all billable work. `edit_page` is also billed and takes a slot today.
- `resumeManusRecreation` after a restart is not wrapped in billing.
- No endpoint lists a user's recreated pages across runs; one is needed, scoped by owner and client space.
- Home page nav is `Mode` state in `src/app/page.tsx` mirrored to the URL.

## Left to the builder (with my guesses)

- Queue storage and the mechanism that starts the next job (a persisted queued status plus a server-side check when a job ends and on resume is my suggestion).
- Whether queued jobs reserve credits at queue time or at start (my call: reserve at start, so queued jobs hold nothing).
- How "archived" is shown: my call is a filter or section in the Recreate tab; archived pages are kept and remain openable, not deleted.
- Whether `edit_page` counts against the 3 recreate slots (my call: no, edits are short; keep them on the shared limit).
- Client-space scoping of the Recreate list (follow the active space as A/B testing does).
- Mobile/small-screen behaviour of the two-row nav.

## Calls made by the author (not yet confirmed by the user)

- Credits are checked when a queued job starts. If it can't be paid for, the job is marked failed with a clear message on the Recreate tab. Recreations still go through the billing wrapper for the credit check, with the new separate concurrency count.
- Stopping behaves as today (credits follow actual usage). Stopped and failed jobs stay in the list. Removing a queued job leaves no state.
- Where days running or active ads aren't available on a surface, show "—".
- Pages from before this change show "—" for context fields they lack. Currently running jobs count toward the new limit.
- The 14 days run from completion. After that a page moves to an "Archived" filter. It is never deleted, applies to old pages too, and failed/stopped jobs follow the same rule.
