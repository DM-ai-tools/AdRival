"use client";

import { formatCredits } from "@/lib/accounting/units";
import { formatDate, providerLabel } from "@/lib/credits/display";
import type { CreditsPayload } from "@/lib/credits/useCredits";

const CADENCE_LABELS: Record<string, string> = {
  none: "Manual allocation",
  monthly: "Monthly reset",
};

/**
 * Allowance / consumed / reserved / available, plus the provider breakdown.
 * Rendered from the caller's own summary only.
 */
export function CreditSummaryPanel({
  data,
  loading,
  error,
  compact = false,
}: {
  data: CreditsPayload | null;
  loading: boolean;
  error: string | null;
  compact?: boolean;
}) {
  if (loading && !data) {
    return (
      <section className="panel glow-panel credits-panel">
        <h2>Credits</h2>
        <p className="muted">Loading credit balance…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="panel glow-panel credits-panel">
        <h2>Credits</h2>
        <p className="error-text" role="alert">
          {error}
        </p>
      </section>
    );
  }

  if (!data) return null;

  const { credits, usageByProvider } = data;
  const hasAllowance = credits.allowanceSubunits > 0;
  const unlimited = credits.unlimited;

  return (
    <section className="panel glow-panel credits-panel">
      <div className="progress-head">
        <h2>Credits</h2>
        <span className="status-pill">
          {unlimited
            ? "Not limited"
            : (CADENCE_LABELS[credits.resetCadence] ?? credits.resetCadence)}
        </span>
      </div>

      <dl className="progress-stats credits-stats">
        <div>
          <dt>Allowance</dt>
          <dd>{unlimited ? "Unlimited" : formatCredits(credits.allowanceSubunits)}</dd>
        </div>
        <div>
          <dt>Consumed</dt>
          <dd>{formatCredits(credits.consumedSubunits)}</dd>
        </div>
        <div>
          <dt>Reserved by active runs</dt>
          <dd>{formatCredits(credits.reservedSubunits)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd className={!unlimited && credits.lowCredit ? "credits-low" : undefined}>
            {unlimited ? "Unlimited" : formatCredits(credits.availableSubunits)}
          </dd>
        </div>
      </dl>

      {unlimited ? (
        <p className="muted credits-period">
          Administrators are not limited by credits. Provider usage is still
          recorded below.
        </p>
      ) : (
        <p className="muted credits-period">
          {credits.periodStartsAt
            ? `Current period started ${formatDate(credits.periodStartsAt)}`
            : "No allocation period yet."}
          {credits.nextResetAt
            ? ` · Next reset ${formatDate(credits.nextResetAt)}`
            : " · No scheduled reset"}
        </p>
      )}

      {unlimited ? null : !hasAllowance ? (
        <p className="credits-warning" role="status">
          You have no credit allowance yet. Contact your administrator to get
          credits before running a task.
        </p>
      ) : credits.lowCredit ? (
        <p className="credits-warning" role="status">
          Low credit balance — {formatCredits(credits.availableSubunits)} credits
          remaining. Contact your administrator to top up.
        </p>
      ) : null}

      {credits.pendingReconciliationCount > 0 ? (
        <p className="credits-pending" role="status">
          {credits.pendingReconciliationCount} call
          {credits.pendingReconciliationCount === 1 ? "" : "s"} awaiting
          reconciliation ({formatCredits(credits.pendingReconciliationSubunits)}{" "}
          credits held). Your balance will update once your administrator
          resolves them.
        </p>
      ) : null}

      {!compact ? (
        <>
          <h3 className="credits-subhead">Usage by provider</h3>
          {usageByProvider.length === 0 ? (
            <p className="empty-hint">No provider usage recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="comp-table">
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Calls</th>
                    <th>Credits</th>
                    <th>Confirmed</th>
                    <th>Estimated</th>
                    <th>Pending</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {usageByProvider.map((row) => (
                    <tr key={row.provider}>
                      <td>{providerLabel(row.provider)}</td>
                      <td>{row.calls}</td>
                      <td>{formatCredits(row.creditsCharged)}</td>
                      <td>{row.confirmedCalls}</td>
                      <td>{row.estimatedCalls}</td>
                      <td>{row.pendingCalls}</td>
                      <td>{row.failedCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
