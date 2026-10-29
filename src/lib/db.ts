/*
 * The app's data API. Everything here is async and lives in Postgres; this
 * file only re-exports the repositories in src/lib/data/ (it replaced the
 * data/store.json file store). Import from here, or from the repository
 * directly when you need its transaction-level helpers.
 */

export { SCHEMA_VERSION, defaultAppSettings } from "./data/legacyStore";
export type { ImportOwnerOptions, ImportOwnerSummary } from "./data/legacyStore";

export {
  isSearchJobSuppressed,
  clearSearchJobSuppression,
  stopSearchJob,
  isLookupJobSuppressed,
  clearLookupJobSuppression,
  listLookupJobs,
  stopLookupJob,
  isSearchWorkInFlight,
  isLookupWorkInFlight,
  stopAllInFlightWork,
  getSeenPageIds,
  markPageSeen,
  saveJobProgress,
  saveLookupJobProgress,
  saveJob,
  getJob,
  updateJob,
  listJobs,
  listHistoryRuns,
  deleteHistoryRun,
  clearAllHistory,
  saveLookupJob,
  getLookupJob,
  updateLookupJob,
  updateLookupJobWith,
  listLookupHistory,
  deleteLookupHistoryRun,
  clearAllLookupHistory,
} from "./data/runs";

export { getStoreStats, replaceStore, mergeStore } from "./data/importHistory";
export type { ImportResult, StoreStats } from "./data/importHistory";

export {
  saveCompetitor,
  getCompetitorsByRun,
  getRecreateOnlyPagesByRun,
  getCompetitor,
  updateCompetitor,
  updateCompetitorWith,
  listAllCompetitors,
} from "./data/competitors";
export type { CompetitorInput, CompetitorUpdate } from "./data/competitors";

export { getRecreatedPage, setRecreatedPage } from "./data/recreatedPages";

export { getIcps, getIcp, upsertIcp } from "./data/icps";

export {
  saveLookupAd,
  saveLookupAds,
  getLookupAd,
  updateLookupAd,
  updateLookupAdWith,
  getLookupAds,
  saveSearchCompetitorAd,
  saveSearchCompetitorAds,
  getSearchCompetitorAdsByRun,
  getSearchCompetitorAdsByCompetitor,
} from "./data/lookups";

export {
  listUsers,
  getUserById,
  getUsersByIds,
  getUserByUsername,
  getUserByInviteHash,
  countActiveAdmins,
  countActiveOrgAdmins,
  countUsers,
  createUser,
  updateUser,
  toPublicUser,
  listOrganizations,
  getOrganization,
  createOrganization,
  renameOrganization,
  orgUserIds,
} from "./data/identity";
export type { UserPatch, UserCounts } from "./data/identity";

export {
  getAppSettings,
  updateAppSettings,
  recordProviderCreditAlert,
  listAdminAlerts,
  acknowledgeAdminAlerts,
} from "./data/settings";

export {
  getProject,
  listProjects,
  listRunOverview,
  setProjectOwner,
  setProjectArchived,
  listProjectSpaces,
  getProjectSpace,
  getProjectSpacesByIds,
  createProjectSpace,
  setProjectSpaceOwner,
  archiveProjectSpace,
  renameProjectSpace,
  restoreProjectSpace,
  assignRunsToSpace,
  listSpaceMemberships,
  upsertSpaceMembership,
  removeSpaceMembership,
} from "./data/spaces";
export type { ProjectOwnership, RunOverviewRow } from "./data/spaces";
