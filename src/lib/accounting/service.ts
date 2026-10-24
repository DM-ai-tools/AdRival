/*
 * Credit accounting. The implementation is the Postgres repository in
 * src/lib/data/accountingService.ts; this module keeps the import path.
 * Functions that took the file store's `db` take a transaction handle there.
 */

export {
  RESERVATION_TTL_MS,
  userHasUnlimitedCredits,
  availableSubunits,
  ensureCurrentPeriod,
  initializeUserCredits,
  listPeriods,
  setAllowance,
  addCredits,
  recordAdjustment,
  setResetCadence,
  recoverAbandonedReservations,
  sweepAbandonedReservations,
  reserveCredits,
  touchReservation,
  extendReservation,
  releaseReservation,
  getReservation,
  settleProviderCall,
  getCreditSummary,
  queryProviderCalls,
  usageByProvider,
  usageByDate,
  usageByRun,
  creditsForRun,
  creditsByRun,
  sumProviderRequestUsage,
  currentPeriodTotals,
  listRunReservations,
  countOpenReservations,
  listPendingReconciliation,
  resolveReconciliation,
  assertSpendStillAuthorized,
} from "@/lib/data/accountingService";
export type {
  AllowanceChange,
  ReserveResult,
  SettleInput,
  SettleResult,
  CreditSummary,
  UsageQuery,
  ProviderBreakdownRow,
  RunUsageRow,
  PeriodTotals,
} from "@/lib/data/accountingService";
