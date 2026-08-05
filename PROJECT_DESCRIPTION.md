# AdRival — Project Description

**Product name:** AdRival  
**Package name:** `adrival`  
**Repository:** [DM-ai-tools/AdRival](https://github.com/DM-ai-tools/AdRival)  
**Type:** Full-stack web application (competitive ad intelligence + branded landing-page recreation)

---

## 1. What AdRival is

AdRival helps a business discover who is advertising against them, understand those competitors’ landing-page offers, and recreate a competitor-style landing page in **their own brand**.

In practical terms, AdRival does three jobs:

1. **Find advertising competitors** across Meta (Facebook / Instagram), Google, YouTube, and LinkedIn using ad-library data.
2. **Analyze competitor landing pages** to extract offer structure, messaging, page architecture, and related ads that share the same destination URL.
3. **Recreate the landing page** for the user’s brand: rewrite content, keep layout fidelity from a captured archive, swap brand colors/logos/links, generate new photos with AI, and preview an interactive HTML draft.

It is designed for marketers, agencies, and growth teams who want competitor intelligence that ends in a usable draft page—not just a spreadsheet of ads.

---

## 2. Who it is for

| Audience | Typical use |
|----------|-------------|
| Performance marketers | Find local / category rivals and see what offers they push |
| Agencies | Audit a client niche, then produce a branded LP draft inspired by a strong competitor layout |
| Founders / operators | Understand message patterns in their market and generate a first-pass landing page |

---

## 3. Core product capabilities

### 3.1 Competitor discovery (Search)

- User selects a platform (Facebook, Instagram, Google, YouTube, or LinkedIn).
- Optionally pastes a **business website URL**. AdRival analyzes the site to infer industry, offerings, audience, competitor keywords, locations, and brand assets.
- User supplies keywords and geo settings (country-wide, company locations, or keyword+location).
- The system searches ad libraries, filters weak/irrelevant advertisers, scores relevance, enriches brand signals (followers, etc.), and returns a ranked competitor list.
- Results can be exported to Excel. Search history is saved.

### 3.2 Known-brand lookup

- User looks up a known advertiser / brand and pulls their ads.
- Useful when you already know the competitor and want creatives + optional landing-page analysis.
- Lookup history is tracked alongside search history in a unified history view.

### 3.3 Landing-page analysis

- For a competitor (or lookup ad), AdRival fetches the destination page and extracts:
  - Offer summary and audience
  - Page architecture / section map
  - Messaging angles
  - Ads that land on the **same URL** (hooks + offers from those creatives)
- Analysis is stored on the competitor/ad record and shown in the UI.

### 3.4 Landing-page recreation (two-phase)

Recreation is intentionally human-in-the-loop:

1. **Content phase** — generate brand-differentiated copy as a coherent page document (sections, FAQs, links, logos notes). User reviews/edits and approves.
2. **Design phase** — paste approved copy into a Playwright-captured HTML archive of the competitor page, apply brand identity, generate AI photos, restore interactivity (e.g. FAQs), and preview the result.

Output is downloadable HTML (draft banner can be stripped for publish). Publish readiness is tracked with coverage/blocker notes.

---

## 4. End-to-end user journeys

### Journey A — Discover rivals from a business URL

```text
Enter business URL
  → Analyze business (industry, keywords, brand)
  → Choose platform + keywords + geo
  → Run competitor search
  → Review competitor table
  → Analyze a competitor landing page
  → Open Recreate flow
  → Review content document
  → Approve & build design
  → Preview interactive HTML + generated images
  → Download / iterate with feedback
```

### Journey B — Lookup a known advertiser

```text
Enter brand / company
  → Resolve candidates
  → Pull ads
  → Analyze landing page (optional)
  → Export or use insights
```

---

## 5. Technical overview

### 5.1 Stack

| Layer | Technology |
|-------|------------|
| Framework | **Next.js 15** (App Router), Turbopack in development |
| UI | **React 19**, Tailwind CSS 4, Google fonts (DM Sans + Fraunces) |
| Language | **TypeScript 5**, Node.js **≥ 20** (Docker uses Node 22 Alpine) |
| Validation | **Zod** |
| HTML parsing | **Cheerio** |
| Browser automation | **Playwright** (Chromium; installed via `postinstall`) |
| Visual QA | **pixelmatch** + **pngjs** |
| Spreadsheets | **exceljs** |
| Color extraction | **node-vibrant** (+ CSS/HTML heuristics) |
| Deploy | Docker standalone output, Railway-ready (`Dockerfile`, `railway.json`) |

### 5.2 External services

| Service | Role in AdRival |
|---------|-----------------|
| **SociaVault** | Ad Library search, company ads, social profile metrics |
| **OpenAI** | Ad relevance scoring, query expansion, content fallback, image briefs, design feedback |
| **OpenRouter → Perplexity Sonar** | Business URL industry analysis; landing-page analysis fallback |
| **Anthropic Claude** | Preferred landing-page analysis; Firecrawl-markdown content drafting; CID rewrite assist |
| **Firecrawl** | Branding scrape, site map/links, markdown scrape for content drafting |
| **Brandfetch** | Logos, brand palette, fonts |
| **RunwayML (GPT Image 2)** | Generate replacement photos for landing-page image slots |

### 5.3 Repository layout (simplified)

```text
src/
  app/                      # Next.js routes & API handlers
    page.tsx                # Main app: search / lookup / history
    recreate/[competitorId] # Content review + design preview UI
    api/                    # REST-style route handlers
  components/               # Search, tables, analysis panels, history
  lib/
    db.ts                   # JSON persistence
    types.ts                # Domain model
    sociavault/ openai/ openrouter/ anthropic/ firecrawl/ runway/
    pipeline/               # Business logic
      finder.ts, googleSearch.ts, linkedinSearch.ts, dispatch.ts
      landingPageAnalysis.ts, sameLandingPageAds.ts
      recreateLandingPage.ts, contentDraft.ts, markdownContentDraft.ts
      generateLandingImages.ts, resolveBrandBundle.ts, ...
      archive/              # Capture, CID paste, brand apply, interactivity
data/store.json             # Runtime database (gitignored)
public/generated/           # Runway image outputs per competitor
```

---

## 6. Architecture

AdRival is a **Node.js Next.js monolith**: UI and API live in one app. Heavy work runs in server route handlers (`runtime = "nodejs"`, often `maxDuration = 300`).

### 6.1 Request / job pattern

- **Search / lookup** start quickly and continue in the background using Next.js `after()`, while the client polls status endpoints.
- **Landing analysis** and **recreate** are longer synchronous API calls (up to several minutes) driven from the UI with loading states.
- State is persisted to a local JSON store so history survives restarts when the `data/` directory is mounted.

### 6.2 High-level system diagram

```text
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Browser UI  │────▶│ Next.js API      │────▶│ External APIs       │
│ (App Router)│◀────│ Route Handlers   │◀────│ SociaVault, LLMs,   │
└─────────────┘     └────────┬─────────┘     │ Firecrawl, Runway…  │
                             │               └─────────────────────┘
                             ▼
                    ┌──────────────────┐
                    │ data/store.json  │
                    │ public/generated │
                    └──────────────────┘
```

### 6.3 Recreation pipeline (design phase)

```text
Competitor LP URL
  → Playwright archive (HTML + inlined assets + screenshot)
  → Stamp text nodes with data-cid
  → Stamp brand logos (data-adrival-logo)
  → Inventory photo slots (data-adrival-gen-id)
  → Apply brand colors / fonts / links
  → Runway AI images into photo slots
  → Paste approved content by CID
  → Rebuild footer, inject FAQ/scroll runtime
  → Visual gate (optional pixel compare)
  → Preview in sandboxed iframe (srcDoc)
```

---

## 7. Major pipelines (detailed)

### 7.1 Competitor search

**Entry:** `POST /api/search` → `dispatchPlatformSearch`  
**Key files:** `src/lib/pipeline/dispatch.ts`, `finder.ts`, `googleSearch.ts`, `linkedinSearch.ts`, `openai/analyzer.ts`, `brandReview.ts`, `competitorLocation.ts`

**Typical steps:**

1. Expand / diversify search queries (OpenAI), including geo-qualified variants when location mode is set.
2. Call SociaVault Ad Library endpoints for the selected platform.
3. Filter candidates (active ads, duration floors, English copy, valid landing URLs, dedupe via `seenPageIds`).
4. Score ad/page relevance to the user’s keyword/industry (OpenAI); apply soft then relaxed thresholds to fill toward `TARGET_COMPETITORS` (default 10).
5. Prefer geo-local rivals when possible; hold geo mismatches as fill-only.
6. Enrich brands (followers / company signals via SociaVault).
7. Persist `SearchJob` + `CompetitorRecord` rows.

**Important constants** (see `src/lib/types.ts`): relevance thresholds, min active ads / duration by platform, max search pages, prefer-local cutoff.

### 7.2 Business URL analysis

**Entry:** `POST /api/business/analyze`  
**Key files:** `src/lib/openrouter/businessAnalyzer.ts`, `resolveBrandBundle.ts`, `brandAssets.ts`, `firecrawl/client.ts`

Produces a `BusinessProfile`: industry, offerings, audience, competitor keywords, locations, and attached brand colors / assets / design tokens used later in recreation.

### 7.3 Landing-page analysis

**Entry:** `POST /api/competitors/analyze-page` (or lookup equivalent)  
**Key files:** `landingPageAnalysis.ts`, `htmlFetch.ts`, `sameLandingPageAds.ts`

1. Fetch page HTML (direct fetch and/or Firecrawl fallback).
2. Build a heading / structure outline.
3. Prefer Claude for structured extraction; fall back to OpenAI / OpenRouter.
4. Attach same-landing-page ads (hooks + offers) from the advertiser’s creative set when available.

### 7.4 Content drafting (phase 1)

**Entry:** recreate API `action: generate_content` / `regenerate_content`  
**Key files:** `recreateLandingPage.ts`, `markdownContentDraft.ts`, `contentDraft.ts`, `extractPageTextSlots.ts`

**Preferred path (Firecrawl + Claude):**

1. Scrape competitor page markdown via Firecrawl.
2. In parallel, extract real text placements (CID slots) from a captured/stamped page.
3. Claude analyzes markdown into a **unified document** (meta, hero, features, FAQs, CTAs, links, logos) rewritten for the user’s brand.
4. Also fills CID block texts so design paste remains placement-accurate.
5. UI presents the document together (not only micro-block textareas). Edits sync back into blocks on save/approve.

**Fallback path:** OpenAI slot-by-slot drafting from architecture or page text slots if Firecrawl/Anthropic is unavailable.

### 7.5 Design build (phase 2)

**Entry:** recreate API `action: approve_and_build` / `regenerate_design`  
**Key files:** `archive/recreateFromArchive.ts`, `rewriteTextByCid.ts`, `mapApprovedContent.ts`, `applyBrandDeterministic.ts`, `generateLandingImages.ts`, `interactiveRuntime.ts`

**Design choices that matter:**

| Concern | Approach |
|---------|----------|
| Layout fidelity | Reuse Playwright archive instead of regenerating layout from scratch |
| Copy placement | Stable `data-cid` IDs map approved text 1:1 into nodes |
| Brand logos | Stamp `data-adrival-logo` **before** AI image inventory; logos win over AI |
| Photos | Inventory large content/hero images → Runway GPT Image 2 → embed by `data-adrival-gen-id` |
| SVG logos as AI refs | Skipped (Runway rejects SVG references); generation continues without logo ref |
| Interactivity | Inject runtime for FAQ/accordion/tabs/scroll-reveal under `srcDoc` |
| Failure fallback | Legacy `cloneLandingPage.ts` path if archive recreation fails (publish not ready) |

### 7.6 Image generation

**Key files:** `generateLandingImages.ts`, `runway/client.ts`

1. Inventory photo slots (skip logos, icons, partner strips, tiny UI chrome).
2. Ask OpenAI for per-slot creative briefs.
3. Generate images with Runway; store under `public/generated/{competitorId}/`.
4. Embed into stamped nodes; clear `<picture><source>` so `img src` actually shows.
5. UI can regenerate a single image with optional feedback.

---

## 8. Data model and storage

### 8.1 Persistence

- **Primary store:** `data/store.json` managed by `src/lib/db.ts`
- **Generated assets:** `public/generated/{competitorId}/*.png`
- **No traditional SQL database** in the default setup
- For production (Railway), mount a volume at `/app/data` so history survives deploys

### 8.2 Top-level collections

| Collection | Purpose |
|------------|---------|
| `jobs` | Search runs (keywords, platform, geo, business profile, progress, competitor IDs) |
| `competitors` | Accepted rivals + sample ad + optional analysis + recreation |
| `seenPageIds` | Global advertiser/page dedupe across runs |
| `lookupJobs` | Brand lookup runs |
| `lookupAds` | Ads returned from lookup |

### 8.3 Recreation object (on a competitor)

`CompetitorRecord.recreatedPage` roughly tracks:

- Status: `pending` → `content_ready` → `design_pending` → `completed` | `failed`
- `contentDraft`: blocks + optional unified `document`, model used, CID coverage
- `sourceArchive`: stamped HTML locked for design paste
- Final `html`, `generatedImages[]`, `brandColors`
- Publish readiness / blockers / differentiation notes

---

## 9. API surface

| Route | Purpose |
|-------|---------|
| `POST /api/search` | Start competitor search |
| `GET /api/search/status` | Poll search job + competitors |
| `POST /api/lookup` | Start brand lookup |
| `GET /api/lookup/status` | Poll lookup + ads |
| `POST /api/lookup/analyze-page` | Analyze a lookup ad’s landing page |
| `GET /api/lookup/export` | Excel export for lookup |
| `GET/DELETE /api/lookup/history` | Lookup history |
| `POST /api/business/analyze` | Business URL → profile + brand bundle |
| `GET /api/competitors` | Fetch competitors |
| `POST /api/competitors/analyze-page` | Analyze competitor landing page |
| `GET/POST /api/competitors/recreate-page` | Load / generate content / save / build design / regenerate image / refresh colors |
| `GET /api/export` | Competitors Excel |
| `GET/DELETE /api/history` | Search history |
| `GET/DELETE /api/history/unified` | Combined history |
| `GET/POST /api/admin/import-history` | Secret-gated store import |
| `GET /api/health` | Healthcheck |

### Recreate POST `action` values

| Action | Meaning |
|--------|---------|
| `generate_content` | Create content draft (cached if already ready) |
| `regenerate_content` | Force new content draft |
| `save_content` | Persist document/block edits |
| `approve_and_build` / `build_design` / `regenerate_design` | Fit content into design + images |
| `refresh_brand_colors` | Re-resolve brand palette |
| `regenerate_image` | Regenerate one Runway slot |

---

## 10. Environment variables

| Variable | Required for | Description |
|----------|--------------|-------------|
| `SOCIAVAULT_API_KEY` | Search / lookup | SociaVault API access |
| `OPENAI_API_KEY` | Search scoring, fallbacks, briefs | OpenAI access |
| `OPENROUTER_API_KEY` | Business URL analyze | OpenRouter → Perplexity |
| `OPENROUTER_MODEL` | Optional | Defaults to `perplexity/sonar` |
| `ANTHROPIC_API_KEY` | Preferred analysis + content draft | Claude access |
| `ANTHROPIC_MODEL` | Optional | Defaults to `claude-sonnet-4-5` |
| `OPENAI_CONTENT_MODEL` / `OPENAI_MODEL` | Optional | Content-pack model override (default `gpt-4.1`) |
| `FIRECRAWL_API_KEY` | Branding, markdown content, links | Firecrawl access |
| `BRANDFETCH_API_KEY` | Logos / palette | Brandfetch access |
| `RUNWAYML_API_SECRET` | AI landing photos | Runway access |
| `NEXT_PUBLIC_APP_URL` | Absolute image URLs in HTML | e.g. `http://localhost:3000` |
| `HISTORY_IMPORT_SECRET` | Admin import only | Bearer secret; remove after use |
| `PORT` / `HOSTNAME` | Deploy | Railway injects `PORT` |

Local setup:

```bash
npm install
cp .env.example .env.local   # or .env.local.example if present
# fill keys
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## 11. Frontend structure

| Area | Location | Role |
|------|----------|------|
| Home shell | `src/app/page.tsx` | Tabs/modes: search, lookup, history |
| Search UI | `SearchForm`, `CompetitorTable` | Launch/search results |
| Lookup UI | `LookupForm`, `LookupResults` | Known-brand ads |
| Analysis UI | `PageAnalysisPanel` | Offer + architecture + same-LP ads |
| Recreate UI | `src/app/recreate/[competitorId]/RecreatePageClient.tsx` | Content document review + design iframe + image gallery |
| History | History components + `historyUnified.ts` | Past search/lookup runs |

Design preview uses a sandboxed iframe with `srcDoc={html}` so the draft runs without navigating away. Scripts are allowed so FAQ/accordion runtime can work.

---

## 12. Design principles and constraints

1. **Structure from competitors, messaging from the brand**  
   Layout and section rhythm come from the competitor archive; copy is rewritten for the user’s brand and keyword—not a copy-paste of competitor claims.

2. **Human approval before design**  
   Content is reviewed as a coherent document before expensive design/image work runs.

3. **CID fidelity over free-form HTML rewriting**  
   Text placements are stamped and replaced by ID so headlines, buttons, and FAQ answers land in the right nodes.

4. **Logos ≠ photos**  
   Site logos are brand-swapped; photo slots are AI-generated. Partner/press logo strips are left alone (not converted into AI scenes or forcibly replaced with the brand mark).

5. **Interactive preview matters**  
   Archived pages often lose original JS; AdRival injects a lightweight runtime so FAQs and common reveal patterns still work in preview.

6. **JSON store simplicity**  
   Fast to ship and deploy, but not multi-writer SQL. Suitable for single-instance / volume-backed deployments.

7. **Long jobs need Node runtime**  
   Playwright + multi-API pipelines are not edge-friendly; routes explicitly use the Node.js runtime.

---

## 13. Deployment notes

- Production build uses Next **standalone** output.
- Railway: use Dockerfile + `railway.json`; bind `0.0.0.0:$PORT`.
- Persist `data/` with a volume at `/app/data`.
- Import local history with `scripts/import-history.mjs` and `HISTORY_IMPORT_SECRET`.
- Ensure Chromium is available wherever archive capture / visual gate runs (`npm run playwright:install` / Docker deps).
- Set `NEXT_PUBLIC_APP_URL` to the public origin so generated image URLs resolve correctly inside preview HTML.

---

## 14. Current product status (summary)

AdRival is an operational internal/product tool with:

- Multi-platform competitor search and lookup
- Landing-page offer/architecture analysis (including same-URL ads)
- Two-phase recreation: Firecrawl+Claude content documents → archive-based branded design
- Runway image replacement with logo/photo separation
- Interactive HTML preview and Excel export
- Local JSON persistence and Railway/Docker deployment path

Primary follow-on engineering themes (for future work) typically include stronger multi-tenant storage, richer publish pipelines, and broader visual regression coverage—without changing the core “find → analyze → recreate” product loop.

---

## 15. Quick glossary

| Term | Meaning |
|------|---------|
| **CID** | Content ID (`data-cid`) stamped on text nodes for precise paste |
| **Archive** | Self-contained HTML capture of a competitor page (Playwright) |
| **Content draft** | Reviewed copy pack before design build |
| **Document** | Unified section-level content view (FAQs, links, prose) |
| **Gen slot** | Photo placement stamped with `data-adrival-gen-id` for AI images |
| **Logo stamp** | Brand mark placement stamped with `data-adrival-logo` |
| **srcDoc** | iframe preview mode that injects HTML string directly |
| **SociaVault** | Third-party Ad Library / social scraping API used for discovery |

---

*This document describes the AdRival codebase as implemented in the Competitor Finder / AdRival repository. For short setup instructions, see `README.md`.*
