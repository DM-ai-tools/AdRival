# Audience / awareness levels, A/B Testing portal and ICP generator — design

Date: 2026-10-22. Status: draft for approval.

## Why

Today a page analysis says what a competitor's landing page offers and how it is built, with one free-text `audience` line. The user wants to know who each page is written for and how much that reader already knows, then use the gaps: if no competitor page speaks to a given awareness stage, the user can build their own page for that stage and A/B test it against the ones that do exist.

Goal chain: **analyse pages → label them → see which awareness stages are covered → for a missing stage, generate an ICP → recreate a page for the user's brand aimed at that ICP.**

## Goals

1. Every analysed landing page gets two new labels, each with a reason and a quoted line from the page:
   - **Audience level**: `newbie`, `intermediate`, `advanced`.
   - **Awareness level**: the five Schwartz stages `unaware`, `problem_aware`, `solution_aware`, `product_aware`, `most_aware` (the builder's call, see below), with a `focus` flag: `only_problem` / `only_solution` / `balanced` for pages that speak to one stage and ignore the others.
2. The page's **content is categorised on both metrics too**: each page section carries its own audience level and awareness stage (a hero may be problem-aware while the pricing block is product-aware). The page-level label is the dominant one.
3. Analysis uses **parallel agents** so it is faster than today: the independent parts of one page analysis run at once, and several pages are analysed at once with a concurrency cap.
4. A new top-level **A/B Testing** portal lists all analysed landing pages (details only) with a "Recreate for my brand" action on each.
5. The portal shows **which awareness stages are missing** and offers "Generate ICP" for each missing one.
6. The **ICP** covers pain points, demographics, psychographics, what they say out loud, interests, hopes and desires, all tied to the user's service.
7. A generated ICP can be used to **recreate a page for the user's brand aimed at that stage** (the user confirmed this is the point of the feature).
8. The UI stays simple: one new tab, one screen, two clear states per stage (covered / missing).

## Non-goals

- No change to how competitors are found or filtered.
- No automatic A/B experiment running, traffic splitting or results tracking. "A/B testing" here is the portal for building comparable page variants.
- No re-labelling UI where users edit labels by hand (can come later).
- No changes to the Manus recreate pipeline internals beyond giving it extra brief context.

## Anti-goals (failure even if it technically works)

- Labels that look confident but are invented. Each label needs a quoted evidence line from the visible page text, like sections already do (`groundArchitectureSections`); labels without evidence fall back to "unclear".
- Slower analysis. Parallel splitting must not cost more wall-clock time than today's single call.
- A portal that needs explaining. If a first-time user cannot tell what "missing stage" means without help, it failed.
- ICPs that are generic. They must be written for the user's service and market, not boilerplate persona text.

## What exists (verified in code)

- `src/lib/pipeline/landingPageAnalysis.ts`: `analyzeWithLlm` is one call (OpenRouter OpenAI first, then Anthropic, then Perplexity) returning offer, page architecture, `audience`, trust signals, conversion elements, tech notes and summary. `analyzeCompetitorLandingPage(competitorId)` and `analyzeLookupAdLandingPage(adId)` wrap it and save to `competitor.pageAnalysis` / lookup ad `pageAnalysis`.
- `LandingPageOfferAnalysis` in `src/lib/types.ts` is the stored shape.
- `src/lib/pipeline/manus/brief.ts`: `buildManusBrief` / `buildManusTaskMessage` take `pageAnalysis`, client business info and style; the recreate API is `src/app/api/competitors/recreate-page/route.ts` (actions: generate, edit, stop, undo, set business url).
- `BusinessProfile` (types.ts) holds the user's `offerings`, `targetAudience`, `positioningSummary`, categories and locations: the input for ICP writing.
- Main UI: `src/app/page.tsx` has tabs search / lookup / history. Recreate has its own page at `/recreate/[competitorId]`.
- Offers dashboard recreation uses `recreateOnly` competitor records; those are excluded from competitor lists.

## Decisions

Decided by the user:
- ICP feeds recreation (confirmed).
- Awareness stages include "only problem-aware / only solution-aware" style cases, with missing ones surfaced and an ICP offered.
- Parallel agents for speed.
- A separate A/B Testing portal after analysis, listing pages and details only, with recreate-for-my-brand.

My calls (flag if you disagree):
- Five Schwartz stages for the awareness scale, plus a `focus` flag for single-stage pages. "Missing" is judged against the five stages.
- The portal is **per search run** (pages from the run you open, picked from history), not global across all runs, so "missing" always means "missing among these competitors". Lookup-ad pages are included when the lookup is opened the same way.
- Missing-stage ICPs are generated on demand (one click, one AI call), not automatically, so no spend the user did not ask for. Saved on the run so reopening shows them.
- Section-level labelling is included (goal 2) because the user asked for content to be categorised, not just the page.
- The portal is a new fourth tab beside search / lookup / history.

## Design

### 1. Analysis labels (data)

Extend `LandingPageOfferAnalysis` with an optional `levels` block (optional so old saved analyses still load):

```
levels?: {
  audienceLevel: "newbie" | "intermediate" | "advanced" | "unclear";
  audienceReason: string; audienceEvidence: string | null;
  awarenessStage: "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "most_aware" | "unclear";
  awarenessFocus: "only_problem" | "only_solution" | "balanced" | null;
  awarenessReason: string; awarenessEvidence: string | null;
  sectionLevels: [{ sectionName, audienceLevel, awarenessStage }];
}
```

Pages analysed before this change have no `levels`; the portal shows them as "Not labelled yet" with a "Label now" action that runs only the new agents (no refetch of the whole page analysis if the stored outline suffices, otherwise a normal refresh).

### 2. Parallel agents

Inside one page analysis, after the page is fetched and the outline/screenshots exist, run concurrently with `Promise.all`:
- Agent A: existing offer + architecture extraction (unchanged).
- Agent B: audience level (reads copy tone, jargon, assumed knowledge).
- Agent C: awareness stage + focus (reads what the hero and sections assume the reader already knows).
Agents B and C also tag each section, using the section list from A when ready; to avoid waiting, B and C tag against `headingOutline` blocks and the results are matched to A's sections by name afterwards (builder to settle the matching detail).
- A cheap verifier step (optional, builder's call) checks each label's evidence quote exists in the visible text; failures become "unclear".

Across pages, the portal's "Label all" and the existing "Get offer & page details" action run pages through a small concurrency pool (suggested 4, configurable) instead of one by one. Existing credit/cost handling (`isCreditError`, ledger) applies to each call.

### 3. A/B Testing portal (UI)

A fourth tab "A/B testing". One screen, three stacked parts, top to bottom:

1. **Coverage strip**: five chips in awareness order (Unaware → Most aware). Covered chip shows a count ("3 pages"); missing chip is dashed grey with "Missing" and a **Generate ICP** button. One-line help text: "Stages no competitor page speaks to are your opening."
2. **ICP drawer** (opens from a missing chip): shows the generated ICP in six labelled blocks (Pain points, Demographics, Psychographics, What they say out loud, Interests, Hopes & desires), with Regenerate, Copy, and **Recreate a page for this ICP**.
3. **Page list**: one compact card per analysed page: brand, page URL, headline, primary offer, CTA, an audience-level badge and an awareness badge (with "only problem / only solution" note when set), the one-line reasons on expand, and **Recreate for my brand**. Filters: awareness stage and audience level. Nothing else (no trust signals, tech notes, ads list: those stay in the existing panel).

States to handle: no analysed pages yet (explain and link back to search), pages not yet labelled, label in progress, analysis failed on a page.

### 4. ICP generation

New module `src/lib/pipeline/icp.ts`. Input: the user's `BusinessProfile` (service, offerings, audience, market), the target awareness stage, and the competitor pages already labelled (to avoid copying the same angle). Output JSON, validated with zod:
- painPoints[], demographics{ ageRange, role, income/budget, location, other }, psychographics[], saysOutLoud[] (verbatim-style quotes), interests[], hopesAndDesires[], plus `stageNotes` (what this reader knows and what the page must do first) and `suggestedAngle`.
Stored per run and per stage. Stage-specific: a problem-aware ICP's "says out loud" is about the problem, a solution-aware one compares approaches.

### 5. Recreate for my brand

- From a page card: starts the existing Manus recreate for that competitor page unchanged (the existing flow, reached from the portal).
- From an ICP: starts the same recreate on the competitor page whose structure is closest (builder to choose a rule, e.g. highest-converting-looking or user picks one in a small picker), with the ICP and target stage added as a new section of `buildManusBrief`: rewrite headline, proof and CTA copy for this reader at this stage, keep layout.
- Result lands on the existing recreate page.

### 6. Exports and history

History and the full-run Excel export (`fullReportExcel.ts`) should include the two new labels per page. Builder to add columns; no new sheets required.

## Settled after builder review (my calls)

- **What "covered" means.** A stage is *covered* when at least one page's page-level (dominant) stage is that stage. A stage that only appears in some page's sections is shown as *Partly covered* (amber chip, still offers Generate ICP). A stage no page or section touches is *Missing*. Pages labelled `unclear` count toward nothing. The `focus` flag is display-only (it adds "only problem" / "only solution" text on the card) and does not change coverage. Expect Unaware and Problem-aware to be missing often; that is the intended opening the user wants surfaced.
- **What a "run" is.** The A/B tab has its own picker, defaulting to the search run currently open (or the latest). A lookup is its own source in the picker, with its own coverage and ICPs; lookup pages never mix into a search run. ICPs are stored in a new table keyed by organisation, source (search run id or lookup id) and stage, so they follow the same org scoping as run data. `recreateOnly` records are excluded from the page list, as they are from competitor lists.
- **Profile and brand.** ICP and recreate use the business profile and business URL already attached to the run, the same ones recreate uses today. If the profile is missing or too thin (no offerings and no audience), Generate ICP is disabled with "Add your business website first" instead of producing a generic ICP. ICP text shown to client admins passes through `maskClientFacingText` like other analysis text.
- **Labelling old pages.** The saved analysis keeps no outline or page text (verified: `LandingPageOfferAnalysis` and `db.ts` store only extracted fields). "Label now" therefore re-fetches the page and runs only the two label agents (no screenshots, no offer/architecture re-run). "Label all" shows the page count and asks the user to confirm before spending, then uses the concurrency pool.
- **Picking the page to recreate from an ICP.** Default is the competitor page already labelled closest to the target stage (nearest stage, then most ads running). A "Change page" link opens a plain list of the run's analysed pages. No separate picker screen.

## Constraints

- Prod build type-checks tests; gate pushes on `tsc`. Skip long builds in checks (user tests manually).
- Keep `maskClientFacingText` behaviour for any text shown to client admins.
- Client organisations share one Railway deploy: new data must be org-scoped like existing run data.
- Old saved analyses must keep loading (all new fields optional).
- Do not add a new AI provider; reuse the OpenRouter / Anthropic fallbacks already in `landingPageAnalysis.ts`.

## Left to the builder

- Exact prompts, models and the section-matching method.
- Concurrency number and queueing.
- Whether the verifier step is a separate call or code-only quote matching.
- Component structure, styling within the existing design language, DB column/table layout.
- Rule for picking the base competitor page when recreating from an ICP.
- Test coverage (add focused offline tests alongside the existing ones in `tests/`).
