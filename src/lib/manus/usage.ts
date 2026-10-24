import { recordIncurredUsage } from "../accounting/meter";
import { sumProviderRequestUsage } from "../accounting/service";
import type { ProjectKind } from "../types";
import { getManusTask } from "./client";

/**
 * Manus bills a task in its own credits and reports the running total on the
 * task (`credit_usage`). Each time a task stops, the credits not yet recorded
 * for it go to the ledger, so a task that is continued later (page edits, the
 * next ring of a search) is never counted twice.
 */

export async function recordManusTaskCredits(input: {
  taskId: string;
  operation: string;
  /** Who pays when no billing context is active (a run resumed after a restart). */
  fallbackUserId?: string | null;
  projectKind?: ProjectKind | null;
  projectId?: string | null;
  runId?: string | null;
}): Promise<number> {
  let total: number;
  try {
    total = Number((await getManusTask(input.taskId)).credit_usage);
  } catch (err) {
    console.warn(`[manus] could not read credit usage for task ${input.taskId}`, (err as Error).message);
    return 0;
  }
  if (!Number.isFinite(total) || total <= 0) return 0;
  // Credits already recorded for this task.
  const recorded = await sumProviderRequestUsage("manus", input.taskId);
  const delta = Math.round((total - recorded) * 100) / 100;
  if (delta <= 0) return 0;
  await recordIncurredUsage({
    provider: "manus",
    operation: input.operation,
    usage: { requests: delta },
    providerRequestId: input.taskId,
    // The same total read twice is one record.
    idempotencyKey: `manus:${input.taskId}:${total}`,
    fallbackUserId: input.fallbackUserId,
    projectKind: input.projectKind,
    projectId: input.projectId,
    runId: input.runId,
  });
  return delta;
}

/**
 * Records now and once more a little later: Manus can finish counting a
 * task's credits after it reports the task stopped.
 */
export function recordManusTaskCreditsSoon(input: Parameters<typeof recordManusTaskCredits>[0], laterMs = 3 * 60_000): void {
  void recordManusTaskCredits(input).finally(() => {
    const timer = setTimeout(() => void recordManusTaskCredits(input), laterMs);
    timer.unref?.();
  });
}
