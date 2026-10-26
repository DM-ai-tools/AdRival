# AdRival

Next.js competitive ad intelligence app. Finds marketing-agency competitors across Meta, Google, YouTube, and LinkedIn via [SociaVault](https://docs.sociavault.com/), scores them with OpenAI, then runs brand review and Excel export.

## Setup

```bash
npm install
cp .env.example .env.local
```

Add keys to `.env.local`:

```
SOCIAVAULT_API_KEY=sk_live_...
OPENAI_API_KEY=sk-...
DATABASE_URL=postgresql://...   # a local or scratch Postgres, never production
```

`npm run dev` needs a Postgres in `DATABASE_URL`. **Never point it (or any
local app) at the production database:** startup marks every running job as
failed and starts the archive and backup schedulers.

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production / Railway

Required environment variables (set in the Railway service):

| Variable | Required | Description |
|----------|----------|-------------|
| `SOCIAVAULT_API_KEY` | Yes | SociaVault API key |
| `OPENAI_API_KEY` | Yes | OpenAI API key (ad scoring / query expansion) |
| `OPENROUTER_API_KEY` | Yes* | OpenRouter key for Perplexity Sonar business URL analysis (`*` required for URL analyze) |
| `OPENROUTER_MODEL` | No | Defaults to `perplexity/sonar` |
| `PORT` | Auto | Injected by Railway (app binds `0.0.0.0:$PORT`) |
| `SESSION_SECRET` | Yes (prod) | HMAC secret for session cookies |
| `ADMIN_BOOTSTRAP_TOKEN` | First admin only | One-time secret for `/setup`. Remove after bootstrap. |
| `ADMIN_BOOTSTRAP_USERNAME` | First admin only | Username created or promoted as the first admin |
| `HISTORY_IMPORT_SECRET` | No | Bearer secret for `/api/admin/import-history` (remove after importing) |
| `DATABASE_URL` | Yes | Postgres (Supabase transaction pooler, port 6543). All app data lives here. |
| `DATABASE_DIRECT_URL` | Recommended | Session/direct connection (port 5432) for migrations at start; falls back to `DATABASE_URL` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase Storage: archived recreated pages and database backups |
| `MAINTENANCE_MODE` | No | `1` answers every request except `/api/health` with 503 (cutover / maintenance window) |

All data (accounts, runs, competitors, credits, recreated pages) lives in
Postgres; see [docs/POSTGRES_OPERATIONS.md](docs/POSTGRES_OPERATIONS.md).
`data/store.json` was the store before the Postgres move (2026-10). It is now
only a source for the one-time import (`npm run import:store`) and the
rollback copy; the app no longer reads or writes it.

### Import local history into production

This copies runs from a store file (for example an old local
`data/store.json`, gitignored) into the running app's Postgres database:

**Never use the default `replace` mode against production after the Postgres
cutover:** it replaces the server's runs with the file's and wipes everything
created since. Use `--mode merge`, and remove `HISTORY_IMPORT_SECRET` when done.

1. Attach a Railway volume at `/app/data` (uploaded recreate assets live there)
2. Set `HISTORY_IMPORT_SECRET` on the Railway service and redeploy
3. From this machine:

```bash
node scripts/import-history.mjs --url https://YOUR-APP.up.railway.app --secret YOUR_SECRET
```

Use `--mode merge` to keep any production-only rows. Default is `replace`.

Imported runs keep an owner that exists on the server. Otherwise they are matched to the server account with the same username. Add `--owner <server username>` to give every run that still has no match (including runs with no owner at all) to that account, so they appear in its history:

```bash
node scripts/import-history.mjs --url https://YOUR-APP.up.railway.app --secret YOUR_SECRET --mode merge --owner your_admin_username
```

The response lists how many runs were kept, matched by username, given to the fallback owner, or left unmatched.
Remove `HISTORY_IMPORT_SECRET` from Railway when finished.

Deploy options:

1. **Dockerfile (recommended)** — Railway uses `Dockerfile` + `railway.json`
2. **Local Docker** — `docker compose up --build` (pass env via shell or `.env`)

```bash
npm run build
npm run start
```

Persist note: job history and all other data are stored in Postgres (`DATABASE_URL`). Keep the Railway volume at `/app/data`: uploaded recreate assets live there, and it holds the pre-Postgres `store.json` as the rollback copy. With the volume attached, Railway does not overlap deploys (the old container stops before the new one starts), so a failed deploy means downtime until it is fixed or rolled back.

Repo: [DM-ai-tools/AdRival](https://github.com/DM-ai-tools/AdRival)

## Multi-user, credits, and admin

See [docs/MULTI_USER.md](docs/MULTI_USER.md) for first-admin bootstrap, public
signup, credit conversion rules, project sharing, and legacy ownership
assignment.

```bash
npm test
```

## SociaVault endpoints used

| Purpose | Endpoint |
|---------|----------|
| Keyword ad search | `GET /v1/scrape/facebook-ad-library/search` |
| Active ad count | `GET /v1/scrape/facebook-ad-library/company-ads` |
| Company metadata | `GET /v1/scrape/facebook-ad-library/search-companies` |
| Account credit balance (admin) | `GET /v1/credits` |
| Facebook followers | `GET /v1/scrape/facebook/profile` |
| Instagram followers | `GET /v1/scrape/instagram/profile` |
| X followers | `GET /v1/scrape/twitter/profile` |
| YouTube subscribers | `GET /v1/scrape/youtube/channel` |
| LinkedIn employees | `GET /v1/scrape/linkedin/company` |
| Google advertisers | `GET /v1/scrape/google-ad-library/search-advertisers` |
| Google / YouTube ads | `GET /v1/scrape/google-ad-library/company-ads` |
| LinkedIn Ad Library | `GET /v1/scrape/linkedin-ad-library/search` |

Auth header: `X-API-Key`. See [SociaVault docs](https://docs.sociavault.com/).

## Credits note

SociaVault bills in its own credits (`GET /v1/credits` for remaining balance;
scrape responses may include `credits_used`). Application credits charged to
users are a separate, admin-configured conversion — one SociaVault credit is
not assumed to equal one Claude or GPT credit. Credit periods, reservations
and the ledger are stored in Postgres (before the 2026-10 move they lived in
`data/store.json`).
