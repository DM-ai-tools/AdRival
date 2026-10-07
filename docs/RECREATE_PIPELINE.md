# Landing page recreation

Recreation is done by the **Manus design agent** (Manus API v2, https://open.manus.ai/docs/v2). The earlier built-in pipeline (Playwright capture, blueprint, Claude section writing, Runway images, design check) was removed on 2026-10-07. It is kept on the git branch `backup/both-recreate-pipelines-2026-10-07` (tag `backup-before-old-recreate-removal-2026-10-07`).

## Flow

1. **Brief** (`src/lib/pipeline/manus/brief.ts`). Built from the competitor's page analysis, the search keywords and the client's business profile. It names the one service the page sells (searched keywords and the competitor's offer), quotes the competitor's headline, offer and call to action as meaning references, and carries the rules: keep every section, layout, measured sizes and logo strips; replace wording (same meaning, different words, client's brand voice), logo (sharpest file), proof logos, colours, fonts, images and links; never copy wording or invent facts; compare at 1440px and 390px before delivering. The full brief is attached as `brief.md` (the message text is capped at about 5,000 tokens).
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
