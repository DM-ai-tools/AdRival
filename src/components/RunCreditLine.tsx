"use client";

import { formatCredits } from "@/lib/accounting/units";

export interface RunCredits {
  runCreditsCharged: number;
  availableSubunits: number;
  pendingCalls: number;
  lowCredit?: boolean;
}

/**
 * "This run used X credits. You have Y credits available." Shown after a run
 * finishes; pending calls are labelled instead of being reported as final.
 */
export function RunCreditLine({
  credits,
  className,
}: {
  credits: RunCredits | null | undefined;
  className?: string;
}) {
  if (!credits) return null;

  return (
    <p
      className={
        className ??
        (credits.lowCredit ? "run-credit-line is-low" : "run-credit-line")
      }
      role="status"
    >
      This run used {formatCredits(credits.runCreditsCharged)} credits. You have{" "}
      {formatCredits(credits.availableSubunits)} credits available.
      {credits.pendingCalls > 0 ? (
        <>
          {" "}
          <span className="run-credit-pending">
            {credits.pendingCalls} call
            {credits.pendingCalls === 1 ? "" : "s"} still pending
            reconciliation — this total may increase once resolved.
          </span>
        </>
      ) : null}
      {credits.lowCredit ? (
        <>
          {" "}
          <span className="run-credit-pending">
            Your balance is low. Contact your administrator to top up.
          </span>
        </>
      ) : null}
    </p>
  );
}

/** Shown when the backend refuses a run for credit or account reasons. */
export function RunBlockedNotice({
  message,
  code,
}: {
  message: string;
  code?: string | null;
}) {
  const text =
    code === "insufficient_credits"
      ? "You do not have enough credits to run this task. Contact your administrator."
      : message;
  return (
    <p className="credits-warning" role="alert">
      {text}
    </p>
  );
}
