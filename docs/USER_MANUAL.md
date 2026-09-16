# AdRival user manual

AdRival helps you find competitors who are advertising, understand the offers they are using, and then write a landing page for your own brand inspired by one of those competitors.

You sign in with a username and password. There is no email. Every search and lookup is saved inside a **client space** — a folder named after the client you are working for.

This guide follows the work in the same order you do it.

---

## 1. Sign in and your account

### Sign in

1. Open the app.
2. Enter your username and password.
3. Click sign in.

If an administrator just created your account, they will give you a temporary password. Sign in with that, then change it before you do anything else.

### Change your password

1. Open **Account** from the header.
2. Enter your current password and a new password.
3. Save.

Signing out is in the header. Use it when you are finished, especially on a shared computer. Signing out clears the previous person’s screen.

### If you can create your own account

Some workspaces let people sign up themselves. If you see a register link on the login page:

1. Choose a username and password.
2. Submit.

A self-created account is always a normal user, never an administrator. A new account may start with no credits. If you cannot run a task, ask an administrator to set an allowance.

---

## 2. Credits

Credits are the allowance that pays for a task. The person who **starts** the task is charged, even if they are working inside a space someone else owns.

### Where you see them

- The header chip shows credits left. It turns into a warning when you are low.
- Click the chip, or open **Credits**, for the full page.

### What the Credits page shows

- **Allowance** — the cap for this period.
- **Used** — what you have already spent.
- **Reserved** — held for a task that is still running. This comes back if the task stops before it uses the hold.
- **Available** — what you can still spend.
- **Usage history** — each billed step, with the date, a plain service name (not the vendor), the task, the project, and the credits charged.

Administrators see **Unlimited**. Their work is still recorded, but a zero allowance does not stop them.

### Low balance

If you are at or under the warning level, the app tells you your balance is low. You can often still run until the balance cannot cover the next step. Ask an administrator to add credits before a large task.

### When a task will not start

- **Not enough credits on your account.** The message says you do not have enough credits and to contact your administrator. This is your allowance, not a broken search.
- **The service behind the task is out of credits.** You see: “The provider for this task has insufficient credits. Please contact your administrator.” You are not told which service failed. An administrator can see that.
- **Too many tasks already running.** Wait until one finishes. There is a limit on how many paid tasks one person can have going at once.

After a finished run you may see a line such as “This run used X credits. You have Y credits available.” If some calls are still pending, the total can rise later. That is normal.

---

## 3. Client space

A client space is the folder for one client. Every search and lookup you start is saved under the space selected at the top of the home page.

### Create a space

1. In **New client**, type the client’s name (for example, Northside Dental).
2. Click **Create space**.
3. It becomes the selected space.

### Switch spaces

Open the **Client space** menu and pick another client. The line under the menu tells you where new work will be saved.

You cannot start a search or lookup until a space is selected.

### Shared spaces

A space someone else owns may appear in your list:

- **View only** — you can open the history. You cannot start new tasks in it.
- **Shared, can run** — you can start tasks. The credits come from **your** allowance, not the owner’s.

An administrator shares or deletes a whole space, including its history. You do not share one run at a time.

---

## 4. The home page

After the client space bar there are three tabs:

| Tab | What it is for |
| --- | --- |
| Keyword search | Find advertisers from keywords |
| Competitor lookup | Look up one competitor you already named |
| History | Open past runs |

Above the form, pick a platform. The choice applies to both search and lookup.

| Platform | What you are searching |
| --- | --- |
| Facebook Ads | Active Facebook ads from the Meta Ad Library |
| Instagram Ads | Ads serving on Instagram, taken from the Meta Ad Library |
| Google Ads | Search, display, and network ads from Google’s transparency library |
| YouTube Ads | Video ads from the same Google library, filtered to YouTube |
| LinkedIn Ads | Ads from the LinkedIn Ad Library |

The short line under the picker tells you which library that platform uses.

The header also has a **Stop** control when work is running. Use it to halt the current search or lookup. A stop keeps whatever was already found. It does not erase history.

---

## 5. Keyword search, step by step

Stay on **Keyword search**. Confirm the client space and the platform first.

### Step 1 — Analyze the client’s website

1. Paste the business website URL.
2. Click **Analyze URL**.

The app reads the site and fills a profile card:

- Industry and sub-industry
- A short positioning summary
- Services or products, shown as category tags
- Whether customers visit them, they go to the customer, or it is mixed
- Locations, when the site lists them
- Brand colors, when they can be read from the site

This profile is what later powers **Recreate for my brand**. If you skip the URL, you can still type keywords yourself, but you cannot build a branded landing page later.

### Step 2 — Pick a category

Click one category tag (a service or product). The keyword box fills with phrases for that category plus the locations the site listed.

You can clear the box and rewrite every line. The search uses **what is in the box**, not the original suggestion.

### Step 3 — Set competitor guardrails

These rules run before the keyword research, so software tools, courses, podcasts, and white-label platforms are less likely to be treated as real competitors.

| Choice | When to use it |
| --- | --- |
| Enforce industry SOP | Normal choice. Follow the rules for this industry. |
| Override — seek specific types | You want a type the rules would usually drop. Type those types in the box, for example “white-label agencies”. Add a note if you need to say why. |
| Skip all guardrails | Keep almost everything. Use this only when the rules are hiding the advertisers you actually want. |

### Step 4 — Choose how location is used

| Mode | What it does |
| --- | --- |
| Company locations | Prefer the cities on the client’s site, but still show other relevant advertisers if needed. If a keyword already names a suburb, that place is preferred and mismatches are flagged rather than thrown away. |
| Broader / manual geo | You rely on the market you pick next, not the site’s city list. |

Then pick the **Ad Library market** for that platform (country or region). This is the library’s own market, not a substitute for the city in the keyword.

### Step 5 — Check the keywords

One keyword per line, or commas. Example:

```
dental implants Ballarat
invisalign near me
```

Clear keywords if you want a blank box. Then start.

### Step 6 — Start the search

The button says something like **Find Facebook competitors**. It stays disabled until there is a keyword and a client space.

While it runs you see a progress panel: stage, ads scanned, pages scanned, accepted competitors, and a message. You can stop it from the header or the progress panel.

When it finishes, the results area opens with three views.

---

## 6. Search results: the three views

The results head shows the keyword, the platform, and the competitor count. **Download Excel** saves a spreadsheet of this run.

### Preview

A table of accepted competitors. Typical columns include the page or advertiser name, ad volume, and a creative preview. Brand numbers (followers, employees, and so on) are **not** in this table. They live under Brand review.

On a row you can:

1. **Analyze landing page** — open the destination URL from the ads and read the offer on that page. The button is only available when the row has a usable URL.
2. **Recreate for my brand** — open the content and design builder. This needs a completed landing-page analysis on that competitor, and a business website on the search.

If analyze fails, the error sits on that row. Fix the URL or retry. Do not start recreate until analysis has finished.

### Brand review

Brand metrics appear after the search, often in a batch. You see followers or subscribers, company size, and related public profile numbers for the platforms that advertiser uses (Facebook, Instagram, X, YouTube, LinkedIn).

If review is still running, the tab says so. You can start or retry a review from this panel. Wait until the count of reviewed rows stops moving before you treat the numbers as final.

### Offers

This is the offers dashboard for a keyword search. It is covered in the next section. It is a separate step. Finishing the search does not build the dashboard by itself.

---

## 7. Offers dashboard (keyword search)

This dashboard answers: what are these advertisers actually selling, which ads push which offer, and how does a cheap entry offer lead to the main offer?

### Generate it

1. Open the **Offers** view on a finished search.
2. Read the teaser. It tells you whether the dashboard is missing, running, finished, or failed.
3. If you are asked to pick competitors, tick the ones you want. **Select all** and **Clear** are there. A run often offers this so you do not analyze dozens of advertisers you do not care about.
4. Click **Generate offers dashboard**, or **Generate for selected**.

The default analysis looks at competitors with a meaningful number of active ads (about 10 or more) and builds a deduplicated picture.

You can **Stop** while it runs. Stopping keeps what was already written.

### Re-analyze

When a dashboard is already complete:

- **Re-analyze offers** rebuilds creatives, services, funnel stages, and ladders.
- It reuses ads already stored for this run. It does not start a brand-new library scrape.
- **Re-analyze selected** limits that rebuild to the competitors you ticked.

### The summary chips

Across the top you see how many ads sit in each funnel stage. The stages are written as badges, not long names:

- **TOFU** — top of funnel. These ads introduce the problem or the brand. They are the first ads someone might see.
- **MOFU** — middle of funnel. These ads help someone compare and consider.
- **BOFU** — bottom of funnel. These ads ask for the sale, the booking, or the form fill.
- **unknown** — the stage could not be decided from the copy.

Click a chip to filter. That filter opens the **Creatives & offers** tab. **Clear funnel filter** shows every stage again.

The title line also counts competitors, ads, creatives, and ladders.

### Tab: Ads by competitor

Ads grouped under each advertiser. Expand a name to read the ad copy that was stored for this run. Use this when you want the raw ads, not the summary.

If this tab is empty, generate or re-analyze. Cached ads appear only after that step.

### Tab: Creatives & offers

Each creative is a distinct hook, not one card per duplicate ad. You see:

- The hook (the opening promise)
- The offer attached to that hook
- The funnel stage
- How many ads use that creative

Click a creative to read the fuller copy. Use the funnel chips above if you only want one stage.

### Tab: By service

Services the ads are selling, listed as buttons. Click one.

Inside a service you see which competitors push it, the offers used, and the ads tied to those offers. This is the best view when the client sells three services and you only care about one.

### Tab: Offer ladders

A ladder is one core offer, then the smaller offers that lead into it. Example shape:

1. A free consult or a low-priced starter (the front step)
2. The main service (the core offer)
3. A higher package, if the ads mention one

Each ladder card has:

- The core offer name
- The competitor
- The steps, with the ads that support each step
- A jump list at the top so you can scroll to one core offer without hunting

Open a ladder when you want to copy the **structure** of the offer, not just one headline. Landing-page analysis makes these ladders more accurate, because the page often states the real price and package that the ad only hints at.

From a ladder you can jump to the landing-page detail for that offer when a destination was analyzed.

---

## 8. Competitor lookup, step by step

Use this when you already know the competitor’s name. You are not fishing with keywords.

1. Select the client space and platform.
2. Open **Competitor lookup**.
3. Type the competitor name.
4. Optional: paste their website. This helps matching and later landing-page work.
5. Start the lookup.

The app searches the ad library for that name, then tries to pick the right page. If several names are close, you will see **other name matches considered**. You can fetch ads for one of those candidates instead of the first guess.

### What you see

- The matched page name and a short reason it was chosen
- Their ads: title, copy, and destination when the library provides one
- A place to **Save brand** — your client’s website, not the competitor’s. Recreate needs this URL on the lookup.

### On each ad

1. **Analyze landing page** if the ad has a usable destination URL.
2. After analysis is complete, **Recreate for my brand**. If your brand website is missing, save it first. The button tells you when that is the blocker.

### Lookup offers intelligence

Lookup has its own offers panel, separate from the keyword-search dashboard. Generate it from the teaser at the top of the lookup results. You can stop it or open it once it is ready.

The lookup dashboard is one long page, not four tabs. Walk it from top to bottom:

| Section | What you are reading |
| --- | --- |
| Top offers from ad creatives | The offers repeated in the ad copy, with how often they appear |
| Top offers from landing pages | The offers actually written on the destination pages. Empty until you analyze pages |
| Funnel distribution | How many ads sit at each stage of the funnel |
| Offer value ladder | Core landing-page offers with the ad-copy steps mapped under them. If this is empty, analyze landing pages, then Refresh |
| Unique creatives | Distinct hooks, not duplicate ads |
| Destinations | The landing-page URLs. Open one to read the page offer and the ads that point at it |
| Services | One button per service. Open it to see related ads and offers |
| Offer value ladders | One card per core offer, with the steps underneath |

**Refresh** rebuilds the report from ads and pages already stored. It does not invent a page you have not analyzed.

---

## 9. Landing page analysis

A landing page is the site the ad sends someone to. The ad copy is the promise. The page is the actual offer, price, and form.

### From a search result

1. Stay on **Preview**.
2. On the competitor row, click **Analyze landing page**.
3. Wait until the status on that row is complete.

### From a lookup ad

1. On the ad card, click **Analyze landing page**.
2. Wait until the card says the analysis is complete.

### What you see while it runs

The panel says **Analyzing landing page…** until it finishes. If the site cannot be opened, you get **Offer & page details** plus the error. Other ads are not affected. Retry that page, or pick another ad that lands on a real sales page.

### What a finished analysis contains

The heading is **Offer & page details**. **Open page** opens the URL that was read. Read the blocks in this order:

1. **Summary** — a short read of the page, when one was written.
2. **Offer**
   - Headline
   - Primary offer (the thing they are actually selling)
   - Pricing
   - CTA (the button or next step, such as Book a call)
   - Urgency (a deadline or scarce-spots line, if the page uses one)
   - Value props (why they say they are different)
   - Guarantees
3. **Ads on this landing page** — other ads from this advertiser that point at the same page. Each line can show the hook, a link to the Ad Library, the offer, the CTA, a copy snippet, and whether the ad is active and how long it has run. This is how you see one page being sold by many ads.
4. **Page architecture** — the page type, then a numbered list of sections. Each section has a name, a purpose, a short summary, and the key elements on it (forms, proof, buttons). This is the skeleton you will copy in Recreate, not the competitor’s brand.
5. **Audience** — who the page is written for.
6. **Trust signals** — reviews, logos, guarantees, and similar proof.
7. **Conversion elements** — the parts that push someone to act.
8. **Notes** — extra technical notes, when there are any.
9. The date and time it was analyzed.

Empty fields are hidden. If a page has no sections, you will see “No sections extracted.” Analyze another destination if this one is a thin page.

Analyze the pages you care about **before** you treat offer ladders as complete, and **before** you recreate a page. Recreate refuses to start without a finished analysis and your brand website.

---

## 10. Recreate for my brand

This builds a landing page **for your client**, using a competitor as the pattern. It does not copy their brand. It uses your client’s name, site, and colors, and the competitor’s offer structure as the inspiration.

You reach it from:

- A competitor row on a keyword search, after landing-page analysis, or
- A lookup ad, after landing-page analysis and a saved brand website

The page title is **Recreate for my brand**. Under it: which competitor inspired it, the keyword if there was one, and your client’s site.

There are two phases, shown at the top:

1. **Content** — the words
2. **Design fit** — the layout, colors, and images

Do content first. Design uses the content you approved.

### Phase 1 — Write the content

If content is not there yet, click **Regenerate content**. The button says **Writing content…** while it runs. A progress bar and a message show the current step.

When content is ready, **Review content** opens.

You can edit in the form itself:

- Page title
- Meta description
- Each section’s heading and body
- FAQ questions and answers, where the page has them

Click **Save edits** to keep typing changes without rebuilding the design. Save does not spend a full rewrite. It stores what you typed.

### Suggest changes to the content

Use the left box, **Feedback for content**.

Write plain instructions, for example:

> Softer tone, lead with first-home buyers, CTA = Book a free call.

Then click **Regenerate content with feedback**. The button only uses that wording when the box is not empty. The limit is 4,000 characters. A counter appears as you type.

Regenerate **replaces** the draft. If you had unsaved edits you wanted to keep, click **Save edits** first, or paste those edits into the feedback so they come back.

Feedback for content is not applied to the design until you rebuild the design.

### Phase 2 — Build the design

When the words are right:

1. Optional: type **Feedback for design**. Example: “Make hero CTA stronger, FAQ answers shorter, emphasize Melbourne suburbs in headings.”
2. Click **Approve & build design**.

The app fits your approved words into a layout, using your brand colors and type. The button changes to **Building design + images…** while it works. Switch stays on the design view when it finishes.

**Feedback for design** does not rewrite the strategy of the offer. It refits the layout around the content you already approved. Use the content box if the words are wrong. Use the design box if the layout, emphasis, or headings are wrong.

If a design already exists, the same action is **Rebuild design** or **Rebuild design with feedback**. Rebuilding asks you to confirm, because it replaces the current page and its generated photos.

### Review the design

- **View design** shows the page in a preview frame.
- **Edit content** goes back to the word form. View design returns you to the preview.
- **Copy HTML** copies the full page so you can paste it into another tool.
- **Download HTML** saves the file.

The palette row shows Primary, Secondary, Accent, and Text colors from the client site.

- **Re-analyze brand colors** reads the business website again. The note will say to regenerate the design before the preview uses the new colors.
- **Apply colors to design** appears after a successful color refresh, if a design already exists. It rebuilds the design with the new palette. Confirm when asked, because it replaces the current page and photos.

**Brand design.md** (open the details block under the palette) is the brand file for this run. Competitor pages supply layout only. Colors, fonts, logos, and button styles come from this file, not from the competitor.

### Generated images

Under the preview, **Generated images** lists the photos placed in the design. Each card shows the slot name, the kind of photo, and the shape (ratio).

For one photo:

1. Optional: type regen notes, for example “brighter room, fewer people”.
2. Click regenerate on that card.
3. The preview updates when the new photo is ready.

**Download** saves one image. **Download all** saves the set.

Regenerating one image does not rebuild the whole page. Regenerating the design does replace the image set, which is why that action asks you to confirm.

### A sensible order

1. Analyze the client URL on the search, or save the brand website on the lookup.
2. Analyze the competitor landing page.
3. Open **Recreate for my brand**.
4. Generate content.
5. Edit the words. Save edits.
6. If the words are still wrong, write content feedback and regenerate content.
7. Approve and build the design.
8. Preview. If the layout is wrong, write design feedback and rebuild.
9. Fix individual photos with regen notes.
10. Download the HTML.

---

## 11. History

1. Open the **History** tab.
2. By default you see runs in the client space selected at the top.
3. Click **Every client** to see all of your spaces, then **This client only** to go back.
4. Filter with **All**, **Searches**, or **Lookups**.
5. Click a run to open the report on the right. Scroll follows the report.

Your spaces and spaces shared with you are separate headings. Shared rows show the other person’s name and whether you can only view or also run.

**Refresh** reloads the list. Deleting a run removes that history item. **Clear all** deletes your own search and lookup history. It does not delete projects that were only shared with you, and it does not delete another person’s space.

Opening an old run does not charge you. Starting a new search, lookup, offer analysis, brand review, landing-page analysis, or recreate does.

---

## 12. Export

On a search result, **Download Excel** saves a spreadsheet of the competitors from that run.

On a lookup result, **Download Excel** saves the ads for that competitor.

Exports are a copy of what is already stored for that run. They do not start a new library search. The button stays disabled until there is something to download.

---

## 13. What you can and cannot do

| You can | You cannot |
| --- | --- |
| Create a client space and run work inside it | Share or delete a whole client space (an administrator does that) |
| View a space that was shared with you | Run tasks in a view-only space |
| See your credits and usage | See which outside service ran out of credits |
| Change your own password | Turn yourself into an administrator |
| Stop your own running task | See another person’s private spaces |

If a task fails for lack of credits, contact your administrator. Tell them the client space and the time. They can see the rest.
