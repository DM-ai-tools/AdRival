import { randomUUID } from "node:crypto";

import type { StyleDirection } from "../pipeline/skills/playbook";
import type { AwarenessStage } from "../types";
import { getDb, withTx } from "./client";
import { jsonText } from "./jsonText";

/*
 * Queue of landing-page recreations (table recreate_jobs). A user runs a
 * limited number at once; the rest wait as `queued`. claimNextQueued is the
 * only way a job starts: it takes a per-user advisory lock inside a
 * transaction (like the credit operations) so concurrent claims for one user
 * cannot both see a free slot.
 */

export type RecreateJobStatus = "queued" | "running" | "finished" | "failed" | "stopped";

export interface RecreateJobOptions {
  businessUrl: string;
  styleDirection: StyleDirection | null;
  userFeedback: string | null;
  targetIcp: { icpId: string; stage: AwarenessStage } | null;
}

export interface RecreateJob {
  id: string;
  ownerUserId: string;
  competitorId: string;
  runId: string;
  spaceId: string | null;
  status: RecreateJobStatus;
  options: RecreateJobOptions;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobRow {
  id: string;
  owner_user_id: string;
  competitor_id: string;
  run_id: string;
  space_id: string | null;
  status: RecreateJobStatus;
  options: RecreateJobOptions;
  error: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
}

const COLUMNS =
  "id, owner_user_id, competitor_id, run_id, space_id, status, options, error, created_at, started_at, finished_at";

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toJob(r: JobRow): RecreateJob {
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    competitorId: r.competitor_id,
    runId: r.run_id,
    spaceId: r.space_id,
    status: r.status,
    options: r.options,
    error: r.error,
    createdAt: iso(r.created_at),
    startedAt: r.started_at ? iso(r.started_at) : null,
    finishedAt: r.finished_at ? iso(r.finished_at) : null,
  };
}

export async function insertJob(
  input: Omit<RecreateJob, "id" | "status" | "error" | "createdAt" | "startedAt" | "finishedAt">,
): Promise<RecreateJob> {
  const { rows } = await getDb().query<JobRow>(
    `insert into recreate_jobs (id, owner_user_id, competitor_id, run_id, space_id, options)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     returning ${COLUMNS}`,
    [randomUUID(), input.ownerUserId, input.competitorId, input.runId, input.spaceId, jsonText(input.options)],
  );
  return toJob(rows[0]);
}

/** The user's jobs in one space (null = no space), oldest first. */
export async function listJobs(ownerUserId: string, spaceId: string | null): Promise<RecreateJob[]> {
  const { rows } = await getDb().query<JobRow>(
    `select ${COLUMNS} from recreate_jobs
     where owner_user_id = $1 and space_id is not distinct from $2
     order by created_at, id`,
    [ownerUserId, spaceId],
  );
  return rows.map(toJob);
}

/**
 * Moves the user's oldest queued job to running, only while fewer than
 * `maxRunning` of their jobs are running. Returns it, or null.
 */
export async function claimNextQueued(ownerUserId: string, maxRunning: number): Promise<RecreateJob | null> {
  return withTx(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`recreate_jobs:${ownerUserId}`]);
    const { rows } = await tx.query<JobRow>(
      `update recreate_jobs set status = 'running', started_at = now()
       where id = (
         select id from recreate_jobs
         where owner_user_id = $1 and status = 'queued'
         order by created_at, id
         limit 1
       )
       and (select count(*) from recreate_jobs where owner_user_id = $1 and status = 'running') < $2
       returning ${COLUMNS}`,
      [ownerUserId, maxRunning],
    );
    return rows[0] ? toJob(rows[0]) : null;
  });
}

export async function finishJob(
  id: string,
  status: "finished" | "failed" | "stopped",
  error: string | null = null,
): Promise<void> {
  await getDb().query(
    "update recreate_jobs set status = $2, error = $3, finished_at = now() where id = $1",
    [id, status, error],
  );
}

/**
 * finishJob only while the job is still running, so a run that settles late
 * never overwrites a stop (or another outcome) recorded first. True when it
 * was settled now.
 */
export async function settleRunningJob(
  id: string,
  status: "finished" | "failed" | "stopped",
  error: string | null = null,
): Promise<boolean> {
  const { rowCount } = await getDb().query(
    "update recreate_jobs set status = $2, error = $3, finished_at = now() where id = $1 and status = 'running'",
    [id, status, error],
  );
  return rowCount > 0;
}

/**
 * Puts a running job back in the queue (it keeps its place: the queue is
 * ordered by creation). Used when it could not start after all.
 */
export async function requeueJob(id: string): Promise<boolean> {
  const { rowCount } = await getDb().query(
    "update recreate_jobs set status = 'queued', started_at = null where id = $1 and status = 'running'",
    [id],
  );
  return rowCount > 0;
}

export async function getRecreateJob(id: string): Promise<RecreateJob | null> {
  const { rows } = await getDb().query<JobRow>(`select ${COLUMNS} from recreate_jobs where id = $1`, [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** Deletes a queued job of this owner. False when it is missing, not theirs, or already started. */
export async function removeQueued(id: string, ownerUserId: string): Promise<boolean> {
  const { rowCount } = await getDb().query(
    "delete from recreate_jobs where id = $1 and owner_user_id = $2 and status = 'queued'",
    [id, ownerUserId],
  );
  return rowCount > 0;
}

/** How many of the owner's queued jobs (in any space) start before this one; 0 once it has started. */
export async function countQueuedAhead(id: string): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(
    `select count(q.id)::int as n
       from recreate_jobs j
       join recreate_jobs q
         on q.owner_user_id = j.owner_user_id
        and q.status = 'queued'
        and (q.created_at, q.id) < (j.created_at, j.id)
      where j.id = $1 and j.status = 'queued'`,
    [id],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function usersWithQueuedJobs(): Promise<string[]> {
  const { rows } = await getDb().query<{ owner_user_id: string }>(
    "select distinct owner_user_id from recreate_jobs where status = 'queued'",
  );
  return rows.map((r) => r.owner_user_id);
}

export async function listRunning(): Promise<RecreateJob[]> {
  const { rows } = await getDb().query<JobRow>(
    `select ${COLUMNS} from recreate_jobs where status = 'running' order by started_at, id`,
  );
  return rows.map(toJob);
}
