import { maskClientFacingText } from "./clientFacing";
import type { RecreateJob, RecreateJobOptions, RecreateJobStatus } from "./data/recreateJobs";
import type { CompetitorRecord, RecreatedPageLight } from "./types";

/*
 * The Recreate tab's list: the user's queue jobs merged with their recreated
 * pages. A job's page is its version record (made when the job was added);
 * a page with no job is "legacy" (recreated before the queue existed). Only
 * fields chosen here reach the browser: never the design agent's task state,
 * the Undo copy or other stored internals.
 */

/** Finished pages move to the Archived filter this many days after finishing. */
export const ARCHIVE_AFTER_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RecreateListState = RecreateJobStatus | "legacy";

export interface RecreateListItem {
  id: string;
  competitorId: string;
  jobId: string | null;
  state: RecreateListState;
  sourceUrl: string;
  sourceName: string;
  businessName: string | null;
  keyword: string | null;
  styleDirection: string | null;
  targetIcp: { icpId: string; stage: string } | null;
  progress: { pct: number; message: string } | null;
  daysRunning: number | null;
  activeAds: number | null;
  createdAt: string;
  finishedAt: string | null;
  archived: boolean;
  hasPage: boolean;
  openPath: string;
  error: string | null;
}

/** A queue job as the browser gets it (no owner id; the error masked). */
export interface RecreateJobDto {
  id: string;
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

export function toJobDto(job: RecreateJob): RecreateJobDto {
  return {
    id: job.id,
    competitorId: job.competitorId,
    runId: job.runId,
    spaceId: job.spaceId,
    status: job.status,
    options: job.options,
    error: maskClientFacingText(job.error),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

/** True when the page finished more than ARCHIVE_AFTER_DAYS days before `now`. */
export function isArchived(finishedAt: string | null, now: Date): boolean {
  if (!finishedAt) return false;
  const at = Date.parse(finishedAt);
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at > ARCHIVE_AFTER_DAYS * DAY_MS;
}

/** What a run tells about a recreation before its page exists. */
export interface RecreateRunInfo {
  keyword: string | null;
  businessName: string | null;
}

function isBuilding(page: RecreatedPageLight | null | undefined): boolean {
  return page?.status === "pending" || page?.status === "design_pending";
}

/** Days the source page's sample ad has run; null when unknown (stored as -1). */
function daysRunningOf(record: CompetitorRecord | undefined): number | null {
  const days = record?.sampleAd?.daysRunning;
  return typeof days === "number" && Number.isFinite(days) && days >= 0 ? days : null;
}

/** Active ads behind the source page; null when unknown. */
function activeAdsOf(record: CompetitorRecord | undefined): number | null {
  const count = record?.activeAdsCount;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : null;
}

function sourceUrlOf(record: CompetitorRecord | undefined): string {
  return (
    record?.recreateOnly?.sourceUrl ||
    record?.recreatedPage?.sourceAnalyzedUrl ||
    record?.pageAnalysis?.analyzedUrl ||
    record?.sampleAd?.landingPageUrl ||
    ""
  );
}

function progressOf(page: RecreatedPageLight | null | undefined): RecreateListItem["progress"] {
  if (!page?.progress || !isBuilding(page)) return null;
  const pct = Number(page.progress.pct);
  return {
    pct: Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : 0,
    message: maskClientFacingText(page.progress.message) || "",
  };
}

function textOrNull(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text || null;
}

function openPath(competitorId: string): string {
  return `/recreate/${encodeURIComponent(competitorId)}`;
}

function jobItem(job: RecreateJob, record: CompetitorRecord | undefined, run: RecreateRunInfo | undefined, now: Date): RecreateListItem {
  const page = record?.recreatedPage ?? null;
  return {
    id: job.id,
    competitorId: job.competitorId,
    jobId: job.id,
    state: job.status,
    sourceUrl: sourceUrlOf(record),
    sourceName: page?.sourceCompetitorName || record?.pageName || "",
    // The page records what it was built for; before it exists, the run's details.
    businessName: textOrNull(page?.businessName) ?? textOrNull(run?.businessName),
    keyword: textOrNull(page?.keyword) ?? textOrNull(run?.keyword),
    styleDirection: job.options.styleDirection ?? page?.styleDirection ?? null,
    targetIcp: job.options.targetIcp ?? page?.targetIcp ?? null,
    progress: job.status === "running" ? progressOf(page) : null,
    daysRunning: daysRunningOf(record),
    activeAds: activeAdsOf(record),
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    archived: isArchived(job.finishedAt, now),
    hasPage: Boolean(page?.hasPage),
    openPath: openPath(job.competitorId),
    error: maskClientFacingText(job.error),
  };
}

/**
 * A page recreated outside the queue. It counts as finished when it settled
 * (completed or failed), from its last update.
 */
function legacyItem(record: CompetitorRecord, page: RecreatedPageLight, now: Date): RecreateListItem {
  const settled = page.status === "completed" || page.status === "failed";
  const finishedAt = settled ? page.updatedAt || page.createdAt || null : null;
  return {
    id: record.id,
    competitorId: record.id,
    jobId: null,
    state: "legacy",
    sourceUrl: sourceUrlOf(record),
    sourceName: page.sourceCompetitorName || record.pageName || "",
    businessName: textOrNull(page.businessName),
    keyword: textOrNull(page.keyword),
    styleDirection: page.styleDirection ?? null,
    targetIcp: page.targetIcp ?? null,
    progress: progressOf(page),
    daysRunning: daysRunningOf(record),
    activeAds: activeAdsOf(record),
    createdAt: page.createdAt || record.createdAt,
    finishedAt,
    archived: isArchived(finishedAt, now),
    hasPage: Boolean(page.hasPage),
    openPath: openPath(record.id),
    error: page.status === "failed" ? maskClientFacingText(page.error) : null,
  };
}

/**
 * Merges the user's jobs with the records holding their pages, most recent
 * first. `records` holds every job's version (with or without a page yet) and
 * the records with a recreated page; a record with a page and no job becomes
 * a legacy item. `runs` gives a queued job's business and keyword.
 */
export function buildRecreateList(input: {
  jobs: RecreateJob[];
  records: CompetitorRecord[];
  runs?: Map<string, RecreateRunInfo>;
  now: Date;
}): RecreateListItem[] {
  const byId = new Map(input.records.map((r) => [r.id, r]));
  const withJob = new Set(input.jobs.map((j) => j.competitorId));
  const items = input.jobs.map((job) => jobItem(job, byId.get(job.competitorId), input.runs?.get(job.runId), input.now));
  for (const record of byId.values()) {
    if (withJob.has(record.id) || !record.recreatedPage) continue;
    items.push(legacyItem(record, record.recreatedPage, input.now));
  }
  const time = (iso: string) => Date.parse(iso) || 0;
  return items.sort((a, b) => time(b.createdAt) - time(a.createdAt) || b.id.localeCompare(a.id));
}
