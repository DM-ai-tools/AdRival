import type { RecreateListItem } from "./recreateList";

/*
 * How the Recreate tab lays out its list. Pure: no React, no browser.
 */

const time = (iso: string) => Date.parse(iso) || 0;

/**
 * Running items fill the slots, oldest start first. The server runs at most
 * `limit` (normally 3) jobs, but a page being built by the old route shows as
 * running too: those stay visible, so slots can hold more than the limit
 * (the hub then shows no empty slot). Queued items wait oldest first; the rest
 * are recent (newest first), or archived once finished long enough ago.
 */
export function splitItems(items: RecreateListItem[]): {
  slots: RecreateListItem[];
  queue: RecreateListItem[];
  recent: RecreateListItem[];
  archived: RecreateListItem[];
} {
  const oldestFirst = (a: RecreateListItem, b: RecreateListItem) =>
    time(a.createdAt) - time(b.createdAt) || a.id.localeCompare(b.id);
  const newestFirst = (a: RecreateListItem, b: RecreateListItem) => oldestFirst(b, a);
  const slots = items.filter((i) => i.state === "running").sort(oldestFirst);
  const queue = items.filter((i) => i.state === "queued").sort(oldestFirst);
  const rest = items.filter((i) => i.state !== "running" && i.state !== "queued");
  return {
    slots,
    queue,
    recent: rest.filter((i) => !i.archived).sort(newestFirst),
    archived: rest.filter((i) => i.archived).sort(newestFirst),
  };
}

/** The message for a Stop/Remove that failed: the server's reason, else a generic one (status null: the request itself failed). */
export function stopFailureMessage(status: number | null, serverMessage?: string | null): string {
  const reason = (serverMessage ?? "").trim();
  if (status === null) return "Could not reach the server to stop this page. Try again.";
  return reason || "Could not stop this page. Try again.";
}

/** A pill class for each state, using the colours the app already defines. */
export const STATE_PILL_CLASS: Record<RecreateListItem["state"], string> = {
  queued: "status-queued",
  running: "status-running",
  finished: "status-completed",
  legacy: "status-completed",
  failed: "status-failed",
  stopped: "status-partial",
};

export interface PollScheduler {
  /** Arms the next run (replacing any pending one). No-op once stopped. */
  schedule(): void;
  /** Runs now (e.g. on an event), then arms the next. Never creates a second chain. */
  trigger(): Promise<void>;
  /** Cancels the pending run; nothing runs or arms afterwards. */
  stop(): void;
}

/**
 * One chain of timed runs: at most one pending timer at any time, and nothing
 * fires after stop(). `paused()` skips a due run without re-arming (the owner
 * calls trigger() when it should resume).
 */
export function createPollScheduler(opts: {
  intervalFor: () => number;
  run: () => Promise<void>;
  paused?: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PollScheduler {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let handle: unknown = null;
  let stopped = false;

  const clear = () => {
    if (handle !== null) clearTimer(handle);
    handle = null;
  };
  const schedule = () => {
    if (stopped) return;
    clear();
    handle = setTimer(async () => {
      handle = null;
      if (stopped || opts.paused?.()) return;
      await opts.run();
      schedule();
    }, opts.intervalFor());
  };
  return {
    schedule,
    async trigger() {
      if (stopped) return;
      clear();
      await opts.run();
      schedule();
    },
    stop() {
      stopped = true;
      clear();
    },
  };
}
