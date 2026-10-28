import { RECREATE_BUILD_OPERATION } from "../accounting/scope";
import { TooManyConcurrentRunsError, runBillable } from "../accounting/run";
import { isCreditError } from "../accounting/errors";
import { sanitizeClientFacingText } from "../clientFacing";
import { getAppSettings, getCompetitor, getUserById } from "../db";
import { deleteCompetitor } from "../data/competitors";
import {
  claimNextQueued,
  getRecreateJob,
  listRunning,
  removeQueued,
  requeueJob,
  settleRunningJob,
  usersWithQueuedJobs,
  type RecreateJob,
} from "../data/recreateJobs";
import type { RecreatedPageLight } from "../types";
import { resumeManusRecreation, runManusRecreation, stopManusRecreation } from "./manus/run";

/*
 * The server-side recreate queue. A user's recreations run up to
 * maxConcurrentRecreationsPerUser at once; the rest wait as `queued` in
 * recreate_jobs. Starting a job, and starting the next when one settles,
 * happens here on the server, so the queue drains with no browser open.
 *
 * Credits are reserved when a job starts (runBillable around the build), never
 * when it is queued. After a restart, sweepRecreateQueue picks the queue up:
 * builds still running on the design agent's side are followed again, and the
 * queued jobs are started.
 */

export const STOP_REASON = "Stopped by user";

/** How often a build resumed after a restart is checked for its outcome. */
function watchMs(): number {
  const ms = Number(process.env.RECREATE_QUEUE_WATCH_MS || "");
  return Number.isFinite(ms) && ms > 0 ? ms : 15_000;
}

/** How long a job waits before trying again when every recreate slot is held by builds outside the queue. */
function retryMs(): number {
  const ms = Number(process.env.RECREATE_QUEUE_RETRY_MS || "");
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
}

/** A resumed build whose page has not changed for this long is taken for dead. */
const STALE_MS = 35 * 60_000;

/** Jobs this process is running or following, so one is never started twice. */
const inFlight = new Set<string>();
/** Users with a retry waiting (see retryLater). */
const retries = new Map<string, ReturnType<typeof setTimeout>>();

export class RecreateJobNotFoundError extends Error {
  constructor() {
    super("This recreation was not found.");
    this.name = "RecreateJobNotFoundError";
  }
}

type Outcome = { status: "finished" | "failed" | "stopped"; error: string | null };

/** How a job ended, from its page; null while the page is still being built. */
function outcomeOf(page: RecreatedPageLight | null | undefined): Outcome | null {
  if (!page) return { status: "failed", error: "Recreation failed" };
  if (page.status === "pending" || page.status === "design_pending") return null;
  if (page.status === "completed" && !page.error) return { status: "finished", error: null };
  return { status: "failed", error: page.error || "Recreation failed" };
}

async function recreateLimit(): Promise<number> {
  // Settings saved before the field existed have no value.
  return (await getAppSettings()).maxConcurrentRecreationsPerUser ?? 3;
}

function logError(what: string) {
  return (err: unknown) => console.error(`[recreate-queue] ${what}`, err);
}

/**
 * Starts the user's queued jobs while they have a free slot. Each runs in the
 * background; when it settles its outcome is recorded and this runs again.
 */
export async function dispatchRecreateQueue(ownerUserId: string): Promise<void> {
  const limit = await recreateLimit();
  // At most `limit` claims a pass: a job that goes back to the queue never makes this loop spin.
  for (let i = 0; i < limit; i += 1) {
    const job = await claimNextQueued(ownerUserId, limit);
    if (!job) return;
    start(job);
  }
}

function start(job: RecreateJob): void {
  if (inFlight.has(job.id)) return;
  inFlight.add(job.id);
  void (async () => {
    let requeued = false;
    try {
      requeued = await runJob(job);
    } catch (err) {
      console.error(`[recreate-queue] job ${job.id} could not be recorded`, err);
    } finally {
      inFlight.delete(job.id);
    }
    if (requeued) retryLater(job.ownerUserId);
    else await dispatchRecreateQueue(job.ownerUserId);
  })().catch(logError(`dispatch after job ${job.id} failed`));
}

/** Runs one claimed job to its end and records the outcome. True when it went back to the queue. */
async function runJob(job: RecreateJob): Promise<boolean> {
  let outcome: Outcome;
  try {
    const user = await getUserById(job.ownerUserId);
    if (!user) {
      outcome = { status: "failed", error: "The account that added this recreation no longer exists." };
    } else {
      await runBillable(
        {
          user,
          operation: RECREATE_BUILD_OPERATION,
          projectKind: "search",
          projectId: job.runId,
          runId: job.runId,
        },
        async () => {
          // Stopped while the credits were reserved: nothing goes to the design agent.
          if ((await getRecreateJob(job.id))?.status !== "running") return null;
          return runManusRecreation(job.competitorId, {
            styleDirection: job.options.styleDirection,
            userFeedback: job.options.userFeedback,
            targetIcp: job.options.targetIcp,
          });
        },
      );
      // A build that was aborted (a stop, or a newer build of the same page) leaves the page pending.
      outcome = outcomeOf((await getCompetitor(job.competitorId))?.recreatedPage) ?? {
        status: "stopped",
        error: "Recreation stopped",
      };
    }
  } catch (err) {
    if (err instanceof TooManyConcurrentRunsError) {
      // Builds started outside the queue hold every slot: wait for one rather than fail.
      if (await requeueJob(job.id)) return true;
      outcome = { status: "failed", error: err.message };
    } else {
      const message = (err as Error)?.message || "Recreation failed";
      outcome = { status: "failed", error: isCreditError(err) ? message : sanitizeClientFacingText(message) };
    }
  }
  if (!(await settleRunningJob(job.id, outcome.status, outcome.error))) {
    await stopLeftover(job);
  }
  return false;
}

/**
 * A job stopped while its build was starting: the build may have created its
 * agent task after the stop was handled. Stops that task and marks the page.
 */
async function stopLeftover(job: RecreateJob): Promise<void> {
  if ((await getRecreateJob(job.id))?.status !== "stopped") return;
  const page = (await getCompetitor(job.competitorId))?.recreatedPage;
  if (!page || page.status === "completed") return;
  await stopManusRecreation(job.competitorId, STOP_REASON).catch(logError(`could not stop the build of job ${job.id}`));
}

/** Tries the user's queue again a little later (once per user at a time). */
function retryLater(ownerUserId: string): void {
  if (retries.has(ownerUserId)) return;
  const timer = setTimeout(() => {
    retries.delete(ownerUserId);
    void dispatchRecreateQueue(ownerUserId).catch(logError(`retry for user ${ownerUserId} failed`));
  }, retryMs());
  timer.unref?.();
  retries.set(ownerUserId, timer);
}

/**
 * Stops a job: a queued one is removed with its empty version; a running one
 * has its build stopped, and the next queued job starts once its slot is free.
 */
export async function stopRecreateJob(jobId: string, ownerUserId: string): Promise<void> {
  let job = await getRecreateJob(jobId);
  if (!job || job.ownerUserId !== ownerUserId) throw new RecreateJobNotFoundError();
  if (job.status === "queued") {
    if (await removeQueued(jobId, ownerUserId)) {
      await deleteCompetitor(job.competitorId);
      return;
    }
    // It started in between: stopped like any running job.
    job = await getRecreateJob(jobId);
  }
  if (!job || job.status !== "running") return;
  if (!(await settleRunningJob(jobId, "stopped", STOP_REASON))) return;
  const page = (await getCompetitor(job.competitorId))?.recreatedPage;
  if (page && (page.status === "pending" || page.status === "design_pending")) {
    await stopManusRecreation(job.competitorId, STOP_REASON).catch(logError(`could not stop the build of job ${jobId}`));
  }
  // A build run here frees its slot when it settles (after its credit hold is
  // released) and starts the next job then; otherwise start it now.
  if (!inFlight.has(jobId)) await dispatchRecreateQueue(ownerUserId);
}

/**
 * Picks the queue up (after a restart, and whenever the list is read): running
 * builds this process does not follow are followed again, jobs whose page
 * settled are recorded, and queued jobs are started. `ownerUserId` limits it
 * to one user.
 */
export async function sweepRecreateQueue(ownerUserId?: string): Promise<void> {
  const running = (await listRunning()).filter((j) => !ownerUserId || j.ownerUserId === ownerUserId);
  for (const job of running) {
    if (inFlight.has(job.id)) continue;
    inFlight.add(job.id);
    let watching = false;
    try {
      const page = (await getCompetitor(job.competitorId))?.recreatedPage;
      if (!page || (!page.manus?.taskId && outcomeOf(page) === null)) {
        // It never reached the design agent: nothing was spent, so it starts again.
        await requeueJob(job.id);
        continue;
      }
      const outcome = outcomeOf(page);
      if (outcome) {
        await settleRunningJob(job.id, outcome.status, outcome.error);
        continue;
      }
      await resumeManusRecreation(job.competitorId);
      watch(job);
      watching = true;
    } catch (err) {
      console.error(`[recreate-queue] could not pick up job ${job.id}`, err);
    } finally {
      if (!watching) inFlight.delete(job.id);
    }
  }
  const owners = ownerUserId ? [ownerUserId] : await usersWithQueuedJobs();
  for (const owner of owners) {
    await dispatchRecreateQueue(owner).catch(logError(`dispatch for user ${owner} failed`));
  }
}

/**
 * Follows a build resumed after a restart (its run has no settle of its own
 * here) until its page settles, records the outcome, then starts the next job.
 * The job is in `inFlight` until this ends.
 */
function watch(job: RecreateJob): void {
  const since = Date.now();
  void (async () => {
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, watchMs()));
        if ((await getRecreateJob(job.id))?.status !== "running") return;
        const page = (await getCompetitor(job.competitorId))?.recreatedPage;
        const outcome = outcomeOf(page);
        if (outcome) {
          await settleRunningJob(job.id, outcome.status, outcome.error);
          return;
        }
        const updated = Date.parse(page?.updatedAt || "") || 0;
        if (Date.now() - Math.max(updated, since) > STALE_MS) {
          await settleRunningJob(job.id, "failed", "The design agent stopped responding. Add the page again.");
          return;
        }
      }
    } finally {
      inFlight.delete(job.id);
      await dispatchRecreateQueue(job.ownerUserId).catch(logError(`dispatch after job ${job.id} failed`));
    }
  })().catch(logError(`following job ${job.id} failed`));
}
