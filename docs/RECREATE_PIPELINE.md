# Landing page recreation

Recreation is done by the **Manus design agent** (Manus API v2, https://open.manus.ai/docs/v2). The earlier built-in pipeline (Playwright capture, blueprint, Claude section writing, Runway images, design check) was removed on 2026-10-07. It is kept on the git branch `backup/both-recreate-pipelines-2026-10-07` (tag `backup-before-old-recreate-removal-2026-10-07`).

## Flow

1. **Brief** (`src/lib/pipeline/manus/brief.ts`). Built from the competitor's page analysis, the search keywords and the client's business profile. It names the one service the page sells (searched keywords and the competitor's offer), quotes the competitor's headline, offer and call to action as meaning references, and carries the rules: keep every section, layout, measured sizes and logo strips, and recreate the competitor's animations, interactions and distinctive effects in the client's colours (vanilla CSS/JS or a pinned CDN library; content visible without JavaScript; reduced motion respected); colour each role (primary/secondary buttons, bands, tiles, header, footer) with the colours the client's live site uses for that role, reported as `brand.colour_map`; replace wording (same meaning, different words, client's brand voice), logo (sharpest file), proof logos, colours, fonts, images and links; never copy wording or invent facts; compare at 1440px and 390px before delivering. The full brief is attached as `brief.md` (the message text is capped at about 5,000 tokens).
2. **Task** (`src/lib/pipeline/manus/run.ts`, `src/lib/manus/client.ts`). `task.create` in the Manus project `MANUS_PROJECT_NAME` (default "redeisgn pipeline", or `MANUS_PROJECT_ID`), with the Firecrawl and OpenAI connectors (`MANUS_CONNECTORS`), agent profile `MANUS_AGENT_PROFILE` (default `standard`), interactive mode and a structured-output report. Screenshots the user pastes go with it as image files.
3. **Following it.** `task.listMessages` every 10 s. The agent's notes and actions become the live feed (`progress.details.activity`) and the progress bar (only moves forward). Questions are answered by the fast OpenAI model (`answer.ts`), with a default answer when it cannot be reached. Confirmations are settled automatically; deploying, publishing, secrets and account actions are declined. The task id is saved on the page, so after a restart the next page load resumes following it. Time limit: `MANUS_TIMEOUT_MINUTES` (default 90).
4. **Result.** The attached `index.html` is downloaded, files it refers to by relative path and remote images are embedded. A photo used more than once (`imageCheck.ts`; the logo, icons and SVGs may repeat) sends the page back to the agent once to replace the repeats. Images come from the user's uploads, then the client's site, and are generated only where neither fits. Then the page is checked: the competitor's name or domain left in it, a hero that does not name the searched service, sections the agent could not match, and anything it reported as unresolved become review notes.
5. **Changes.** "Apply changes" continues the same Manus task with the request (and screenshots); "Regenerate page" starts a new task. Both keep the previous page for Undo.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `MANUS_API_KEY` | (required) | Manus API key |
| `MANUS_PROJECT_NAME` | `redeisgn pipeline` | Manus project (folder) for the tasks; empty turns it off |
| `MANUS_PROJECT_ID` | | Exact project id; overrides the name |
| `MANUS_CONNECTORS` | `Firecrawl,OpenAI` | Connectors switched on for each task (names or ids) |
| `MANUS_AGENT_PROFILE` | `standard` | `standard`, `lite` or `max` |
| `MANUS_TIMEOUT_MINUTES` | `90` | Run time limit |

## Recreate hub, queue and versions

- **Versions.** Each recreation is its own version record: a competitor-page record with `recreateOnly.variantOf` pointing at the page it recreates, so the same page can be recreated for different businesses without overwriting earlier work.
- **The version's own business.** When a job's website is not the search's own (compared by host without `www.` and path; scheme, query and trailing slash ignored), the build first analyses that website into a full business profile (`analyzeBusinessProfile` in `src/lib/pipeline/businessProfile.ts`, the same analysis as the New Search form, billed inside the job's credit reservation) and writes the brief's name, colours, logo, services and offers from it; a website that cannot be read fails the job before anything is built. The profile is saved on the version (`recreateOnly.businessProfile`), so its retries, rebuilds, changes and resumed runs reuse it without paying again, and the search's own business is never changed.
- **Queue.** The `recreate_jobs` table (`src/lib/data/recreateJobs.ts`) holds queued and running jobs. The dispatcher in `src/lib/pipeline/recreateQueue.ts` (`dispatchRecreateQueue`) starts queued jobs on the server whenever a slot frees, so it does not depend on the browser being open. `sweepRecreateQueue` picks work up again on server startup (`src/lib/data/startup.ts`) and on every list GET. `stopRecreateJob` stops a job and frees its slot.
- **Limit.** Recreate builds have their own limit of 3 per user (`maxConcurrentRecreationsPerUser`, admin setting, default 3). The scope is decided in `src/lib/accounting/scope.ts` (`scopeOf`: only `recreate.generate_page` counts as `recreate`), so builds never block searches or other paid tasks. `edit_page` stays on the shared limit.
- **API.** `POST /api/recreate/jobs` adds pages (starts them, or queues them when the 3 slots are taken); `GET /api/recreate/jobs` lists jobs and versions (and sweeps the queue); `DELETE /api/recreate/jobs/[id]` stops or removes a job.
- **Archive.** Finished pages are flagged archived 14 days after finishing (`ARCHIVE_AFTER_DAYS` in `src/lib/recreateList.ts`). The flag is computed when the list is read; nothing is ever deleted. The hub's Archived filter shows them.
- **Navigation.** Top-level tabs are Find, Recreate and History (`src/lib/navModes.ts`); Find holds search, lookup and A/B.
