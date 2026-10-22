# Awareness levels, A/B Testing portal and ICP generator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Label every analysed landing page with an audience level and an awareness stage (page and section level, using parallel agents), add an A/B Testing tab that lists the pages, shows which awareness stages no page covers, and lets the user generate an ICP for a missing stage and recreate a page for it.

**Architecture:** A new `src/lib/pipeline/awareness/` folder holds the level agents, coverage logic, page-list builder and ICP generator as small pure-ish modules with an injectable model caller, so each is tested offline. `landingPageAnalysis.ts` runs the level agents concurrently with the existing extraction call. Three new API routes under `/api/ab-testing/` feed one new tab component. The ICP reaches the existing Manus recreate pipeline as an extra section of the brief.

**Tech Stack:** Next.js 15 / React 19, TypeScript, zod, node:test via `tsx --test`, JSON-file store in `src/lib/db.ts`, existing OpenRouter / Anthropic clients.

**Spec:** `docs/superpowers/specs/2026-10-22-awareness-ab-testing-design.md` (approved 2026-10-22). Read it first; the decisions in its "Settled after builder review" section are binding.

## Global Constraints

- All new fields on stored records are optional; analyses saved before this change must still load.
- Awareness stages exactly: `unaware`, `problem_aware`, `solution_aware`, `product_aware`, `most_aware`, plus `unclear`. Audience levels exactly: `newbie`, `intermediate`, `advanced`, plus `unclear`. Focus flag exactly: `only_problem`, `only_solution`, `balanced`, or null.
- A label with no evidence quote found in the visible page text becomes `unclear` (same standard as `groundArchitectureSections`).
- Coverage rule: a stage is `covered` when at least one page's page-level stage equals it; `partial` when it appears only in some page's sections; otherwise `missing`. `unclear` counts toward nothing. The focus flag never changes coverage.
- Every new API route must call `requireUser(` or `resolveProjectAccess(` (enforced by `tests/apiSurface.test.ts`). Use `resolveProjectAccess(kind, id, user, "view" | "run")`; ICP rows are reached only through their source run/lookup, so they follow run access and org scoping.
- Text sent to client admins goes through `maskClientFacingText` (ICP via a new `maskIcp`).
- Reuse the OpenRouter → Anthropic → Perplexity fallback already in `landingPageAnalysis.ts`; add no new provider. Rethrow `isCreditError` errors; never swallow them.
- The `npm test` script lists test files explicitly: every new test file must be appended to the `test` script in `package.json`.
- Prod build type-checks tests and pushes are gated on `tsc`: run `npx tsc --noEmit` at the end of each task. Do NOT run `next build` or the full test suite; run only the task's test file (`npx tsx --test tests/<file>`), under a 5-minute limit.
- Work on branch `feature/awareness-ab-testing` (create it in Task 1; the repo is on `main`).

## Review Focus

1. A page whose page-level stage is `unclear` but whose sections have stages: shows `partial` for those stages, never `covered` (Task 1 test).
2. The model returns an evidence quote that is not on the page: label becomes `unclear`, not trusted (Task 2 test).
3. A level agent throws a non-credit error: the page analysis still completes with `levels` null; a credit error still propagates (Task 3 test).
4. A stored analysis with no `levels` (or a page still `pending`/`failed`): the portal list shows it as "Not labelled" / "Analysing" / "Failed" and the API does not crash (Task 5 test).
5. Business profile missing or thin: Generate ICP is refused before any AI call, with "Add your business website first" (Task 4 test, Task 5 route).

---

### Task 1: Types, shared evidence helpers, coverage logic

**Files:**
- Modify: `src/lib/types.ts` (add types near `LandingPageOfferAnalysis`, ~line 896; add `icps?: IcpRecord[]` to `DatabaseShape`; add `targetIcp` to `RecreatedLandingPage`)
- Create: `src/lib/pipeline/evidence.ts` (move `EVIDENCE_STOPWORDS`, `evidenceWords`, `pageCoverage` out of `landingPageAnalysis.ts`; export them)
- Modify: `src/lib/pipeline/landingPageAnalysis.ts` (import them from `./evidence`; behaviour unchanged)
- Create: `src/lib/pipeline/awareness/coverage.ts`
- Test: `tests/awarenessCoverage.test.ts`; append to `package.json` test script

**Interfaces:**
- Produces (types.ts): `AudienceLevel`, `AwarenessStage`, `AwarenessFocus`, `SectionLevel { sectionName: string; audienceLevel: AudienceLevel; awarenessStage: AwarenessStage }`, `PageLevels { audienceLevel; audienceReason: string; audienceEvidence: string | null; awarenessStage; awarenessFocus: AwarenessFocus | null; awarenessReason: string; awarenessEvidence: string | null; sectionLevels: SectionLevel[] }`, `LandingPageOfferAnalysis.levels?: PageLevels | null`, `IcpContent { painPoints: string[]; demographics: { ageRange: string | null; role: string | null; budget: string | null; location: string | null; other: string | null }; psychographics: string[]; saysOutLoud: string[]; interests: string[]; hopesAndDesires: string[]; stageNotes: string; suggestedAngle: string }`, `IcpRecord extends IcpContent { id: string; source: { kind: ProjectKind; id: string }; stage: Exclude<AwarenessStage, "unclear">; createdAt: string }`, `RecreatedLandingPage.targetIcp?: { icpId: string; stage: AwarenessStage } | null`.
- Produces (evidence.ts): `evidenceWords(text: string): string[]`, `pageCoverage(phrase: string, pageWords: Set<string>): number`.
- Produces (coverage.ts): `AWARENESS_STAGES: readonly ["unaware","problem_aware","solution_aware","product_aware","most_aware"]`, `type StageStatus = "covered" | "partial" | "missing"`, `type StageCoverage = { stage: (typeof AWARENESS_STAGES)[number]; status: StageStatus; pageIds: string[] }`, `computeCoverage(pages: Array<{ id: string; levels?: PageLevels | null }>): { stages: StageCoverage[]; labelledCount: number }`. Pages without `levels` are ignored and not counted in `labelledCount`.

- [ ] **Step 1:** `git checkout -b feature/awareness-ab-testing`; commit the spec and this plan first (`docs: awareness / A/B testing design and plan`).
- [ ] **Step 2: Write failing tests** in `tests/awarenessCoverage.test.ts`: (a) two pages, one `problem_aware`, one `solution_aware` → those two `covered` with the right `pageIds`, the other three `missing`, `labelledCount` 2; (b) a page with page-level `unclear` and a `sectionLevels` entry `problem_aware` → `problem_aware` is `partial`, not `covered` (Review Focus 1); (c) a page with `levels` undefined is ignored (`labelledCount` 0, all `missing`); (d) `awarenessFocus: "only_problem"` does not change the result versus `null`.
- [ ] **Step 3:** Run `npx tsx --test tests/awarenessCoverage.test.ts`; expect FAIL (module missing).
- [ ] **Step 4:** Add the types, move the evidence helpers (run `npx tsx --test tests/landingPageAnalysis.test.ts` to prove the move changed nothing), implement `computeCoverage`.
- [ ] **Step 5:** Run both test files and `npx tsc --noEmit`; expect PASS / no errors. Add the new test file to the `package.json` `test` script.
- [ ] **Step 6:** Commit `feat: awareness level types and coverage rule`.

---

### Task 2: Level agents (parallel audience + awareness)

**Files:**
- Create: `src/lib/pipeline/llmJson.ts`, `src/lib/pipeline/awareness/levelAgents.ts`
- Test: `tests/awarenessLevels.test.ts`; append to `package.json` test script

**Interfaces:**
- Consumes: `evidenceWords`, `pageCoverage` (Task 1); `isCreditError`; the client helpers already used in `landingPageAnalysis.ts` (`getOpenRouterClient`, `hasOpenRouterKey`, `getAnthropicClient`, `getAnthropicModel`, `OPENROUTER_FAST_MODEL`, `resolveOpenAICompatModel`, `OPENROUTER_PERPLEXITY_MODEL`).
- Produces (llmJson.ts): `type JsonCaller = (system: string, user: string) => Promise<string>`; `completeJson: JsonCaller` — text-only, same provider order as `analyzeWithLlm` (OpenRouter OpenAI → Anthropic → OpenRouter Perplexity), `max_tokens` 3000, temperature 0.15, throws the same "could not get a response" error when all fail, rethrows credit errors.
- Produces (levelAgents.ts):
  - `type BlockLevel = { heading: string; audienceLevel: AudienceLevel; awarenessStage: AwarenessStage }`
  - `type LevelsResult = { levels: PageLevels; blocks: BlockLevel[] }`
  - `analyzeLevels(input: { headingOutline: Array<{ level: number; text: string; snippet: string }>; heroCandidates: string[]; visibleText: string; call?: JsonCaller }): Promise<LevelsResult>` — runs the audience agent and the awareness agent concurrently with `Promise.all`; `call` defaults to `completeJson`. Each agent returns zod-validated JSON. The awareness agent also returns one `BlockLevel` per heading block (from `headingOutline`, capped at 24) and the focus flag. Evidence for each label is checked with `pageCoverage(evidence, words) >= 0.8`; failing or missing evidence sets that label to `unclear` (and its evidence to null). `sectionLevels` in the result is empty; Task 3 fills it with `attachSectionLevels`.
  - `attachSectionLevels(sections: Array<{ name: string; summary: string; keyElements?: string[] }>, blocks: BlockLevel[], page: Pick<PageLevels, "audienceLevel" | "awarenessStage">): SectionLevel[]` — a section takes the level of the block whose heading appears in its `keyElements` or `summary` (case-insensitive); unmatched sections inherit the page-level values; always returns one entry per section, in order.

- [ ] **Step 1: Write failing tests** with a fake `call` (no network): (a) with a fake that returns `{"audienceLevel":"newbie","evidence":"<quote on page>",...}` and `{"awarenessStage":"problem_aware","awarenessFocus":"only_problem",...}` the result carries those values and the page-level evidence; (b) the fake is invoked twice and both calls start before either resolves (assert via a shared counter/deferred) — proves parallelism; (c) an evidence quote absent from `visibleText` → `awarenessStage` and `audienceLevel` become `"unclear"` with null evidence (Review Focus 2); (d) malformed JSON from one agent → that label `unclear`, the other still returned; (e) `attachSectionLevels` matches by heading in `keyElements`, inherits page-level for an unmatched section, returns same length/order.
- [ ] **Step 2:** Run `npx tsx --test tests/awarenessLevels.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `completeJson` and `analyzeLevels` / `attachSectionLevels`. Prompt content is the builder's call but must define the three audience levels by assumed knowledge/jargon, define the five Schwartz stages by what the copy assumes the reader already knows, require an exact quote (≤25 words) from `visiblePageText` for each label, and require "unclear" when the copy gives no signal.
- [ ] **Step 4:** Run the test file and `npx tsc --noEmit`; expect PASS. Append to `package.json`.
- [ ] **Step 5:** Commit `feat: parallel audience and awareness level agents`.

---

### Task 3: Wire labels into page analysis, plus "label now" for old pages

**Files:**
- Modify: `src/lib/pipeline/landingPageAnalysis.ts` (`analyzeCompetitorLandingPage`, `analyzeLookupAdLandingPage`; add two exports)
- Modify: `src/lib/db.ts` (the `status === "pending"` merge blocks for competitor and lookup-ad `pageAnalysis`, near lines 1303–1317 and its competitor twin — grep `pageAnalysis?.status === "pending"`)
- Test: `tests/awarenessLevels.test.ts` (extend); `tests/landingPageAnalysis.test.ts` untouched

**Interfaces:**
- Consumes: `analyzeLevels`, `attachSectionLevels`, `LevelsResult` (Task 2); `PageOutline`, `fetchLandingPage`, `resolveCompetitorUrl`, `resolveLookupAdUrl` (private, same file).
- Produces: `buildLevels(sections: Array<{ name: string; summary: string; keyElements?: string[] }>, result: LevelsResult | null): PageLevels | null` (fills `sectionLevels` via `attachSectionLevels`); `runWithLevels<X>(extract: () => Promise<X>, levels: () => Promise<LevelsResult>): Promise<{ extracted: X; levels: LevelsResult | null }>`; `labelCompetitorLevels(competitorId: string): Promise<CompetitorRecord>` and `labelLookupAdLevels(adId: string): Promise<LookupAdRecord>` — refetch the page (`fetchLandingPage`, no screenshots, no offer re-extraction), run `analyzeLevels` with the stored sections, and write only `pageAnalysis.levels` (all other fields preserved). Both throw if the record has no completed `pageAnalysis`.

- [ ] **Step 1: Write failing tests:** (a) `buildLevels` returns `sectionLevels` of the same length as the sections and `null` when given `null`; (b) a helper `runWithLevels(extract: () => Promise<X>, levels: () => Promise<LevelsResult>)` (export from the same file, used by both analyse functions) resolves with `{ extracted, levels: null }` when `levels` rejects with a plain Error (Review Focus 3), rethrows when it rejects with an error for which `isCreditError` is true, and starts both functions before either settles.
- [ ] **Step 2:** Run the file; expect FAIL.
- [ ] **Step 3:** Implement `buildLevels` and `runWithLevels`; in both analyse functions replace the sequential `analyzeWithLlm` call with `runWithLevels`, passing `outline.headingOutline`, `outline.heroCandidates` and `outline.bodyText ?? outline.plainText`; store `levels` on the saved `LandingPageOfferAnalysis`. Add `labelCompetitorLevels` and `labelLookupAdLevels`. In `db.ts` carry `levels` through the pending-refresh merge (the patch currently keeps `offer`, `pageArchitecture`, `summary`; add `levels`).
- [ ] **Step 4:** Run `npx tsx --test tests/awarenessLevels.test.ts tests/landingPageAnalysis.test.ts` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Commit `feat: label landing pages with audience and awareness levels`.

---

### Task 4: Concurrency pool and ICP generator

**Files:**
- Create: `src/lib/pipeline/pool.ts`, `src/lib/pipeline/awareness/icp.ts`
- Modify: `src/lib/clientFacing.ts` (add `maskIcp`), `src/lib/db.ts` (ICP storage; default `icps: []` in `migrateDb`, remove a run's ICPs when the run/lookup is deleted, include `icps` in the import/merge by-id code next to `lookupAds`)
- Test: `tests/mapPool.test.ts`, `tests/icp.test.ts`; append both to `package.json`

**Interfaces:**
- Produces (pool.ts): `mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]>` — results in input order, never more than `limit` in flight, one rejection does not stop the others.
- Produces (icp.ts): `icpProfileReady(profile: BusinessProfile | null | undefined): boolean` (true when `offerings` is non-empty or `targetAudience` is non-blank); `generateIcp(input: { profile: BusinessProfile; stage: Exclude<AwarenessStage, "unclear">; keywords: string[]; competitorPages: Array<{ brand: string; headline: string | null; awarenessStage: AwarenessStage; audienceLevel: AudienceLevel }>; call?: JsonCaller }): Promise<IcpContent>` (throws `Error("Add your business website first")` when `!icpProfileReady`, before any model call; validates output with zod; every list capped at 8 items); `icpBelongsToRun(icp: Pick<IcpRecord, "source">, runId: string): boolean` (search: `source.id === runId`; lookup: `runId === LOOKUP_RECREATE_PREFIX + source.id`, prefix from `lookupRecreateBridge.ts`).
- Produces (db.ts): `getIcps(kind: ProjectKind, id: string): IcpRecord[]`, `getIcp(icpId: string): IcpRecord | null`, `upsertIcp(icp: IcpRecord): IcpRecord` (one row per source + stage; a new one replaces the old).
- Produces (clientFacing.ts): `maskIcp<T extends IcpContent>(icp: T): T` mapping every string through `maskClientFacingText`.

- [ ] **Step 1: Write failing tests:** pool — order kept, peak concurrency ≤ limit (track with a counter), a rejecting task is reported `rejected` while later tasks still run; icp — thin profile (empty offerings, blank audience) throws "Add your business website first" and the fake `call` is never invoked (Review Focus 5); a fake `call` returning valid JSON yields an `IcpContent` whose six sections are populated; the stage name and a competitor's headline appear in the prompt the fake receives; lists longer than 8 are truncated; `icpBelongsToRun` true/false for search and lookup ids; `maskIcp` scrubs a vendor name that `maskClientFacingText` scrubs.
- [ ] **Step 2:** Run both files; expect FAIL.
- [ ] **Step 3:** Implement. Prompt content is the builder's call but must make the ICP specific to the service (profile `offerings`, `positioningSummary`, `targetAudience`, market), written for the given stage (what that reader knows and says out loud), and avoid angles the listed competitor pages already take. `saysOutLoud` entries are first-person phrases the person would actually say.
- [ ] **Step 4:** Run both test files and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Commit `feat: ICP generator, concurrency pool, ICP storage`.

---

### Task 5: Page list builder and the three A/B API routes

**Files:**
- Create: `src/lib/pipeline/awareness/abPages.ts`, `src/app/api/ab-testing/route.ts` (GET), `src/app/api/ab-testing/label/route.ts` (POST), `src/app/api/ab-testing/icp/route.ts` (POST)
- Modify: the credit operation registry where `"competitor.analyze_landing_page"` is registered (grep for it) — register `"page.label_levels"` and `"icp.generate"` the same way
- Test: `tests/abPages.test.ts`; append to `package.json`

**Interfaces:**
- Consumes: `computeCoverage` (Task 1); `labelCompetitorLevels`, `labelLookupAdLevels` (Task 3); `mapPool`, `generateIcp`, `icpProfileReady`, `getIcps`, `upsertIcp`, `maskIcp` (Task 4); `getCompetitorsByRun`, `getLookupAds`, `getJob`, `getLookupJob`; `ensureLookupRecreationCompetitor` for lookup pages; `runBillable`; `resolveProjectAccess`; `maskPageAnalysis`.
- Produces (abPages.ts):
  - `type AbPage = { id: string; source: "competitor" | "lookupAd"; brand: string; url: string; headline: string | null; primaryOffer: string | null; cta: string | null; status: "pending" | "completed" | "failed" | "none"; levels: PageLevels | null; activeAds: number | null }`
  - `buildAbPages(input: { competitors?: CompetitorRecord[]; lookupAds?: LookupAdRecord[] }): AbPage[]` — competitors with `recreateOnly` are excluded; records with no `pageAnalysis` are excluded; `completed` records without `levels` get `levels: null`.
  - `pickBaseForStage(pages: AbPage[], stage: AwarenessStage): AbPage | null` — completed pages only; nearest stage by position in `AWARENESS_STAGES` (ties → more `activeAds`, then first); `unclear`/no-levels pages are last resort.
- Produces (routes):
  - `GET /api/ab-testing?kind=search|lookup&id=<id>` → `{ pages: AbPage[], coverage: ReturnType<typeof computeCoverage>, icps: IcpRecord[] (masked), profileReady: boolean, businessUrl: string | null, baseForStage: Partial<Record<AwarenessStage, AbPage | null>> }` (`baseForStage` computed with `pickBaseForStage` for each of `AWARENESS_STAGES`); access `"view"`.
  - `POST /api/ab-testing/label` body `{ kind, id, confirm?: boolean }` → without `confirm`: `{ count: number }` of completed pages lacking `levels`, no spend; with `confirm: true`: runs `mapPool(pages, 4, …)` under one `runBillable`, access `"run"`, returns `{ labelled: number, failed: number }`.
  - `POST /api/ab-testing/icp` body `{ kind, id, stage }` → `{ icp: IcpRecord }` (masked); access `"run"`; returns 400 `{ error: "Add your business website first" }` when `!icpProfileReady(profile)` before any billing; stage must be one of `AWARENESS_STAGES`.

- [ ] **Step 1: Write failing tests** for `buildAbPages` / `pickBaseForStage`: a `recreateOnly` competitor is excluded; a competitor with `pageAnalysis.status === "pending"` is listed with that status; a completed analysis saved with no `levels` key loads as `levels: null` without throwing (Review Focus 4); `pickBaseForStage` prefers an exact-stage page, then nearest, tie → more active ads, returns null for no completed pages.
- [ ] **Step 2:** Run `npx tsx --test tests/abPages.test.ts`; expect FAIL.
- [ ] **Step 3:** Implement `abPages.ts`, then the three routes (follow the auth / `runBillable` / `isCreditError` → 402 pattern in `src/app/api/competitors/analyze-page/route.ts`).
- [ ] **Step 4:** Run `npx tsx --test tests/abPages.test.ts tests/apiSurface.test.ts` and `npx tsc --noEmit`; expect PASS (apiSurface proves the new routes authorize).
- [ ] **Step 5:** Commit `feat: A/B testing page list and API routes`.

---

### Task 6: Pass the ICP into the recreate brief

**Files:**
- Modify: `src/lib/pipeline/manus/brief.ts` (`ManusBriefInput`, `buildManusBrief`), `src/lib/pipeline/manus/run.ts` (`briefInput`, where `recreatedPage` is first created for a run), `src/app/api/competitors/recreate-page/route.ts` (`generate_page`), `src/app/recreate/[competitorId]/RecreatePageClient.tsx`
- Test: `tests/manusRecreate.test.ts` (extend)

**Interfaces:**
- Consumes: `IcpRecord`, `getIcp`, `icpBelongsToRun` (Task 4); `RecreatedLandingPage.targetIcp` (Task 1).
- Produces: `ManusBriefInput.icp?: { stage: AwarenessStage; content: IcpContent } | null`; `buildManusBrief` adds a section "## The reader this page is for" when `icp` is set, stating the stage and what that reader already knows (`stageNotes`), listing pain points and `saysOutLoud` phrases to echo in headline and subheads, the `suggestedAngle`, and the instruction to keep the competitor layout while rewriting headline, proof and call-to-action copy for this reader. The route accepts optional `body.icpId` on `generate_page`; it returns 400 if the ICP is missing or `!icpBelongsToRun(icp, existing.runId)`, otherwise stores `targetIcp: { icpId, stage }` on `recreatedPage` before the run starts. `run.ts` reads `competitor.recreatedPage.targetIcp` to fill `briefInput.icp`, so "Regenerate page" keeps the target. `RecreatePageClient` reads an `icp` query param and sends it as `icpId` on generate.

- [ ] **Step 1: Write failing tests:** `buildManusBrief` without `icp` is byte-identical to today's output for the same input (snapshot the existing fixture's output first); with `icp` the brief contains the stage name, a pain point, and a `saysOutLoud` phrase.
- [ ] **Step 2:** Run `npx tsx --test tests/manusRecreate.test.ts`; expect FAIL on the new cases only.
- [ ] **Step 3:** Implement the brief section, the run input, the route change and the client query param.
- [ ] **Step 4:** Run `npx tsx --test tests/manusRecreate.test.ts tests/apiSurface.test.ts` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Commit `feat: recreate a page for a generated ICP`.

---

### Task 7: A/B Testing tab — list, coverage strip, labelling

**Files:**
- Create: `src/components/ab/AbTestingPanel.tsx`, `src/components/ab/CoverageStrip.tsx`, `src/components/ab/AbPageCard.tsx`
- Modify: `src/app/page.tsx` (`type Mode` line 33 gains `"ab"`; fourth tab button after "Competitor lookup" in the `mode-bar` ~line 795; render `<AbTestingPanel …/>`; the platform picker block at ~line 805 must also hide for `"ab"`; the URL-sync code near lines 528 and 609–617 must treat `"ab"` like the other modes), `src/app/globals.css` (a few classes only, matching the existing panel/badge styles)

**Interfaces:**
- Consumes: `GET /api/ab-testing`, `POST /api/ab-testing/label` (Task 5); `/api/history/unified` for the source picker (read its response shape); existing recreate entry points: search page → `/recreate/${competitorId}`; lookup page → `POST /api/lookup/recreate-bridge` then `/recreate/${competitorId}`.
- Produces: `AbTestingPanel({ defaultSource }: { defaultSource: { kind: "search" | "lookup"; id: string } | null })`; `CoverageStrip({ coverage, labelledCount, profileReady, onGenerate }: …)`; `AbPageCard({ page, onRecreate }: …)`.

Behaviour (from the spec's UI section; keep it plain):
- Top: a source picker (search runs and lookups, defaulting to the one open, else the latest). Under it, the coverage strip: five chips in order Unaware → Most aware. Covered = count ("3 pages"); Partly covered = amber; Missing = dashed grey with a **Generate ICP** button (disabled with the tooltip "Add your business website first" when `!profileReady`). One help line: "Stages no competitor page speaks to are your opening." Strip is hidden until `labelledCount > 0`.
- Page list: one compact card per page with brand, URL, headline, offer, CTA, audience badge, awareness badge (+ "only problem" / "only solution" note), reasons on expand, and **Recreate for my brand**. Filters: awareness stage, audience level. States: no analysed pages (text + link back to Keyword search); `levels: null` shows "Not labelled" with **Label now**; a banner "N pages not labelled — Label all" that calls `/label` without `confirm`, shows the count, and runs with `confirm: true` only after the user clicks Confirm; pending shows "Analysing…"; failed shows the error.

- [ ] **Step 1:** Build the three components and the tab wiring against the Task 5 API.
- [ ] **Step 2:** Run `npx tsc --noEmit`; expect no errors.
- [ ] **Step 3:** Start `npm run dev`, open the app, and check by hand with a run that has analysed pages: tab appears fourth; list renders; filters work; a page analysed before this change shows "Not labelled" and "Label now" fills the badges; the strip shows covered/partial/missing as the data dictates. Report what was checked and what was not.
- [ ] **Step 4:** Commit `feat: A/B testing tab with page list and coverage strip`.

---

### Task 8: ICP drawer and recreate-for-stage

**Files:**
- Create: `src/components/ab/IcpDrawer.tsx`
- Modify: `src/components/ab/AbTestingPanel.tsx`, `src/components/ab/CoverageStrip.tsx`

**Interfaces:**
- Consumes: `POST /api/ab-testing/icp` and the `baseForStage` field of `GET /api/ab-testing` (Task 5); recreate with `/recreate/${competitorId}?icp=${icpId}` (Task 6).
- Produces: `IcpDrawer({ stage, icp, generating, error, basePage, pages, onRegenerate, onRecreate, onClose }: …)`.

Behaviour: clicking Generate ICP (or a covered/partial chip's "View ICP" once one exists) opens a side drawer with six labelled blocks (Pain points, Demographics, Psychographics, What they say out loud, Interests, Hopes & desires), plus a short "What this reader knows" line (`stageNotes`) and "Suggested angle". Buttons: Regenerate, Copy (plain text), and **Recreate a page for this ICP**, which shows "Based on: <brand> page" with a **Change page** link opening a plain list of the run's completed pages. A stage that already has an ICP shows "View ICP" on its chip instead of Generate. With no base page available the recreate button is disabled with "Analyse a competitor page first".

- [ ] **Step 1:** Build the drawer; wire generate → drawer open → show result; wire Recreate (lookup pages go through the recreate-bridge first).
- [ ] **Step 2:** Run `npx tsc --noEmit`; expect no errors.
- [ ] **Step 3:** Manual check in `npm run dev`: Generate ICP on a missing stage returns a service-specific ICP; reopening shows the saved one; Regenerate replaces it; with no business website the button is disabled; Recreate opens `/recreate/<id>?icp=<icpId>` and the run's brief includes the ICP section (check the generated `brief.md` via the existing feed). Report what was and was not checked.
- [ ] **Step 4:** Commit `feat: ICP drawer and recreate for a missing stage`.

---

### Task 9: Exports and manual

**Files:**
- Modify: `src/lib/export/fullReportExcel.ts` (add "Audience level" and "Awareness stage" columns wherever the landing-page analysis columns are written), `docs/USER_MANUAL.md` (a short "A/B testing" section: what the tab shows, the four coverage states, what Generate ICP and Recreate do, and the cost note for "Label all")
- Test: `tests/fullReport.test.ts` (extend)

- [ ] **Step 1: Write failing test:** the full-report workbook for a fixture competitor with `pageAnalysis.levels` has header cells "Audience level" and "Awareness stage" and the matching values in that competitor's row; a competitor without `levels` has empty cells there.
- [ ] **Step 2:** Run `npx tsx --test tests/fullReport.test.ts`; expect FAIL.
- [ ] **Step 3:** Add the columns and the manual section.
- [ ] **Step 4:** Run `npx tsx --test tests/fullReport.test.ts` and `npx tsc --noEmit`; expect PASS.
- [ ] **Step 5:** Commit `feat: levels in the full run report; A/B testing in the manual`.

---

## Self-review (against the spec)

- Goals 1–2 (labels, section labels): Tasks 1–3. Goal 3 (parallel): Task 2 (agents concurrent), Task 3 (concurrent with extraction), Task 5 (pool of 4 for "Label all"). Goals 4–5 (portal, missing stages, Generate ICP): Tasks 5, 7, 8. Goal 6 (ICP content): Tasks 1, 4. Goal 7 (recreate for ICP): Task 6, 8. Goal 8 (simple UI): Tasks 7–8 behaviour lists. History/export: Task 9 (history rows read `pageAnalysis`, so `levels` rides along with no change).
- Settled calls: coverage rule (Task 1), own picker and lookup as separate source (Tasks 5, 7), thin-profile block and masking (Tasks 4, 5), "Label now" refetch + confirm (Tasks 3, 5, 7), base-page default with "Change page" (Tasks 5, 8).
- Type names used across tasks match Task 1's Interfaces block (`PageLevels`, `LevelsResult`, `AbPage`, `IcpRecord`, `JsonCaller`).
