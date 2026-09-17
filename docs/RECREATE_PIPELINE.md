# Recreate for my brand — current setup

This file describes what the app does today, from the moment someone clicks **Recreate for my brand** until a landing page can be copied or downloaded.

The work has two phases:

1. **Content** — write the words for your brand.
2. **Design fit** — drop those approved words into a page layout, add brand colors, and generate photos.

The competitor page supplies structure. Your brand supplies the name, colors, links, and wording. The page is saved on the competitor record as `recreatedPage`. It is not a separate document store.

---

## 1. What has to exist before the button appears

The button is not shown until landing-page analysis for that competitor or ad is **completed**.

| Starting point | Button location | Extra requirement |
| --- | --- | --- |
| Keyword search | Competitor row, under **Get offer & page details** | The search run must already have a business website URL |
| Competitor lookup | On an ad, after analysis | You must have saved your brand website on that lookup |

If either is missing, the recreate page refuses to start and explains which one.

The link opens `/recreate/{competitorId}` in a new tab.

From a **lookup**, the app first builds a hidden search-shaped record so the same recreate page can run:

- A search job id of `lookup-recreate-{lookupId}`
- A competitor id of `lookup-ad-{adId}` (or an id already stored on that ad)
- That bridge job copies the lookup’s business URL, brand profile, owner, and the completed page analysis

After that, lookup and search follow the same pipeline.

---

## 2. Opening the recreate page

The page loads with `GET /api/competitors/recreate-page?competitorId=…`.

That returns:

- The competitor
- `recreatedPage` if one already exists
- `pageAnalysis` (the offer and page structure already analyzed)

Nothing is charged just to open the page. A poll continues while status is `pending` or `design_pending`, so a refresh still shows progress.

The header shows:

- **Recreate for my brand**
- Which competitor inspired it
- The keyword, if the search had one
- Your business website

Two phase chips: **1 Content**, then **2 Design fit**.

---

## 3. Phase 1 — content creation

The user clicks **Regenerate content**, or **Regenerate content with feedback** if the left box is filled. Feedback is capped at 4,000 characters and is applied only on regenerate, not saved as a silent edit.

The request is:

`POST /api/competitors/recreate-page` with `action: generate_content` or `regenerate_content`.

The person who clicks is charged (`recreate.generate_content`). A viewer of a shared space cannot run this.

If content is already ready and there is no feedback and no force flag, the server returns the saved draft and does not call the models again.

### 3.1 Checks

The server stops immediately if:

- Page analysis is not completed
- The search (or lookup bridge) has no business website URL

The brand name is taken from the site name, then the profile name, then it will not use the competitor name as your brand.

A default palette is used only until real colors are read:

- Primary `#0F7A6C`
- Secondary `#134E4A`
- Accent `#F59E0B`
- Background `#FFFFFF`
- Text `#0F172A`
- Muted `#64748B`

### 3.2 Read your brand

Progress: **Analyzing your brand colors & assets…** (about 12%).

`resolveBrandBundle` reads the business website. It prefers Firecrawl branding (colors, fonts, logo, spacing, buttons). Brandfetch fills gaps. The result is stored as the brand colors and site assets used later. If this step fails, the draft continues with whatever colors were already on the search profile.

### 3.3 Collect your real links

Progress: **Collecting brand nav, footer & service links…** (about 28%).

Firecrawl maps the business site for navigation, footer, social, and service-page URLs. Those links are meant to replace the competitor’s menu and footer, not copy them. If the scrape fails, a note is stored and content generation still continues.

### 3.4 Draft the words

Progress: **Scraping competitor page & drafting full-page content for your brand…** (about 48%).

The preferred path runs only when both `FIRECRAWL_API_KEY` and `ANTHROPIC_API_KEY` are set.

1. **Scrape the competitor page** with Firecrawl markdown. If the markdown is shorter than 80 characters, this path stops.
2. **In parallel, extract text slots** from the competitor HTML. Each visible text placement gets a CID (`data-cid`). That list is the inventory the design step will paste into later. Slot extract can fail; drafting still continues, but the design paste will be weaker.
3. **Build a scaffold** from those slots plus your brand links (nav, footer, social, service pages). Each slot has a role, a length budget, and the original competitor text.
4. **Claude** (`ANTHROPIC_MODEL`, default `claude-sonnet-4-5`) rewrites the page. It receives:
   - Your brand name, URL, industry, offerings, audience, positioning
   - Your nav, footer, social, and service links
   - The competitor offer analysis (headline, offer, audience, summary) as topic hints, not as copy to keep
   - Up to 55,000 characters of competitor markdown
   - The CID inventory
   - Locked keywords from the search keyword, competitor keywords, and offerings
   - The feedback box, if any, marked as highest priority
5. The model must return JSON only:
   - A **document** the review screen shows (page title, meta description, sections, FAQ pairs, links, logos)
   - A **blocks** list, one text string for every CID
6. Rules baked into the prompt:
   - Do not name the competitor
   - Do not keep three or more consecutive words from their copy, except locked keywords
   - Do not invent licence numbers, fake endorsements, or regulated claims
   - Keep link destinations exactly; only polish the label
   - Finish sentences; do not cut mid-thought
7. The app maps FAQ answers and meta title/description back onto the matching CIDs, clips text to each slot’s length budget, and saves a draft with status **ready**.

The archive from step 2 is saved as `sourceArchive` so design does not have to recapture the page if coverage is good enough.

### 3.5 Fallback content path

If Firecrawl or Claude is missing, or that path throws, the app falls back to `generateLandingContentDraft`.

That path:

1. Extracts the same competitor text slots
2. Calls an OpenAI-compatible model
   - OpenRouter model `openai/gpt-4.1` when `OPENROUTER_API_KEY` is set (`OPENROUTER_OPENAI_CONTENT_MODEL` can override it)
   - Otherwise direct OpenAI, model `OPENAI_CONTENT_MODEL`, `OPENAI_MODEL`, or `gpt-4.1`
3. Writes one block per slot rather than a full markdown document first
4. Builds a review document from those blocks afterward

If this path returns no archive, design will capture the competitor page again later.

### 3.6 What is saved

Status becomes `content_ready`. The record holds:

- Brand colors
- Content draft (document + CID blocks + model name + feedback)
- Source archive, when slot extract worked
- A short differentiation note (summary, archive CID count, link counts)
- Progress **Content ready for review**

If generation throws, status becomes `failed` and the error is stored on both the page and the draft. The user sees a message with vendor and API key names removed.

---

## 4. Reviewing and changing the words

The review form is the document, not the raw CID list. The user can edit:

- Page title
- Meta description
- Each section heading and body
- FAQ questions and answers

**Save edits** calls `action: save_content`. This does not call a model and does not build HTML. It writes the form back into the CID blocks so the later paste uses the edited words. Draft status stays `ready`. Page status stays `content_ready`.

**Feedback for content** is not applied by Save. It is sent only when the user regenerates content. Regenerate replaces the draft. Unsaved typing is lost unless it was saved or pasted into the feedback box.

The design feedback box is ignored during content generation.

---

## 5. Phase 2 — design fit

The user clicks **Approve & build design**, or **Rebuild design** / **Rebuild design with feedback** if a design already exists. Rebuild asks for confirmation because it replaces the current HTML and the generated photos.

The request is `action: approve_and_build` (the UI also accepts `build_design` and `regenerate_design` on the server). It sends the current blocks, the document, and the **design feedback** box (again capped at 4,000 characters).

Charged as `recreate.build_design`.

The server marks the draft **approved**, sets page status to `design_pending`, clears the old HTML, and starts the design pipeline.

Design feedback does not rewrite the offer strategy. It adjusts how approved sentences are fitted into the layout (emphasis, headings, CTA strength). Content feedback is not re-applied here unless it was already baked into the approved draft.

### 5.1 Preferred path — archive fit

`recreateFromArchive` does this, in order:

1. **Page HTML.** Reuse the archive captured during content (`sourceArchive`) when it exists. Otherwise capture the competitor URL again and stamp CIDs on text nodes.
2. **Brand tokens.** Read colors, fonts, logo, and button styles from the business website. Build a design spec and write `design.md` for this run. That file is the style source of truth. Competitor CSS does not set your colors.
3. **Brand links again.** Refresh nav, footer, and social URLs from the business site so the footer is yours.
4. **Logo fallback.** If no logo was found, try Clearbit, a Google favicon, then a DuckDuckGo icon for the domain.
5. **Name swap.** Replace the competitor name in the HTML with your brand name.
6. **Logo first.** Stamp the brand logo onto logo marks before any image generation, so those marks are not treated as photos to redraw.
7. **Photo slots.** Inventory remaining images (hero, backgrounds, content photos). Logo slots are skipped.
8. **Apply brand styling.** Colors, type, and button styles from the design spec are written into the HTML.
9. **Generate photos.** For each remaining slot, a model writes an image prompt (it can look at a competitor screenshot when one exists). Runway (`RUNWAYML_API_SECRET`, GPT Image 2) renders the photo. Prompts must not mention the competitor or invent a different logo. If a brand logo reference exists, signage in the scene is told to use that logo. Failed slots are noted; they do not abort the whole page. Images are saved under the app’s generated-image path and embedded into the HTML.
10. **Paste approved words.** Each approved CID block is matched to a stamped node. Design feedback, if present, revises those replacement strings before paste. Unmatched competitor sentences can remain. Coverage is counted. The low-coverage rewrite that invents extra lines is off unless `allowLowCoverageFit` is set; the recreate call does not set it.
11. **Meta and links.** Page title, description, nav labels, and internal links come from the approved draft.
12. **Contacts and footer.** Phone, email, and address from your brand replace leftover competitor “Call …” lines. The footer is rebuilt from your links. A disclaimer from the approved draft is used when one exists. Photos are embedded again after the footer pass so they are not dropped. Logos are applied last so they are not replaced by generated scenes.
13. **Draft banner.** A sticky bar is inserted: “AdRival draft … Remove banner on Publish.” **Download HTML** strips that banner. Copy HTML in the page follows the same download path.
14. **FAQ and interactivity.** FAQ blocks are marked so they can expand. A small runtime script is injected for that behavior.
15. **Visual check.** The page before copy and the page after copy are compared. If section density shifts past the threshold (0.18), a note is added. The page is still saved. The note tells the user to review layout before publishing.
16. **Publish readiness.** The page is marked not publish-ready when CID coverage is under 85%, the visual gate failed, or image generation failed. Those reasons are stored as `publishBlockers`. Download still works.

On success, status becomes `completed`. The record holds HTML, generated images, brand colors, `design.md`, coverage, and differentiation notes.

Progress messages during this phase include **Fitting approved content into the page design…** and **Capturing layout & applying brand content + images…**.

### 5.2 Fallback path — legacy clone

If the archive path throws, the server does not fail the whole job yet. It logs the failure and runs `cloneAndAdaptLandingPage`.

That older path:

1. Resolves the brand bundle again
2. Fetches the competitor HTML
3. Rewrites sections with Claude
4. Applies your logo, links, colors, and contact details
5. Checks the rewritten HTML and tries to repair copy that still looks like the competitor

The result is still saved as `completed`, but:

- Generated images are empty
- `publishReady` is false
- A blocker says **Legacy clone fallback — review carefully**
- The differentiation note starts with **Legacy clone fallback**

If this fallback also throws, status becomes `failed`, HTML is cleared, and the approved content draft is kept so the user can try again without regenerating the words.

---

## 6. After the design exists

The preview is an iframe of the saved HTML.

| User action | What the server does |
| --- | --- |
| View design / Edit content | Local only. Switches the form and the preview. |
| Copy HTML / Download HTML | Uses the saved HTML. Download removes the draft banner. No new model call. |
| Re-analyze brand colors | `refresh_brand_colors`. Scrapes the business site again and updates colors, assets, and design tokens on the job and the recreate record. Does **not** rebuild HTML. Charged. |
| Apply colors to design | The same as rebuild design. Confirms, then runs phase 2 again. |
| Regen notes + regenerate on one image | `regenerate_image`. Runway redraws that one slot. The new file is swapped into the saved HTML. Other photos stay. Charged. |
| Download / Download all | Saves the generated image files. No new model call. |
| Brand design.md | Read-only. Shows the brand file for this run. Competitor pages supplied layout only. |

Design feedback on a rebuild keeps the approved words as the source, then refits them. It does not start phase 1 again.

---

## 7. Status values

| Status | Meaning |
| --- | --- |
| `pending` | Content generation has started |
| `content_ready` | Words are ready to review. No design yet, or an older design was left behind until rebuild |
| `design_pending` | Approved words are being fitted into the layout |
| `completed` | HTML is saved |
| `failed` | The last step threw. The error is on the page record |

The competitor table label changes with status: **Recreate for my brand**, **Review content draft**, or **View recreated page**.

---

## 8. What is charged

| Action | Charged |
| --- | --- |
| Open the recreate page | No |
| Save edits | No |
| Copy or download HTML or images | No |
| Generate or regenerate content | Yes, to the person who clicked |
| Approve and build, or rebuild design | Yes |
| Re-analyze brand colors | Yes |
| Regenerate one image | Yes |

A shared viewer cannot run any charged action. An editor can. The charge uses that person’s allowance, not the space owner’s. Admins are not blocked by allowance, but usage is still recorded.

A low balance returns: “Your credit balance is too low to run this task. Please contact your administrator.” The main app does not show vendor or API key names in that error.

---

## 9. What the two feedback boxes do

| Box | When it is used | What it changes |
| --- | --- | --- |
| Feedback for content | Only on regenerate content | Replaces the word draft. Highest priority in the content prompt. |
| Feedback for design | On approve, build, or rebuild | Keeps the approved words, then adjusts how they sit in the layout |

Save edits never sends either box.

---

## 10. End-to-end order

1. Analyze the competitor landing page.
2. Have a business website on the search, or a saved brand website on the lookup.
3. Click **Recreate for my brand**.
4. The page loads any existing draft. It does not generate until asked.
5. Content: brand colors, brand links, competitor scrape, CID slots, Claude document (or the OpenAI slot fallback).
6. Review and save edits, or regenerate with content feedback.
7. Approve and build design.
8. Design: reuse or recapture layout, apply brand design.md, generate Runway photos, paste approved CIDs, rebuild footer, embed images, add the draft banner, run the visual check.
9. If that design path fails, the legacy Claude clone runs instead and is marked for review.
10. Preview, fix single photos if needed, download HTML.
