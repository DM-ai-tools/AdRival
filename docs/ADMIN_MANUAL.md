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

For each row you see when it opened, the operation, the run id, how much is held, and a note.

1. Check the vendor’s own dashboard if you can, using the time and the run id.
2. Click **Was billed** if they did charge it, or **Not billed** if they did not.
3. Type a short reason in the prompt. Cancel the prompt if you are not sure — nothing is saved until you submit a reason.

**Was billed** keeps the charge. **Not billed** releases the hold. An unused hold also expires on its own after 15 minutes and is recovered, but a call marked pending reconciliation is waiting for you, not for that timer.

### Recent failures

The latest calls that did not succeed: when, which provider, the operation, status, confidence, credits, and the error text. You see the real provider name. Users do not.

### Recent admin activity

An append-only log of admin actions: who did it, when, the action name, the target (a user or a project), and details such as the reason. You cannot edit or delete a row. If someone asks “who reset my password?”, this is the place.

---

## 5. Alerts

Alerts is the list you act on. Click **Refresh** after you add credits or top up a vendor, so a cleared warning disappears.

The note at the top is important: users are not told which provider failed.

### Low credits by user

One line per active regular user who is at or below the low-credit warning from Settings. Administrators are not listed here, because they are not limited.

Each line shows the display name, username, credits left, allowance, and the warning number. This list is calculated live from current balances. It is not a pile of old messages.

What to do:

1. Open **Users**.
2. Search that username.
3. Click **Manage**.
4. Either **Add credits** or **Set allowance**, with a reason.
5. Come back and **Refresh**.

A low warning does not by itself stop the person. They stop when the next task cannot be covered.

### Provider credits exhausted

Grouped by the user who was working when a **vendor account** ran out. This is not their allowance. Topping up their AdRival credits will not fix it.

Each line names the provider (SociaVault, OpenRouter, and so on), the time, and a short run id. The same person can have more than one provider under their name.

What to do:

1. Read the provider name.
2. Top up that vendor account, or fix the key, outside AdRival. Keys are never shown in this app.
3. Tell the user they can retry. They were not told the vendor name, so you should say it plainly when you reply.
4. **Refresh**. New failures are kept. An identical failure for the same user and provider is not logged again within about 15 minutes, so a burst of retries does not flood the list.

---

## 6. Users

### Create a user

1. Open **Users**.
2. Fill **Create user**:
   - **Username** — what they type to sign in. No email.
   - **Display name** — the name other people see.
   - **Role** — User, unless you intend them to see this whole dashboard. An admin is not credit-limited.
   - **Initial allowance** — credits they start with. Leave it blank to use the default in Settings. `0` means they cannot run until you set an allowance.
3. Click **Create user**.

The page shows a **temporary password once**. Copy it and give it to them in a private way. They must change it at the next sign-in. There is no email to send the password.

A public signup, if you turn it on in Settings, always creates a regular user. It cannot create an admin.

### The user table

**Search** matches username or display name. Filter by **Role** (Admin or User) and **Status** (Active, Suspended, Deleted). **Refresh** reloads the list.

Each row shows name, role, status, credits, and project count.

- A regular user shows credits left and the allowance. The left number turns to a low style when they are under the warning.
- An admin shows **Unlimited**, plus how much has been used (for the record only).

Click **Manage** to open that person. Click **Close** to hide the panel.

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

1. Open Manage for that person.
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

### Account actions

Still inside Manage, under **Account**:

| Button | What happens |
| --- | --- |
| Suspend | They cannot sign in. Existing sessions die immediately. Their history stays. The button becomes **Reactivate**. |
| Reactivate | They can sign in again. |
| Promote to admin | They can open Administration and are no longer credit-limited. |
| Demote to user | They lose the admin screens and become credit-limited again. Refused if they are the last active admin. |
| Reset password | Asks you to confirm. Shows a new temporary password once. Signs them out everywhere. They must change it at next sign-in. |
| Delete | Soft delete. Access is revoked at once. Billing and audit history stay. |

**Delete** asks what to do with their projects. Type one of these words exactly:

| Word | Result |
| --- | --- |
| archive | Their spaces and runs are archived. Shared people lose access. |
| transfer | You are asked for an active username. That person becomes the owner. Past charges stay with whoever ran them. |
| unassign | Runs are no longer tied to that owner. They show up under Client spaces as runs not in a client space, until you move them. |

Then confirm. You cannot delete the last active administrator.

### Activity

Click **Activity** in the Manage header. This is read-only.

- **Allowance, Consumed, Reserved, Available** — the same credit picture, including holds.
- **Concurrency limit** — “Default” means they use the number in Settings. A number here would be a personal override. The Users screen does not have a form to type that override.
- **Allocation periods** — each period’s start, status, allowance, consumed, reserved, cadence, and next reset date.
- **Usage by provider** — calls and credits charged to this person. You see vendor names.
- **Projects owned** — title, kind, **Created** date and time, and whether it is archived.
- **Recent runs** — run id, operation, call count, credits, and when it finished.

Close the panel when you are done. Activity is not where you edit credits. Go back to Manage for that.

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

**Delete space** asks you to confirm. It archives the space and every run inside it. People it was shared with lose access immediately. It is a soft delete: the audit trail remains. It does not delete the owner’s account.

### Share the whole space

1. Choose a user who is not the owner.
2. Choose a permission:
   - **Viewer** — can open history, cannot start tasks.
   - **Editor** — can start tasks. Credits come from **their** allowance, not the owner’s.
3. Click **Share space**.

Sharing does not change the owner. Past charges stay with whoever ran them. The list under the button shows who has access. **Revoke** removes that person immediately.

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

## 9. Settings

Settings is global. A change here applies to everyone, unless a person’s Manage panel has its own allowance or reset schedule.

The page shows an error in red and **Settings saved** when a save worked. **Publish new version** is a different button. Saving the form does not publish rates. Publishing rates does not save the form. Do both if you changed both.

### How much to allot

The box at the top is a planning guide, not that person’s usage. The same box appears inside Manage. It is built from the active conversion rules.

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
| Default reset schedule | Manual, or monthly. Monthly expires unused allowance and keeps history. A person’s own schedule in Manage overrides this for them. |
| Low-credit warning | When remaining credits hit this number, the user sees a warning and they appear on Alerts. No email is sent. |
| Concurrent runs per user | How many paid tasks one person may have running at once. Extra starts are refused until one finishes. Applies to administrators too. |
| Hard cap per run | A normal user’s run stops before it can reserve more than this. Does not apply to administrators. |

Click **Save settings** at the bottom of this form. The checkbox and the number fields are one save.

### Provider restrictions

**Disable** a provider to block it for every user, including you. The label adds “(no key configured)” when that vendor’s key is missing from the server. Disabling a missing key does not add the key.

**Blocked models** is one model name per line. A blocked model cannot be used. This is global. The Users screen does not have a matching per-person checklist, even though the sentence on this panel mentions individual accounts. Use this box, or disable the whole provider, for the control you can actually click.

Save settings after you tick a provider or edit the model list.

### Credit conversion rules

These rules turn vendor usage into the credits you see on user accounts. They are versioned.

- The **Rates** box is JSON. Each vendor has a `default` rate, and can have a rate for a specific model.
- Numbers in that box are **subunits**. 10,000 subunits = 1 credit. A SociaVault rate of `10000` per request means 1 credit per request. Do not type `1` if you mean 1 credit.
- Typical keys: `perRequest` for a scrape, `perThousandInputTokens` and `perThousandOutputTokens` for a model, `perImage` for Runway. Estimated token sizes are used when the vendor does not send a real count.
- **Per-call reservation ceiling** is the most the app will hold before one call of unknown size, again in subunits. Leftover hold is released after the call. Do not set this tiny, or large calls cannot start. Do not set it enormous, or one call can freeze someone’s whole allowance.
- Dollar prices are optional. Leave them out and cost columns say “No price configured” instead of $0. Token dollar totals on Overview still use documented list prices for models that have them. That Overview figure is separate from these credit rates.
- **Note for this version** — write why you changed it. You will see this note in the versions table.

Click **Publish new version**. The success line names the new version, for example v2. Existing charges keep the version they were billed with. You cannot rewrite history by publishing new rates.

**Published versions** lists version, created time, note, how many providers are priced, and which version is active. The active one is the version new calls use.

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
2. **Users → Manage.** Confirm status is Active, not Suspended or Deleted.
3. **Alerts → Provider credits exhausted.** If their name is there, their allowance is not the problem. Top up the named vendor. When you reply, you may name the vendor. Their screen will not.
4. **Overview → Pending reconciliation.** A stuck hold can make remaining credits look smaller than the allowance.
5. **Settings.** Concurrent runs may already be full, a provider may be disabled, or the hard cap may be stopping a large run.
6. If you were the one running it, the error on your own screen names the vendor. Believe that name.

### A task timed out and they want the credits back

1. Overview → Pending reconciliation. If the hold is there, mark **Not billed** only if the vendor did not charge, or **Was billed** if they did. Write the reason.
2. If the charge already settled and you still want to give credits back, Users → Manage → slide Adjust usage to the right and apply. Do not Set allowance unless you also want a new cap.

### Hand a client folder to someone else

1. Client spaces → open the space.
2. Transfer ownership if they should own it, or Share as Editor if the original owner should keep it.
3. Revoke the old share if that person should stop seeing it.

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
- **The rate JSON is in subunits.** 10,000 means 1 credit.
- **The temporary password is shown once.** If you leave the page without copying it, reset the password and copy the new one.
- **Do not remove the last admin.** Promote someone else first.
