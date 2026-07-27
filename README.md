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
```

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
| `HISTORY_IMPORT_SECRET` | No | Bearer secret for `/api/admin/import-history` (remove after importing) |

### Import local history into production

Local history lives in `data/store.json` (gitignored). After deploy:

1. Attach a Railway volume at `/app/data` (so history survives redeploys)
2. Set `HISTORY_IMPORT_SECRET` on the Railway service and redeploy
3. From this machine:

```bash
node scripts/import-history.mjs --url https://YOUR-APP.up.railway.app --secret YOUR_SECRET
```

Use `--mode merge` to keep any production-only rows. Default is `replace`.
Remove `HISTORY_IMPORT_SECRET` from Railway when finished.

Deploy options:

1. **Dockerfile (recommended)** — Railway uses `Dockerfile` + `railway.json`
2. **Local Docker** — `docker compose up --build` (pass env via shell or `.env`)

```bash
npm run build
npm run start
```

Persist note: job history is stored under `data/store.json` (created at runtime). Attach a Railway volume at `/app/data` if you need persistence across deploys.

Repo: [DM-ai-tools/AdRival](https://github.com/DM-ai-tools/AdRival)

## SociaVault endpoints used

| Purpose | Endpoint |
|---------|----------|
| Keyword ad search | `GET /v1/scrape/facebook-ad-library/search` |
| Active ad count | `GET /v1/scrape/facebook-ad-library/company-ads` |
| Company metadata | `GET /v1/scrape/facebook-ad-library/search-companies` |
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

Most SociaVault calls cost **1 credit** each. Local persist is JSON under `data/store.json` (gitignored).
