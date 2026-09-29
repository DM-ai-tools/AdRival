# AdRival admin manual

This guide is for an administrator. A normal user does searches, looks up competitors, and reads offers. You also create accounts, give people credits, share client folders, and watch whether the paid services behind the app are healthy.

Sign in with a username and password. There is no email. The screen for your work is **Administration**. Open it from the header link **Admin**, or from **Account**. **My credits** and **Back to app** stay at the top of that page so you can still use AdRival like everyone else.

There are six tabs: Overview, Alerts, Users, Usage, Client spaces, and Settings. This guide walks each one, then the jobs you do most often.

---

## 1. What you can do that a user cannot

| You can | A regular user cannot |
| --- | --- |
| See every account, allowance, and charge | See only their own credits |
| Create, suspend, promote, reset, and delete accounts | Change their role or someone else’s password |
| Share or delete a whole client space | Share or delete a space |
| See which paid service failed, and its real name | See vendor names. They get a plain “contact your administrator” line |
| Run tasks with no credit limit | Stop when their allowance runs out |
| Change global settings and credit rates | Change settings |

You are not charged against an allowance. Your runs are still recorded, including tokens and a calculated dollar cost, so Overview and Usage still show your work. The concurrency limit (how many paid tasks may run at once) still applies to you.

When **you** hit a service that is out of credits, the error names that service. A regular user only sees: “The provider for this task has insufficient credits. Please contact your administrator.”

---

## 2. First administrator (one time)

There is no built-in admin username. The first account is created once, on a page that turns itself off afterwards.

1. On the server, set three values and restart:
   - `ADMIN_BOOTSTRAP_TOKEN` — a long secret you invent. Do not put it in git.
   - `ADMIN_BOOTSTRAP_USERNAME` — the username to create or promote (for example `admin123`).
   - `SESSION_SECRET` — a long random secret that signs login cookies.
2. Open `/setup`.
3. Paste the bootstrap token.
4. Click **Create administrator**.

If that username is new, the page shows a **temporary password once**. Copy it before you leave the page. Sign in, open **Account**, and change the password. If the username already exists, it is promoted to admin and no new password is shown.

After any active administrator exists, `/setup` refuses to run again. Remove `ADMIN_BOOTSTRAP_TOKEN` from the server environment so the one-time secret is not left sitting there.

You cannot demote, suspend, or delete the last active administrator. The app will say: “This is the last active administrator. Promote another admin first.”

---

## 3. How to open Administration

1. Sign in.
2. Click **Admin** in the header. Only administrators see that link.
3. You land on **Administration**. The first tab is Overview.

The tabs are Overview, Alerts, Users, Runs, Usage, Client spaces, Audit log and Settings. The tab you are on (and a user you have open) is part of the address, so refresh and Back keep your place, and you can send a colleague a link. The Alerts tab shows a red count when something is waiting.

If you are not an admin, `/admin` is not yours to use. Making yourself an admin is not possible from Account. Another administrator has to promote you.

---

## 4. Overview

Overview is the health board. It does not change accounts. Read it when something feels wrong, or at the start of a day.

### Accounts

Counts of Total, Active, Suspended, Deleted, and Admins. Deleted accounts are kept on purpose so old bills still have a name. They cannot sign in.

### Credits across current periods

A total of what you have given people in their current period:

| Number | Meaning |
| --- | --- |
| Allocated | Allowances you have set |
| Consumed | What has been used. A negative number means refunds outweigh usage |
| Reserved | Held for tasks that are still running |
| Remaining | Allocated minus consumed minus reserved |

This is user allowances, not the balance on SociaVault or OpenRouter. Those live under Provider spend.

### Provider spend

Every paid call stores how many tokens went in and came out. The dollar figure is those tokens times a documented list price for that model. It is a running total **inside this app**. It is not the vendor’s live balance, and a missing price is shown as **Unavailable**, never $0.

The summary line shows:

- **Running total** — calculated dollars
- **Input tokens** and **Output tokens**
- **Unpriced calls** — calls with no price, so they are not quietly counted as free

The table under that has one row per provider and model:

| Column | What it is |
| --- | --- |
| Provider | SociaVault, OpenRouter, OpenAI, Anthropic, Firecrawl, Brandfetch, or Runway |
| Model | The model name, when the call used one |
| Calls | How many times it was used |
| Input / Output | Token counts |
| Calculated cost | Dollars, or Unavailable |
| Basis | **Stored on the call**, **List price × tokens**, or **No token price** |

**List price × tokens** means the app multiplied tokens by the known public price for that model. **No token price** means this kind of call is not sold per token (a scrape or an image), so do not treat the dollar cell as a bill.

### Live account balance

This asks the vendor, live, “how much is left on our key?” Only some vendors publish that.

| What you see | What it means |
| --- | --- |
| A number and a currency or unit | The vendor answered |
| Unavailable | That vendor has no balance API for a normal key. OpenAI, Anthropic, Firecrawl, Brandfetch, and Runway usually look like this. Use Provider spend for those. |
| Error | The balance call failed. Read the note in the row. The key is not shown. |

SociaVault’s row is remaining credits from its credits endpoint. OpenRouter’s row is the account balance when a management key is configured. A normal OpenRouter key can only report that key’s own remaining amount, and the note says so.

### Usage by provider

One row per service: calls, application credits charged, estimated cost, and four quality counts.

| Count | Meaning |
| --- | --- |
| Confirmed | The vendor told us exactly what was used |
| Estimated | We had to guess the size (the vendor did not send a usage figure) |
| Pending | We do not yet know if it was billed. Credits stay held |
| Failed | The call failed |

**Usage by date** is the same credits and calls, grouped by day. Use it to see whether spend jumped on a particular date.

### Pending reconciliation

A row appears when a call timed out or was aborted, so the app does not know if the vendor billed it. The user’s credits stay held until you record the outcome. Do not ignore this list. A held amount looks like “reserved” and reduces what that person can spend.

This section is called **Billing checks** on screen. For each row you see when it opened, the user, what it was for, and how much is held.

1. Check the vendor’s own dashboard if you can, using the time.
2. Click **It was billed** if they did charge it, or **It wasn’t billed** if they did not.
3. A dialog says exactly what will happen to the credits. Type how you know, then confirm. Cancel if you are not sure; nothing is saved until you confirm.

**It was billed** charges the user the full held amount. **It wasn’t billed** gives the held credits back. An unused hold also expires on its own after 15 minutes and is recovered, but a call marked pending reconciliation is waiting for you, not for that timer.

### Recent failures

The latest calls that did not succeed: when, which provider, the operation, status, confidence, credits, and the error text. You see the real provider name. Users do not.

### Recent admin activity

The latest admin actions in plain words: who did it, when, what, the user affected, and details such as the reason. Sign-ins and admins opening other people’s runs are left out here to keep it readable. **Full audit log** opens the Audit log tab. Rows cannot be edited or deleted; the store keeps the most recent 20,000.

---

## 5. Alerts

Alerts is the list you act on. Click **Refresh** after you add credits or top up a vendor, so a cleared warning disappears.

The note at the top is important: users are not told which provider failed.

### Low credits

One line per active regular user who is at or below the low-credit warning from Settings. Administrators are not listed, because they are not limited. The list is calculated live from current balances.

To top someone up, set **Credits to add** and a **Reason** at the top of the list, then click **Add … credits** on their line. **Top up all** does the same for everyone listed. Click a name to open that person in Users.

A low warning does not by itself stop the person. They stop when the next task cannot be covered.

### Provider accounts out of credits

Grouped by **provider**: a vendor account (SociaVault, OpenRouter, and so on) ran out while someone was working. This is not a user’s allowance; adding AdRival credits will not fix it.

What to do:

1. Top up that vendor account, or fix the key, outside AdRival. Keys are never shown in this app.
2. Tell the user they can retry. They were not told the vendor name, so say it plainly.
3. Click **Dismiss** on the provider. Dismissed alerts leave the list and the tab count; tick **Show dismissed** to see them again. A new alert appears if it runs out again. An identical failure for the same user and provider is not logged again within about 15 minutes.

---

## 6. Users

### Create a user

1. Open **Users** and click **New user**.
2. Fill in **Username** (what they type to sign in; no email), **Display name**, **Role** (User, unless they should see this whole dashboard; an admin is not credit-limited) and **Starting credits** (blank uses the default in Settings; `0` means they cannot run until you give them credits).
3. Click **Create user**.

The dialog shows the **temporary password once**, with a **Copy** button. Give it to them privately. They must change it at the next sign-in.

A public signup, if you turn it on in Settings, always creates a regular user. It cannot create an admin.

### The user table

**Search** matches username or display name as you type. Filter by **Role** and **Status**. Click a column heading (User, Credits left, Last sign-in, Runs) to sort. Long lists are split into pages of 25.

Each row shows name, role, status, credits left, last sign-in, and how many runs and client spaces they own. **Locked out** means too many wrong passwords in a row; **Must change password** means they have not yet replaced a temporary password.

Tick rows (or the box in the heading for the whole page) and click **Add credits to N selected** to top up several people at once, with one reason.

Click **Open** to open a person in a panel on the right, with four tabs: **Credits**, **Account**, **Limits** and **Activity**. Escape or **Close** closes it. Every result appears inside the panel, next to what you clicked.

### Credits — three different buttons

These are not three ways to add credits. Read the line above the buttons: set and add use the amount box. The slider is only for adjust.

**Amount for set or add** is the number. **Reason** is required for every credit change. It is written into the ledger and the audit log. If you leave it blank, the change is refused.

| Button | What it changes | Example |
| --- | --- | --- |
| Set allowance | Replaces the cap for this period | They should have 100, not “100 more”. Type `100`, then Set allowance. Old usage still counts against the new cap. |
| Add credits | Increases the cap | They have 40 and you want to give 20 more. Type `20`, then Add credits. The new cap is 60. |
| Adjust usage | Moves remaining credits up or down. The cap does not change | Use the slider, not the amount box. |

The live line under Credits shows left, allowance, and used or refunded. After a successful change it flashes and a banner states the before and after. If the table still looks old for a moment, the banner is the saved result. **Refresh** if you want the table to match.

#### Adjust usage, step by step

1. Open that person in Users (the Credits tab).
2. Leave the amount box alone.
3. Slide left to **Remove** credits, right to **Refund** them. The range is −200 to +200. Zero does nothing, and **Apply adjustment** stays off at zero.
4. Read the preview: remaining goes from the old number to the new one. Allowance stays the same.
5. Type a reason.
6. Click **Apply adjustment**.

A refund gives credits back without raising the allowance. Removing credits bills them without lowering the allowance. The original charge rows in history are not rewritten. If you need more than 200 in one move, apply the slider more than once, each time with a reason.

Do not use Set allowance when you only want to refund a failed run. Set allowance changes the cap. Adjust usage changes what they have left.

### Reset schedule

In the same Credits panel:

- **Manual allocation** — nothing resets by itself. You add or set credits when you choose.
- **Monthly reset** — when the month rolls, unused allowance expires. History is kept. They are not paid a bonus for leftover credits.

Click **Save schedule**. This does not move credits today. It only decides whether the next period wipes unused allowance.

### Account actions (Account tab)

| Action | What happens |
| --- | --- |
| Save name | Changes the display name others see. |
| Suspend / Reactivate | Asks you to confirm. Suspending signs them out at once; runs and credits are kept. You cannot suspend yourself. |
| Make admin / Make regular user | Asks you to confirm. Admins have unlimited credits and full access. Refused for the last active admin, and you cannot demote yourself. |
| Reset password | Asks you to confirm. Shows a new temporary password once, with a Copy button. Signs them out everywhere. |
| Unlock sign-in | Shown only when they are locked out after repeated wrong passwords. Lets them try again straight away. |
| Delete account… | Soft delete. Access ends at once. Billing and audit history stay. |

**Delete account…** opens a dialog that says how many runs and client spaces they own and asks what should happen to them:

| Choice | Result |
| --- | --- |
| Archive them | Their runs and client spaces are archived. People they shared with lose access. |
| Give them to another user | Pick the new owner from the list. They own the runs and client spaces from then on. Past charges stay with whoever ran them. |
| Leave them unassigned | Runs are no longer tied to that owner and show under Client spaces as runs not in a client space. Their client spaces pass to you. |

Type their username to confirm. You cannot delete yourself or the last active administrator. A deleted account cannot be changed or given credits later.

### Limits tab

- **Runs at the same time** — overrides the Settings default for this person. Leave blank for the default.
- **Services this user may use** — untick a service to refuse it for this person only. With every box ticked there is no restriction.
- **Blocked models** — one model name per line, for this person only.

### Activity

The **Activity** tab is read-only.

- **Allowance, Consumed, Reserved, Available** — the same credit picture, including holds.
- **Concurrency limit** — “Default” means they use the number in Settings. A number here would be a personal override. The Users screen does not have a form to type that override.
- **Allocation periods** — each period’s start, status, allowance, consumed, reserved, cadence, and next reset date.
- **Usage by provider** — calls and credits charged to this person. You see vendor names.
- **Projects owned** — title, kind, **Created** date and time, and whether it is archived.
- **Recent runs** — run id, operation, call count, credits, and when it finished.

Activity is not where you edit credits; use the Credits tab for that.

---

## 7. Usage

Usage is the call-by-call ledger. Overview is the summary. Use this tab when you need one charge, one run, or a spreadsheet.

### Filters

All of these narrow the table. They do not change anyone’s credits.

| Filter | How to use it |
| --- | --- |
| User | Pick a person, or leave All users |
| Project id | Exact id of a project, if you have it |
| Run id | Exact id of one search, lookup, or other task |
| Provider | One vendor, or all |
| Status | succeeded, failed, timeout, not_billable, or blocked |
| Confidence | confirmed, estimated, or pending_reconciliation |
| From / To | Calendar dates. To includes the whole end day |

**Refresh** reloads. **Export CSV** downloads whatever the filters show. The file has no API keys.

### Filtered totals by provider

A short table of calls and credits for the current filters. Use it before you export, so you know the sheet matches the person or the dates you meant.

### Reservations for this run

This block appears only when you have typed a **Run id** and that run still has holds. It shows when the hold opened, its status, what is still held, what has been settled, when it expires, and a note. This is how you see “this search is still reserving 40 credits” without guessing.

### Provider calls

One row per call. The table pages 100 rows at a time. **Previous** and **Next** move through them. The line above the buttons says which rows you are on.

| Column | Meaning |
| --- | --- |
| When | Start time |
| Charged | Who paid in application credits. In a shared space this is the person who started the task, not always the owner |
| Initiated by | Who clicked start. Usually the same person |
| Provider | Vendor name |
| Model / endpoint | Model or API path |
| Operation | What the app was doing (search, page analysis, recreate, and so on) |
| Project | Kind and id, when the call belongs to a project |
| Run | The task id. Copy it into the Run id filter, or into Overview if you are reconciling |
| Request id | The vendor’s own id, when they sent one |
| Usage | Tokens in and out, images, or request count. “Not reported” means the vendor sent no size |
| Credits | Application credits charged |
| Est. cost | Calculated dollars, or “No price configured” |
| Rules v | Which conversion-rule version priced this row. Old rows keep their old version |
| Confidence | Confirmed, Estimated, or Pending reconciliation |
| Status | Hover a failed status to see the error |

**not_billable** means the call was recorded but not charged. **blocked** means a setting stopped it before it spent money.

---

## 8. Client spaces

A client space is a named folder for one client. Every search and lookup inside it is the history. You share or delete the **folder**, not one run at a time. The tab label is **Client spaces**.

### Create a space

1. Type the **Client name** (2 to 80 characters), for example Northside Dental.
2. Choose an **Owner** from the list. Names are shown as `Jane Doe (@jane)`.
3. Click **Create space**.

The new space is that person’s. They will see it in the client-space menu on the home page. You can also create a space for yourself if you run client work.

### Find a space

Two ways. You can use either. You do not have to pick a person first.

**Find a client space** filters by client name or owner. Then open the **Client space** menu. Each option shows the client, the owner, and how many runs are inside. Choosing one opens that space and also selects the owner in the list below.

**Or choose an owner** lists that person’s spaces as buttons: name, run count, last updated date, and how many people it is shared with. Click a button to open it.

### What an open space shows

The header is the client name, the owner, and the run count.

**Runs in this space** lists every search and lookup: title, Search or Lookup, status, **Created** date and time, and **Updated** if it changed later. This is the history. Opening it does not charge anyone.

**Rename** next to the client name changes it in place.

**Archive space** asks you to confirm. It archives the space and every run inside it. People it was shared with lose access immediately. It does not delete the owner’s account. Archived spaces are listed at the bottom of the tab; **Restore** brings a space back together with the runs that were archived with it.

### Share the whole space

1. Choose a user who is not the owner.
2. Choose a permission:
   - **Viewer** — can open history, cannot start tasks.
   - **Editor** — can start tasks. Credits come from **their** allowance, not the owner’s.
3. Click **Share space**.

Sharing does not change the owner. Past charges stay with whoever ran them. The list under the button shows who has access. **Remove access** asks you to confirm, then removes that person immediately.

Share the space again with the other permission if you need to change Viewer to Editor, or the reverse.

### Transfer ownership

Choose a **New owner** and confirm. The space moves. Shares can stay. Ledger rows are not rewritten, so Usage still shows the person who was charged at the time.

### Runs not in a client space

Older searches and lookups were saved one at a time, before spaces existed. They are not visible to regular users until they sit inside a space.

1. Use **Find a run** if the list is long. It matches title, kind, or owner.
2. Tick the runs, or **Select shown**.
3. **Move selected into** a client space.
4. Click **Move**.

After the move, those runs follow the space: share the space and people see them; delete the space and they are archived with it. New work started from the home page already requires a space, so this list should only be old data.

---

## Runs

Every search and lookup by every user, newest first. Filter by text, owner, type and status. Each row shows the owner, client space, status (with the current step while it runs), how many competitors or ads it found, and the credits it used. **Open** opens the run in the app, the way its owner sees it. Click an owner to open them in Users.

## Audit log

Who did what and when, in plain words, newest first. Filter by **Area** (credits, accounts, client spaces, settings, conversion rules, billing checks, sign-ins), **Done by**, **User affected**, and dates. Sign-ins and admins opening other people’s runs are hidden unless you tick **Include sign-ins and run views**. **Export CSV** downloads what you are looking at (up to 2,000 rows). Credit amounts are shown in credits.

---

## Organisations (client admins on the same app)

Use this when a client shares your deployment. **Organisations** appears only for platform administrators (admins who don't belong to an organisation).

1. Open **Organisations**, enter the client's organisation name, their admin's username and display name, and click **Create organisation and admin**.
2. Copy the temporary password shown once and send it privately. They must choose a new password at first sign-in.

What the client's admins get:

- Their own history starts empty. They see and manage only their organisation: its users, runs, usage, audit entries, low-credit alerts and client spaces.
- They never see your runs or accounts, and they can't change, suspend or add credits to anyone outside their organisation. A run id from outside returns "not found".
- Users they create join their organisation automatically.
- Like your admins, they have unlimited credits and can add credits to their own users. Runs use this deployment's API keys.
- **Settings**, **Organisations**, credit rates, billing checks and vendor balances stay platform-only. So does out-of-credit vendor alerts: only you can top up the vendor accounts.
- An organisation always keeps at least one active admin of its own. As a platform admin you can still change or remove them.

What you keep:

- Your own history, exactly as before.
- Every tab shows every organisation. Users show an organisation tag, and you can move a person between organisations from their panel (**Account → Organisation**). Moving signs them out.

---

## 9. Settings

Settings is global. A change here applies to everyone, unless a person has their own allowance, reset schedule or limits (Users → open → Credits or Limits).

The page shows an error in red and **Settings saved** when a save worked. **Publish new version** is a different button. Saving the form does not publish rates. Publishing rates does not save the form. Do both if you changed both.

### How much to allot

The box at the top is a planning guide, not that person’s usage. The same box appears in a person’s Credits tab under “How allowances work”. It is built from the active conversion rules.

It lists sample costs, such as:

- one ad-library request (SociaVault)
- one model call (OpenRouter), at the rule’s estimated token size
- one Claude call (Anthropic)
- one generated image (Runway)

Then three plans:

| Plan | Starting idea | What it is for |
| --- | --- | --- |
| Light | 25 credits | A small amount of searching |
| Regular | 100 credits | Everyday work |
| Heavy | At least the per-run cap, and at least 500 | Someone who runs large jobs. Keep the per-run cap at or below their allowance so one run cannot empty the account |

These are samples. If you change conversion rates, the sample call costs change. The plan names stay.

### Global settings

| Field | What it does |
| --- | --- |
| Allow public signup | Adds a register link on the login page. New accounts are always regular users, never admins. Off by default. |
| Default allowance for new users | What a blank allowance becomes. `0` means they cannot run until you set one. Does not change people who already exist. |
| Default reset schedule | Manual, or monthly. Monthly expires unused allowance and keeps history. A person’s own schedule (their Credits tab) overrides this for them. |
| Low-credit warning | When remaining credits hit this number, the user sees a warning and they appear on Alerts. No email is sent. |
| Concurrent runs per user | How many paid tasks one person may have running at once. Extra starts are refused until one finishes. Applies to administrators too. |
| Hard cap per run | A normal user’s run stops before it can reserve more than this. Does not apply to administrators. |

Click **Save settings** at the bottom of this form. The checkbox and the number fields are one save.

### Provider restrictions

**Disable** a provider to block it for every user, including you. The label adds “(no key configured)” when that vendor’s key is missing from the server. Disabling a missing key does not add the key.

**Blocked models** is one model name per line. A blocked model cannot be used. This is global. To limit one person instead, open them in **Users** and use the **Limits** tab.

When you tick a provider that was on, **Save settings** asks you to confirm first, because every task that needs it is refused for everyone.

Save settings after you tick a provider or edit the model list.

### Credit conversion rules

These rules turn vendor usage into the credits you see on user accounts. They are versioned: publishing makes a new version, and charges already made keep the version they were priced with.

- Each service has a table. **All other models** is its default rate; **+ Add a rate for one model** adds a model with its own rate, and **Remove** deletes one.
- Rates are typed **in credits**: per request, per 1,000 input tokens, per 1,000 output tokens, per image. Leave a box empty if it does not apply.
- **Hold per call** is the most the app holds before one call of unknown size. Leftover hold is released after the call. Not tiny, or large calls cannot start; not enormous, or one call can freeze someone’s whole allowance.
- Dollar prices and fallback token estimates are kept as they were; the table does not change them.
- **Start from** picks the version to edit. Picking an older version and publishing it makes those rates active again, which is how you roll back.
- **Note for this version** — write why you changed it.

Click **Review and publish…**. A dialog lists every change against the active version (for example “OpenAI / default: Per 1k input tokens 0.2 → 0.25 credits”). Nothing is published until you confirm. Anything malformed, such as a negative rate or an unknown service, is refused by the server with a plain explanation.

### Provider credentials

A yes/no table only. Keys live in server environment variables. They are never shown in the browser, in CSV exports, in audit logs, or in a shared space. If a row says **No**, that feature will fail until someone puts the key on the server and restarts. You cannot paste a key into this page.

### Current defaults summary

A short recap of public signup, default allowance, low-credit warning, per-run cap, and when settings were last updated. If this disagrees with the form, you have unsaved edits. Save, then check the summary again.

---

## 10. Everyday jobs

### Give a new person access

1. Users → Create user, with a real allowance (use How much to allot).
2. Copy the temporary password and tell them to change it.
3. Client spaces → Create space with their name as owner, or share an existing space.
4. If they will only read, share as Viewer. If they will run searches, share as Editor and make sure **their** allowance can pay for it.

### Someone says they cannot run a task

Check in this order:

1. **Alerts → Low credits.** If they are listed, Add credits or Set allowance.
2. **Users → Open.** Confirm status is Active, not Suspended or Deleted.
3. **Alerts → Provider credits exhausted.** If their name is there, their allowance is not the problem. Top up the named vendor. When you reply, you may name the vendor. Their screen will not.
4. **Overview → Pending reconciliation.** A stuck hold can make remaining credits look smaller than the allowance.
5. **Settings.** Concurrent runs may already be full, a provider may be disabled, or the hard cap may be stopping a large run.
6. If you were the one running it, the error on your own screen names the vendor. Believe that name.

### A task timed out and they want the credits back

1. Overview → Billing checks. If the hold is there, choose **It wasn’t billed** only if the vendor did not charge, or **It was billed** if they did. Write how you know.
2. If the charge already settled and you still want to give credits back, Users → Open → Credits → slide Adjust usage to the right and apply. Do not Set allowance unless you also want a new cap.

### Hand a client folder to someone else

1. Client spaces → open the space.
2. Transfer ownership if they should own it, or Share as Editor if the original owner should keep it.
3. Remove the old share if that person should stop seeing it.

### Turn off signups

Settings → uncheck **Allow public signup** → Save settings. Accounts you create yourself still work.

---

## 11. What a user sees, so you are not surprised

- Credits page: their allowance, used, reserved, available, and a history that names services in plain words (Ad library, Analysis service, Content engine). Not SociaVault or OpenAI.
- Header chip: credits left, or a low warning. Yours says **Unlimited**.
- Client space menu: spaces they own, plus spaces you shared. View only, or Shared, can run.
- They cannot open Administration, cannot share a space, and cannot see Alerts.
- A vendor outage never names the vendor for them. It does for you.

The user guide is `docs/USER_MANUAL.md`. It covers search, lookup, offers, landing pages, offer ladders, and recreate. You use those the same way. This file is only the admin work.

---

## 12. Easy mistakes

- **Set allowance is not Add credits.** Set replaces the cap. Add increases it. Adjust usage does neither; it only moves what is left.
- **Adjust usage ignores the amount box.** Use the slider. A reason is still required.
- **A provider out of credits is not a low user allowance.** Alerts splits these on purpose. Adding AdRival credits does not refill SociaVault.
- **Sharing does not transfer the bill.** The person who clicks start pays, on their own allowance.
- **Deleting a space archives every run in it.** You do not pick runs one by one on delete.
- **Publishing rates does not rewrite old charges.** Usage still shows the old version number on old rows.
- **Rates are typed in credits.** The table converts them; you never type subunits.
- **The temporary password is shown once.** If you leave the page without copying it, reset the password and copy the new one.
- **Do not remove the last admin.** Promote someone else first.
