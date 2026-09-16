# Multi-user workspaces, credits, and admin

AdRival stores accounts, projects, and the credit ledger in `data/store.json`
(schema version 2). Existing jobs and history survive the migration. Rows
created before ownership existed stay **unassigned** until an administrator
assigns them — they are never shown to regular users.

There is no email, email verification, invitation, or password-reset mail.
Authentication is username + password only.

## First-admin setup

No administrator is hardcoded. Bootstrap is a one-time, documented process:

1. Generate a long random token (do not commit it).
2. Set both variables on the server and restart:

   ```
   ADMIN_BOOTSTRAP_TOKEN=<one-time secret>
   ADMIN_BOOTSTRAP_USERNAME=<username to create or promote>
   SESSION_SECRET=<long random secret for signing cookies>
   ```

3. Open `/setup` and paste `ADMIN_BOOTSTRAP_TOKEN`.
4. If the username does not exist, the API creates it with a temporary
   password (shown once) and `mustChangePassword = true`. If it already
   exists, it is promoted to admin.
5. Sign in, change the password, then **remove `ADMIN_BOOTSTRAP_TOKEN`**.
   Bootstrap refuses to run once any active admin exists.

`POST /api/admin/bootstrap` is public only because there is no admin yet. It
is gated by the token and self-disables after the first admin.

## User creation and public signup

- Public signup (`/register`) is **off** by default (`publicSignupEnabled`).
  Turn it on in **Admin → Settings**.
- Public signup always creates a regular `user`. The role cannot be chosen or
  changed by the registrant.
- New users receive **zero credits** unless **Admin → Settings → Default
  allowance** is raised.
- Admins can create users, set an allowance, activate/suspend, reset a
  password (temporary password + required change), change roles, and
  soft-delete accounts.
- The last active administrator cannot be demoted, suspended, or deleted.
- Password reset, suspension, role change, and deletion bump `sessionEpoch`,
  which invalidates every existing session for that account.

Users change their own password at `/account` and sign out from the header.
Logout does a hard navigation to `/login` so client state from the previous
account is discarded.

## Credit configuration

Application credits are integer **subunits** (10,000 per credit). Provider
usage, estimated USD cost, and application credits are stored separately.

1. Open **Admin → Settings**.
2. Set default allowance, optional monthly reset, low-credit warning, per-user
   concurrency, and the per-run reservation ceiling.
3. Publish a new **conversion rule set** when you change rates. Historical
   charges keep the version they were billed with.
4. Seeded conversion rules do not include dollar prices. Token calls still store a calculated cost from the documented list price for that model (Admin → Overview). SociaVault, Firecrawl, Brandfetch and Runway stay unpriced until you enter a rate.

Before a paid run starts, the server atomically reserves a conservative hold.
Each provider call tops up that hold, then settles actual usage. Timeouts stay
**pending reconciliation** (the hold is kept). Duplicate settlements are
idempotent. Abandoned holds expire after 15 minutes and are recovered.

The user who **starts** a run is charged, including inside a shared project.

Admins are not credit-limited. Their runs still record provider usage and calculated cost, but a zero allowance does not block them. Regular users are blocked when available credits cannot cover the next step.

> You do not have enough credits to run this task. Contact your administrator.

## Sharing and ownership

Sharing is admin-only at this stage (**Admin → Projects**):

| Role   | View | Edit | Run paid tasks |
|--------|------|------|----------------|
| Owner  | yes  | yes  | yes (own credits) |
| Editor | yes  | yes  | yes (own credits) |
| Viewer | yes  | no   | no |

- Sharing does not change ownership.
- Shared access covers only that project.
- Recipients see **My projects** and **Shared with me** separately, plus the
  owner’s display name and their permission.
- Revoking a share takes effect immediately.
- Ownership transfer is a separate admin action and does not rewrite ledger
  rows.

## Legacy (unowned) projects

Jobs that existed before schema v2 have `ownerUserId: null`. They appear only
in **Admin → Projects** (filter “unassigned”). Assign an owner there. Until
then, guessing the id from the UI or API returns 404 for regular users.

## Provider balances (admins only)

| Provider   | Balance source |
|------------|----------------|
| SociaVault | Documented `GET /v1/credits` (`credits` remaining). |
| OpenRouter | Documented `GET /api/v1/credits` (management key). Standard keys fall back to `GET /api/v1/key` (per-key remaining, labeled as such). |
| OpenAI, Anthropic, Firecrawl, Brandfetch, Runway | No documented balance API for standard keys. Shown as **Unavailable**. Tracked application usage is listed separately. |

SociaVault scrape responses may include `credits_used`; that value is stored
as confirmed request-units. When it is absent, the charge is labeled
**estimated**. Unknown usage is never shown as zero or as confirmed.

API keys never appear in admin screens, CSV exports, logs, or shared
projects — only a boolean “configured”.

## Tests

```bash
npm test          # unit: accounting, authz, run gating, migration, API surface
npm run test:e2e  # HTTP acceptance against a production build
```
