-- 001_init: one table per DatabaseShape collection (src/lib/types.ts).
--
-- Every table keeps the full TypeScript record in `data jsonb`; the other
-- columns are copies of the fields that are filtered, joined, sorted or
-- scoped on, kept in sync by the repositories. Ids are text (uuids and legacy
-- ids). Timestamps are the record's ISO strings parsed to timestamptz.
-- No foreign keys between record tables: the imported store has legacy rows
-- whose owners, spaces or orgs no longer exist.
--
-- migrate() sends this file as one implicit transaction: do not add
-- BEGIN/COMMIT here.

-- Counters that replace DatabaseShape.ledgerSeq / auditSeq.
create sequence ledger_seq;
create sequence audit_seq;

-- Organization
create table organizations (
  id          text primary key,
  archived_at timestamptz,
  data        jsonb not null
);

-- AppUser
create table users (
  id       text primary key,
  username text not null,
  org_id   text,
  role     text not null,
  status   text not null,
  data     jsonb not null
);
create unique index users_username_lower_key on users (lower(username));
create index users_org_id_idx on users (org_id);

-- ProjectSpace (org_id is the owner's organisation, resolved by the repository)
create table project_spaces (
  id            text primary key,
  org_id        text,
  owner_user_id text not null,
  archived_at   timestamptz,
  data          jsonb not null
);
create index project_spaces_org_id_idx on project_spaces (org_id);
create index project_spaces_owner_user_id_idx on project_spaces (owner_user_id);

-- ProjectMembership (projectKind + projectId name one search or lookup run)
create table project_memberships (
  id           text primary key,
  project_kind text not null,
  project_id   text not null,
  user_id      text not null,
  data         jsonb not null
);
create index project_memberships_project_idx on project_memberships (project_id);
create index project_memberships_user_id_idx on project_memberships (user_id);

-- SpaceMembership
create table space_memberships (
  id       text primary key,
  space_id text not null,
  user_id  text not null,
  data     jsonb not null
);
create index space_memberships_space_id_idx on space_memberships (space_id);
create index space_memberships_user_id_idx on space_memberships (user_id);

-- SearchJob
create table jobs (
  id            text primary key,
  owner_user_id text,
  space_id      text,
  status        text not null,
  created_at    timestamptz not null default now(),
  data          jsonb not null
);
create index jobs_owner_user_id_idx on jobs (owner_user_id);
create index jobs_space_id_idx on jobs (space_id);
create index jobs_created_at_idx on jobs (created_at desc);

-- LookupJob
create table lookup_jobs (
  id            text primary key,
  owner_user_id text,
  space_id      text,
  status        text not null,
  created_at    timestamptz not null default now(),
  data          jsonb not null
);
create index lookup_jobs_owner_user_id_idx on lookup_jobs (owner_user_id);
create index lookup_jobs_space_id_idx on lookup_jobs (space_id);
create index lookup_jobs_created_at_idx on lookup_jobs (created_at desc);

-- CompetitorRecord (owner_user_id is copied from the run's job)
create table competitors (
  id            text primary key,
  run_id        text not null,
  owner_user_id text,
  created_at    timestamptz not null default now(),
  data          jsonb not null
);
create index competitors_run_id_idx on competitors (run_id);

-- CompetitorRecord.recreatedPage content, kept out of the competitor row.
-- Content lives either here (gzip bytes) or in Storage (archive_path), never both.
create table recreated_pages (
  competitor_id text primary key references competitors (id) on delete cascade,
  content       bytea,
  archive_path  text,
  bytes         integer not null default 0,
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz,
  data          jsonb not null default '{}'::jsonb,
  constraint recreated_pages_one_location
    check ((content is not null) <> (archive_path is not null))
);

-- LookupAdRecord
create table lookup_ads (
  id        text primary key,
  lookup_id text not null,
  data      jsonb not null
);
create index lookup_ads_lookup_id_idx on lookup_ads (lookup_id);

-- SearchCompetitorAdRecord
create table search_competitor_ads (
  id            text primary key,
  run_id        text not null,
  competitor_id text not null,
  data          jsonb not null
);
create index search_competitor_ads_run_id_idx on search_competitor_ads (run_id);
create index search_competitor_ads_competitor_id_idx on search_competitor_ads (competitor_id);

-- IcpRecord (source.kind, source.id, stage)
create table icps (
  id          text primary key,
  source_kind text not null,
  source_id   text not null,
  stage       text not null,
  data        jsonb not null,
  constraint icps_source_stage_key unique (source_kind, source_id, stage)
);

-- CreditPeriod (allowance/consumed/reserved mirror the *Subunits fields)
create table credit_periods (
  id        text primary key,
  user_id   text not null,
  status    text not null,
  allowance bigint not null,
  consumed  bigint not null,
  reserved  bigint not null,
  data      jsonb not null
);
create index credit_periods_user_id_idx on credit_periods (user_id);
create unique index credit_periods_one_current_per_user
  on credit_periods (user_id) where status = 'current';

-- CreditLedgerEntry (append-only; seq replaces DatabaseShape.ledgerSeq)
create table credit_ledger (
  seq        bigint primary key default nextval('ledger_seq'),
  id         text not null unique,
  user_id    text not null,
  period_id  text,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
alter sequence ledger_seq owned by credit_ledger.seq;
create index credit_ledger_user_id_idx on credit_ledger (user_id);
create index credit_ledger_period_id_idx on credit_ledger (period_id);
create index credit_ledger_created_at_idx on credit_ledger (created_at);

-- CreditReservation
create table credit_reservations (
  id         text primary key,
  user_id    text not null,
  period_id  text not null,
  status     text not null,
  expires_at timestamptz not null,
  data       jsonb not null
);
create index credit_reservations_user_id_idx on credit_reservations (user_id);
create index credit_reservations_period_id_idx on credit_reservations (period_id);
create index credit_reservations_status_expires_idx on credit_reservations (status, expires_at);

-- ProviderCallRecord (user_id = chargedUserId, created_at = startedAt)
create table provider_calls (
  id         text primary key,
  user_id    text not null,
  run_id     text,
  provider   text not null,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
create index provider_calls_user_id_idx on provider_calls (user_id);
create index provider_calls_run_id_idx on provider_calls (run_id);
create index provider_calls_provider_idx on provider_calls (provider);
create index provider_calls_created_at_idx on provider_calls (created_at);

-- AuditLogEntry (seq replaces DatabaseShape.auditSeq)
create table audit_logs (
  seq        bigint primary key default nextval('audit_seq'),
  id         text not null unique,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
alter sequence audit_seq owned by audit_logs.seq;
create index audit_logs_created_at_idx on audit_logs (created_at);

-- ConversionRuleSet
create table conversion_rule_sets (
  version integer primary key,
  data    jsonb not null
);

-- AppSettings (a single row)
create table app_settings (
  id   text primary key default 'singleton' check (id = 'singleton'),
  data jsonb not null
);

-- AdminAlert
create table admin_alerts (
  id         text primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null
);
create index admin_alerts_created_at_idx on admin_alerts (created_at);

-- LoginAttemptRecord (id = key, the lowercased username; created_at = firstAttemptAt)
create table login_attempts (
  id         text primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null
);

-- DatabaseShape.deletedRunIds
create table deleted_run_ids (
  id         text primary key,
  created_at timestamptz not null default now(),
  data       jsonb not null default '{}'::jsonb
);

-- DatabaseShape.seenPageIds
create table seen_page_ids (
  id   text primary key,
  data jsonb not null default '{}'::jsonb
);
