-- Queue of landing-page recreations. A user runs a few at once; the rest wait
-- as 'queued' until a slot frees. Timestamps are timestamptz like the rest.
create table recreate_jobs (
  id            text primary key,
  owner_user_id text not null,
  competitor_id text not null,
  run_id        text not null,
  space_id      text,
  status        text not null default 'queued',
  options       jsonb not null,
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
create index recreate_jobs_owner_status_created_idx on recreate_jobs (owner_user_id, status, created_at);
