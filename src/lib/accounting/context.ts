import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectKind } from "@/lib/types";

/**
 * Billing context for the current unit of work.
 *
 * Provider calls sit 3–6 frames deep inside the pipeline modules, so instead of
 * threading a user id through every function signature the context is carried
 * in async-local storage and read by the metering wrapper inside each provider
 * client. This works for both request handlers and the `after()` background
 * tasks, because `after()` callbacks inherit the store of the request that
 * scheduled them as long as the context is entered before `after()` resolves.
 */
export interface BillingContext {
  /** Who pressed the button. */
  initiatedByUserId: string;
  /**
   * Who pays. Equal to `initiatedByUserId` in every current flow — including
   * runs inside a project shared by someone else, where the runner pays.
   */
  chargedUserId: string;
  projectKind: ProjectKind | null;
  projectId: string | null;
  runId: string | null;
  /** Run-level hold that individual calls settle against. */
  reservationId: string | null;
  /** Ceiling for this run's total hold, in subunits. */
  runBudgetSubunits: number;
  /** Mutable running total of credits charged inside this context. */
  chargedSubunits: { value: number };
}

const storage = new AsyncLocalStorage<BillingContext>();

export function runWithBillingContext<T>(
  context: Omit<BillingContext, "chargedSubunits">,
  fn: () => T,
): T {
  return storage.run({ ...context, chargedSubunits: { value: 0 } }, fn);
}

export function getBillingContext(): BillingContext | undefined {
  return storage.getStore();
}

/**
 * Attach a reservation to the active context after it has been created.
 * Returns false when there is no active context.
 */
export function setContextReservation(reservationId: string): boolean {
  const context = storage.getStore();
  if (!context) return false;
  context.reservationId = reservationId;
  return true;
}
