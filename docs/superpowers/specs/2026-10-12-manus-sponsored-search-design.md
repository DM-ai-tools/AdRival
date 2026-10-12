# Google / YouTube keyword search through Manus sponsored results

Date: 2026-10-12. Status: implemented (user approved the design and asked to go ahead without reviewing this spec).

## Goal

Google and YouTube keyword searches find competitors from **Google's sponsored results** instead of organic web results. A Manus agent (profile `lite`, Manus 2.0 lite) opens Google in the run's country for each keyword, collects the Sponsored advertisers and checks each advertiser's domain in the Google Ads Transparency Center for that country. Advertisers with ads go to SociaVault, and the existing pipeline carries on: ad fetch, AI review, guardrails, save. Each run still aims for 10 competitors.

## Decisions (from the user)

- 10 per run, as today (one industry/category per run).
- YouTube runs use the same Google SERP. The Transparency link is filtered to YouTube (`platform=YOUTUBE`) and only video ads count.
- Country follows the run (AU for current clients). `geo=all` uses AU for the agent. City/suburb runs keep the ring order (nearby → wider → state → country).
- Short of 10: ask Manus for more (page 2, a reload, wider queries), then fill with today's Firecrawl + Transparency name search.

## Design

- `src/lib/pipeline/manusSearch.ts`
  - Builds the brief (Google URL with `gl`/`hl=en`/`pws=0` on the country's Google host; Transparency URL `?region=<CC>&domain=<d>`).
  - Parses the agent's `FOUND {json}` / `NOADS {json}` lines.
  - Defines the structured-output schema used as the final list.
  - `SponsoredSearchAgent`: one Manus task per run, each step as a follow-up message to it. It polls events every 10 s, streams new finds to the caller, settles questions and confirmations, and stops the task when the run stops or the list is full.
- `src/lib/manus/events.ts`: feed and confirmation helpers shared with the recreate pipeline (moved out of `pipeline/manus/run.ts`).
- `googleSearch.ts`
  - Each step runs through the agent first. If the agent fails (API error, credits, timeout, Google blocked every search), that step and the rest use the web search.
  - After every agent step has run, a short list is filled by the web search's country-wide steps.
  - Sponsored domains go through `checkWebDomains(…, "sponsored")`, which has its own budget of 60 SociaVault checks.
  - The sponsored ad's headline and text are kept as the snippet, for ads whose text SociaVault cannot read.
- Live progress
  - New stage `searching_sponsored` ("Reading sponsored results") shows the agent's latest action.
  - New progress field `sponsored {checked, withAds, searches, status}`, shown as "Sponsored advertisers x/y".
  - New reject reason `sponsoredNoAds`.
  - `job.manusSearch {taskId, taskUrl}` is kept for debugging.
- Settings
  - On when `MANUS_API_KEY` is set; `MANUS_SEARCH=off` turns it off.
  - `MANUS_SEARCH_PROFILE` (default `lite`).
  - `MANUS_SEARCH_TIMEOUT_MINUTES` per step (default 20).

## Known limits

- Google shows sponsored results by the searcher's IP. The Manus browser is likely outside Australia, so it may see fewer ads or a CAPTCHA. The `gl`/country host settings and the web-search fallback cover this, but how much it matters is only known after real runs.
- Manus calls are not metered in the app's credit ledger (same as recreate).
- A server restart mid-run leaves the Manus task running until its current step ends. Search runs are not resumed.

## Tests

- `tests/manusSearch.test.ts`: line parser, brief URLs, streaming, follow-up step, stop, failed start.
- `tests/manusGoogleSearch.test.ts`: a full Google run with fake Manus, SociaVault and AI review. The sponsored advertiser is fetched for AU, reviewed and saved; the no-ads one never reaches SociaVault; the web search fills the rest.
