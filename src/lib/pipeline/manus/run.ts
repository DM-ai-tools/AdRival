import type {
  AwarenessStage,
  BusinessProfile,
  CompetitorRecord,
  ManusRecreationState,
  RecreatedLandingPage,
  RecreatedPageHeavy,
  RecreatedPageLight,
  RecreationProgressDetails,
  RecreationProgressStage,
  SearchJob,
} from "../../types";
import { RECREATED_PAGE_HEAVY_KEYS } from "../../types";
import { ArchivedPageUnavailableError } from "../../data/archive";
import {
  getCompetitor,
  getIcp,
  getIcps,
  getJob,
  getRecreatedPage,
  updateCompetitorWith,
  type CompetitorUpdate,
} from "../../db";
import type { IcpRecord } from "../../types";
import { LOOKUP_RECREATE_PREFIX } from "../lookupRecreateBridge";
import { getBillingContext } from "../../accounting/context";
import { touchReservation } from "../../accounting/service";
import { isCreditError } from "../../accounting/errors";
import { analysisSetupMessage, businessProfileAnalyzer, sameWebsite } from "../businessProfile";
import { sanitizeClientFacingText } from "../../clientFacing";
import { resolveBrandDisplayName } from "../brandDisplayName";
import { embedRemoteImagesInHtml } from "../design/packageHtml";
import { offerFitsSearchedService, searchedServiceFocus } from "../offerServiceFocus";
import type { StyleDirection } from "../skills/playbook";
import {
  confirmManusAction,
  createManusTask,
  getManusTask,
  hasManusKey,
  latestManusEvents,
  listManusConnectors,
  manusEventsSince,
  sendManusMessage,
  stopManusTask,
  type ManusAttachment,
  type ManusContentPart,
  type ManusEvent,
  type ManusStatusDetail,
} from "../../manus/client";
import {
  MANUS_HTML_FILENAME,
  MANUS_RESULT_SCHEMA,
  buildAnswerContext,
  buildManusBrief,
  buildManusEditMessage,
  buildManusTaskMessage,
  pageServiceFocus,
  type ManusBriefInput,
  type ManusResult,
} from "./brief";
import { answerAgentQuestion } from "./answer";
import { loadAssets, saveAssets, type UserAsset } from "./assets";
import { describeRepeats, repeatedImages } from "./imageCheck";
import { activityFromEvents, confirmationFor, plainText } from "../../manus/events";
import { findManusProject, matchManusProject, projectKey } from "../../manus/projects";
import { recordManusTaskCreditsSoon } from "../../manus/usage";

export { activityFromEvents, matchManusProject };

/**
 * Landing page recreation by the Manus agent. (The earlier built-in
 * pipeline is kept on the git branch backup/both-recreate-pipelines-2026-10-07.)
 *
 * The agent runs on Manus's servers: we send the brief, poll the task, answer
 * its questions with the fast OpenAI model, handle confirmations, then
 * download the HTML file it attaches. The task id is saved on the page, so a
 * restart picks the run up again (see resumeManusRecreation).
 */

export const MANUS_PIPELINE_VERSION = "manus-1";

const POLL_MS = 10_000;
/** How often an unchanged run still saves a heartbeat, so it is not taken for dead. */
const HEARTBEAT_MS = 60_000;
const RESERVATION_TOUCH_MS = 5 * 60_000;
/** Questions answered by the model per run; after that the default answer is sent. */
const MAX_MODEL_ANSWERS = 8;
/** Times a finished run without an HTML file is asked to attach one. */
const MAX_NUDGES = 2;
/**
 * After the agent stops, how long its structured report may lag behind the
 * page. Manus prepares it as a background job; the page is taken without it
 * after this.
 */
const REPORT_WAIT_MS = 60_000;
/** After the agent stops without attaching a page, how long background jobs may still deliver one before it is asked for. */
const FILE_WAIT_MS = 3 * 60_000;

/** Times a delivered page that repeats an image goes back to the agent before it is shown with a note. */
const MAX_IMAGE_FIXES = 1;

function repeatFixMessage(lines: string[]): string {
  return `Some images appear more than once on the page you delivered:
${lines.map((l) => `- ${l}`).join("\n")}

Replace every repeat so each photo appears only once. For each repeated spot use another suitable image: the user's images or the client's website first; create a new one with the OpenAI connector (gpt-image-2) only if none fits, or build that spot without a photo the way the competitor would look. Keep everything else exactly as it is, re-check the page, and attach the complete updated ${MANUS_HTML_FILENAME}. Do not deploy or publish anything.`;
}

const NUDGE_MESSAGE = `Please attach the complete final page as a single self-contained ${MANUS_HTML_FILENAME} file (inline CSS and JS, images as data URIs or absolute https URLs) to your reply. Do not deploy or publish it.`;

/** How long one build (or change) may run before it is stopped: MANUS_TIMEOUT_MINUTES, default 90. */
export function manusTimeoutMs(): number {
  const minutes = Number(process.env.MANUS_TIMEOUT_MINUTES || 90);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 90) * 60_000;
}

const timeoutMs = manusTimeoutMs;

function agentProfile(): string {
  return process.env.MANUS_AGENT_PROFILE?.trim() || "standard";
}

/**
 * Connectors every task gets: MANUS_CONNECTORS (names or ids, comma separated;
 * default Firecrawl and OpenAI), looked up among the account's installed
 * connectors. Undefined when none is found, so the account's defaults apply.
 */
async function manusConnectors(): Promise<string[] | undefined> {
  const wanted = (process.env.MANUS_CONNECTORS ?? "Firecrawl,OpenAI")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!wanted.length) return undefined;
  let installed: Array<{ id: string; name: string }> = [];
  try {
    installed = await listManusConnectors();
  } catch (err) {
    console.warn("[manus] could not list connectors; the account's defaults apply", (err as Error).message);
    return undefined;
  }
  const ids: string[] = [];
  for (const want of wanted) {
    const hit =
      installed.find((c) => c.id === want) ||
      installed.find((c) => projectKey(c.name) === projectKey(want)) ||
      installed.find((c) => projectKey(c.name).startsWith(projectKey(want)));
    if (hit) ids.push(hit.id);
    else console.warn(`[manus] connector "${want}" is not connected in the Manus account`);
  }
  return ids.length ? Array.from(new Set(ids)) : undefined;
}

/** The Manus project (cloud folder) recreate tasks go into unless MANUS_PROJECT_NAME/ID says otherwise. */
const DEFAULT_PROJECT_NAME = "redeisgn pipeline";

/**
 * The Manus project (cloud folder) every task goes into: MANUS_PROJECT_ID, or
 * the project named MANUS_PROJECT_NAME. Null when neither is set. A name that
 * matches no project stops the run rather than putting the task elsewhere.
 */
async function manusProject(): Promise<{ id: string; name: string } | null> {
  const id = process.env.MANUS_PROJECT_ID?.trim();
  if (id) return { id, name: id };
  // Empty MANUS_PROJECT_NAME= turns the folder off; unset uses the team's folder.
  const name = (process.env.MANUS_PROJECT_NAME ?? DEFAULT_PROJECT_NAME).trim();
  if (!name) return null;
  const found = await findManusProject(name);
  if ("missing" in found) {
    throw new Error(`The design agent project "${name}" was not found. Projects in the account: ${found.missing}. Set MANUS_PROJECT_NAME to one of them.`);
  }
  return found;
}

export function isManusPage(page: RecreatedLandingPage | null | undefined): boolean {
  return Boolean(page?.pipelineVersion?.startsWith("manus"));
}

export function isManusRunActive(page: RecreatedLandingPage | null | undefined): boolean {
  if (!page || !isManusPage(page) || !page.manus?.taskId) return false;
  if (page.status !== "pending" && page.status !== "design_pending") return false;
  const updated = Date.parse(page.updatedAt || "");
  return Number.isFinite(updated) && Date.now() - updated < 30 * 60 * 1000;
}

// ── Stages ──────────────────────────────────────────────────────────────

type StageId = "send" | "study" | "build" | "check" | "deliver";

const STAGES: Array<{ id: StageId; label: string; weight: number }> = [
  { id: "send", label: "Sending the brief", weight: 5 },
  { id: "study", label: "Studying the competitor page and your brand", weight: 25 },
  { id: "build", label: "Building the page", weight: 40 },
  { id: "check", label: "Checking it against the competitor", weight: 20 },
  { id: "deliver", label: "Collecting the finished page", weight: 10 },
];

function stagesAt(active: StageId, opts: { blocked?: string; done?: boolean } = {}): RecreationProgressStage[] {
  const at = STAGES.findIndex((s) => s.id === active);
  return STAGES.map((s, i) => ({
    id: s.id,
    label: s.label,
    weight: s.weight,
    status:
      opts.done || i < at
        ? "done"
        : i === at
          ? opts.blocked
            ? "blocked"
            : "active"
          : "pending",
    detail: i === at && opts.blocked ? opts.blocked : null,
  }));
}

/** Which stage an agent plan step belongs to, from its wording. */
function stageForStep(title: string): StageId | null {
  const t = title.toLowerCase();
  if (/(verif|check|compar|review|test|qa\b|screenshot.*(final|result)|validat|fix)/.test(t)) return "check";
  if (/(deliver|attach|final|export|package|send)/.test(t)) return "deliver";
  if (/(build|code|creat|implement|write|develop|assembl|html|css|generat|design)/.test(t)) return "build";
  if (/(analy|research|stud|captur|screenshot|inspect|review the|explor|gather|extract|brand|competitor|visit|open)/.test(t)) return "study";
  return null;
}

// ── Saving ──────────────────────────────────────────────────────────────

/** The stored page (light: its html and other content via getRecreatedPage). */
async function latestPage(competitorId: string): Promise<RecreatedPageLight> {
  const page = (await getCompetitor(competitorId))?.recreatedPage;
  if (!page) throw new Error("Competitor not found");
  return page;
}

/** A change to the page; html, previousHtml, generatedImages and sourceArchive are page content. */
type PagePatch = Partial<RecreatedLandingPage>;

/**
 * The competitor update for `patch` on the stored page: light fields merge
 * onto the page; content fields replace those fields of the stored content
 * (the other content fields are kept), in the same write.
 */
function pageUpdate(
  page: RecreatedPageLight,
  patch: PagePatch,
  content: RecreatedPageHeavy | null | undefined,
): CompetitorUpdate {
  const light: Record<string, unknown> = { ...patch };
  const heavy: Record<string, unknown> = {};
  let carriesHeavy = false;
  for (const key of RECREATED_PAGE_HEAVY_KEYS) {
    if (!(key in light)) continue;
    carriesHeavy = true;
    heavy[key] = light[key];
    delete light[key];
  }
  const recreatedPage = { ...page, ...light, updatedAt: new Date().toISOString() } as RecreatedPageLight;
  if (!carriesHeavy) return { recreatedPage };
  if (content === undefined) throw new Error("Page content was not loaded for this change");
  const merged = { ...(content || {}), ...heavy } as Partial<RecreatedPageHeavy>;
  return { recreatedPage, recreatedPageHeavy: { ...merged, html: merged.html ?? null } };
}

/**
 * Applies a change to the stored page in one write. A function gets the page
 * as stored at that moment (so a change built from it never overwrites one
 * saved in between). Returns the saved page.
 */
function savePage(
  competitorId: string,
  patch: PagePatch | ((page: RecreatedPageLight) => PagePatch),
): Promise<RecreatedPageLight> {
  const withContent = typeof patch !== "function" && RECREATED_PAGE_HEAVY_KEYS.some((key) => key in patch);
  return writePage(
    competitorId,
    (page, content) => pageUpdate(page, typeof patch === "function" ? patch(page) : patch, content),
    withContent,
  );
}

/** savePage for a change that reads the page content (html, previousHtml...). */
function savePageWithContent(
  competitorId: string,
  patch: (page: RecreatedPageLight, content: RecreatedPageHeavy | null) => PagePatch,
): Promise<RecreatedPageLight> {
  return writePage(competitorId, (page, content) => pageUpdate(page, patch(page, content ?? null), content), true);
}

/**
 * Records how a run ended (a failure or a stop). `hasHtml` says whether a page
 * is still there to show, from the stored content; when that content is
 * archived and Storage cannot be read, the light page's marker (hasPage)
 * decides, so recording the outcome never fails because Storage is down.
 */
async function saveOutcome(
  competitorId: string,
  patch: (stored: RecreatedPageLight, hasHtml: boolean) => PagePatch,
): Promise<RecreatedPageLight> {
  try {
    return await savePageWithContent(competitorId, (stored, content) => patch(stored, Boolean(content?.html)));
  } catch (err) {
    if (!(err instanceof ArchivedPageUnavailableError)) throw err;
    console.warn(`[manus] page content of competitor ${competitorId} unavailable (${err.message}); using its marker`);
    return savePage(competitorId, (stored) => patch(stored, Boolean(stored.hasPage)));
  }
}

async function writePage(
  competitorId: string,
  update: (page: RecreatedPageLight, content: RecreatedPageHeavy | null | undefined) => CompetitorUpdate,
  withContent: boolean,
): Promise<RecreatedPageLight> {
  const saved = await updateCompetitorWith(
    competitorId,
    (competitor, content) => {
      if (!competitor.recreatedPage) throw new Error("Competitor not found");
      return update(competitor.recreatedPage, content);
    },
    { withContent },
  );
  if (!saved?.recreatedPage) throw new Error("Competitor not found");
  return saved.recreatedPage;
}

async function saveState(competitorId: string, patch: Partial<ManusRecreationState>): Promise<ManusRecreationState> {
  const page = await savePage(competitorId, (stored) => {
    if (!stored.manus) throw new Error("This page has no design agent task");
    return { manus: { ...stored.manus, ...patch } };
  });
  return page.manus!;
}

/** Colours of a page whose client colours are not known. */
const NEUTRAL_COLORS = {
  primary: "#0F7A6C",
  secondary: "#134E4A",
  accent: "#F59E0B",
  background: "#FFFFFF",
  text: "#0F172A",
};

/**
 * Shows on the page that its build is reading the client's website (see
 * isReadingWebsite). The page's content and its other fields are kept; a
 * record without a page gets a pending one. Returns the read's id: the build
 * goes on only while the page still shows this read (claimReading), so a Stop
 * or a newer build in the meantime wins.
 */
async function markReading(competitor: CompetitorRecord, job: SearchJob, businessUrl: string): Promise<string> {
  const readingId = crypto.randomUUID();
  const reading = { ...progress("send", `Reading ${hostOf(businessUrl)}…`, 1), phase: READING_PHASE };
  const now = new Date().toISOString();
  await updateCompetitorWith(competitor.id, (stored) => ({
    recreatedPage: stored.recreatedPage
      ? { ...stored.recreatedPage, status: "pending", error: null, progress: reading, readingId, updatedAt: now }
      : ({
          readingId,
          createdAt: now,
          updatedAt: now,
          status: "pending",
          businessUrl,
          keyword: job.keywords?.[0] || job.keyword,
          sourceCompetitorName: competitor.pageName,
          sourceAnalyzedUrl: competitor.pageAnalysis?.analyzedUrl || "",
          brandColors: NEUTRAL_COLORS,
          pipelineVersion: MANUS_PIPELINE_VERSION,
          error: null,
          manus: null,
          progress: reading,
        } as RecreatedPageLight),
  }));
  return readingId;
}

/**
 * Ends the read `readingId` in one write when the page still shows it (true:
 * the build may go on). False when the read was stopped, timed out, or a newer
 * build took the page over: that build then creates nothing.
 */
async function claimReading(competitorId: string, readingId: string): Promise<boolean> {
  let ours = false;
  await updateCompetitorWith(competitorId, (stored) => {
    const page = stored.recreatedPage;
    ours = Boolean(page && page.status === "pending" && page.progress?.phase === READING_PHASE && page.readingId === readingId);
    return ours && page ? { recreatedPage: { ...page, readingId: null, updatedAt: new Date().toISOString() } } : null;
  });
  return ours;
}

/** Shown on a page whose website read never finished (a restart cut it off). */
const READING_INTERRUPTED = "The website read was interrupted. Try again.";

/**
 * Marks the page failed when it still shows a website read older than the
 * reading window (the process doing it is gone). True when it did.
 */
export async function expireStaleReading(competitorId: string): Promise<boolean> {
  const page = (await getCompetitor(competitorId))?.recreatedPage;
  if (!page || page.status !== "pending" || page.progress?.phase !== READING_PHASE || isReadingWebsite(page)) return false;
  await saveOutcome(competitorId, (_stored, hasHtml) => ({
    status: hasHtml ? "completed" : "failed",
    error: READING_INTERRUPTED,
    readingId: null,
    progress: progress("send", READING_INTERRUPTED, 0, { blocked: READING_INTERRUPTED }),
  }));
  return true;
}

/** Records on the page that reading the client's website failed (the earlier page, if any, stays). */
async function recordReadFailure(competitorId: string, err: unknown): Promise<void> {
  const raw = (err as Error)?.message || "Recreation failed";
  const message = isCreditError(err) ? raw : sanitizeClientFacingText(raw);
  try {
    await saveOutcome(competitorId, (_stored, hasHtml) => ({
      status: hasHtml ? "completed" : "failed",
      error: message,
      progress: progress("send", message, 0, { blocked: message }),
    }));
  } catch (writeErr) {
    console.error(`[manus] could not record the failed website read of competitor ${competitorId}`, writeErr);
  }
}

type Activity = NonNullable<NonNullable<RecreationProgressDetails>["activity"]>;

function progress(
  stage: StageId,
  message: string,
  pct: number,
  opts: { blocked?: string; done?: boolean; activity?: Activity | null } = {},
) {
  return {
    phase: opts.done ? "ready" : opts.blocked ? "failed" : stage,
    message,
    pct: Math.max(0, Math.min(opts.done ? 100 : 99, Math.round(pct))),
    stages: stagesAt(stage, opts),
    indeterminate: false,
    details: opts.activity?.length ? { activity: opts.activity } : null,
  };
}

/** Items kept in the live feed. */
const ACTIVITY_LIMIT = 30;


/** Which stage a piece of activity points to, or null when it says nothing about it. */
export function stageForActivity(text: string): StageId | null {
  const t = text.toLowerCase();
  if (/(attach|deliver|final page|packag|export)/.test(t)) return "deliver";
  if (/(compar|verif|\bqa\b|side[- ]by[- ]side|overlap|review(ing)? (the|my) (page|rebuild|build)|screenshot.*(index|rebuild|local|result)|fix(ing)? )/.test(t)) return "check";
  if (/(index\.html|writ|creat|build|editing file|generat|image|css|section by section|implement|code)/.test(t)) return "build";
  if (/(brows|visit|navigat|scrap|crawl|fetch|search|inspect|captur|screenshot|measur|analy|stud|brief)/.test(t)) return "study";
  return null;
}

/** Where each stage starts and ends on the bar. */
const STAGE_RANGE: Record<StageId, [number, number]> = {
  send: [0, 6],
  study: [6, 35],
  build: [35, 75],
  check: [75, 92],
  deliver: [92, 98],
};

// ── Inputs ──────────────────────────────────────────────────────────────

function resolveBusinessUrl(job: Pick<SearchJob, "businessUrl" | "businessProfile">): string | null {
  const url = (job.businessUrl || "").trim() || (job.businessProfile?.url || "").trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** The business profile saved on a version for `businessUrl`, when it has one for that website. */
function versionProfile(competitor: CompetitorRecord, businessUrl: string): BusinessProfile | null {
  const saved = competitor.recreateOnly?.businessProfile;
  return saved && sameWebsite(saved.url, businessUrl) ? saved : null;
}

/** Saves (or, with null, drops) the business profile kept on a version. */
async function saveVersionProfile(competitorId: string, profile: BusinessProfile | null): Promise<void> {
  await updateCompetitorWith(competitorId, (stored) =>
    stored.recreateOnly ? { recreateOnly: { ...stored.recreateOnly, businessProfile: profile } } : null,
  );
}

/**
 * The business a build for `businessUrl` writes the page for, when it is not
 * the search's own: the version's saved profile for that website, else that
 * website analysed now (inside the build's credit reservation) and saved on
 * the version, so retries, rebuilds and changes reuse it. Null when the
 * website is the search's own (the search's profile applies, as before; a
 * profile the version kept for another website is dropped).
 *
 * The search's own website is its business profile's: the run's businessUrl
 * cannot tell, since adding a job saves that job's website on the run. A
 * search without a profile (or one without a website) has no business to
 * keep, so the job's website is analysed.
 *
 * `fresh` is true for a profile read now that the version should keep: the
 * build saves it once it goes ahead (with the page it starts). A profile
 * without brand colours (the brand read found none) is used for the brief's
 * name and services but never kept, so the next build reads it again.
 * `onRead` runs just before the website is read.
 *
 * Throws a client-facing error when the website cannot be read, or the
 * analysis is not set up; credit errors pass through.
 */
async function businessForBuild(
  competitor: CompetitorRecord,
  job: SearchJob,
  businessUrl: string,
  onRead?: () => Promise<void>,
): Promise<{ profile: BusinessProfile; fresh: boolean } | null> {
  const saved = versionProfile(competitor, businessUrl);
  if (saved) return { profile: saved, fresh: false };
  const own = (job.businessProfile?.url || "").trim();
  if (own && sameWebsite(own, businessUrl)) {
    if (competitor.recreateOnly?.businessProfile) await saveVersionProfile(competitor.id, null);
    return null;
  }
  await onRead?.();
  let profile: BusinessProfile;
  try {
    profile = await businessProfileAnalyzer()(businessUrl);
  } catch (err) {
    if (isCreditError(err)) throw err;
    console.warn(`[manus] could not analyse ${businessUrl} for competitor ${competitor.id}`, err);
    throw new Error(analysisSetupMessage(err) ?? `Could not read the website ${hostOf(businessUrl)}. Check the address and try again.`);
  }
  // Kept under the website it was asked for, so the next build finds it.
  return { profile: { ...profile, url: businessUrl }, fresh: Boolean(profile.brandColors) };
}

/** Shown when the build's website was read without its brand colours. */
function brandNoticeFor(businessUrl: string): string {
  return `Could not read the brand colours of ${hostOf(businessUrl)} automatically; the design agent chose colours from the site. Check them, or describe yours in Apply changes.`;
}

/** Progress phase of a build reading the client's website before anything else. */
const READING_PHASE = "reading";
/** A page still "reading" after this long was cut off (a restart): a new build may start. */
const READING_STALE_MS = 15 * 60_000;

/** Whether the page's build is reading the client's website right now (started from the recreate page). */
export function isReadingWebsite(page: RecreatedLandingPage | null | undefined): boolean {
  if (!page || page.status !== "pending" || page.progress?.phase !== READING_PHASE) return false;
  const updated = Date.parse(page.updatedAt || "");
  return Number.isFinite(updated) && Date.now() - updated < READING_STALE_MS;
}

function briefInput(
  competitor: CompetitorRecord,
  job: SearchJob,
  businessUrl: string,
  styleDirection: StyleDirection,
  userFeedback: string | null,
  icp: ManusBriefInput["icp"] = null,
  /** The business read for this build's website (businessForBuild); null uses the version's saved one for it. */
  business: BusinessProfile | null = null,
): ManusBriefInput {
  // A version built for another website writes for that website's business:
  // its name, colours, logo and services all come from that profile.
  const profile = business || versionProfile(competitor, businessUrl) || job.businessProfile || null;
  return {
    competitorName: competitor.pageName,
    competitorUrl: competitor.pageAnalysis!.analyzedUrl,
    clientUrl: businessUrl,
    clientName: resolveBrandDisplayName({
      businessUrl,
      siteName: profile?.brandAssets?.siteName,
      profileName: profile?.businessName,
      competitorName: competitor.pageName,
    }),
    keyword: job.keywords?.[0] || job.keyword.split(",")[0]?.trim() || job.keyword,
    searchKeywords: job.keywords?.length ? job.keywords : job.keyword.split(",").map((k) => k.trim()),
    selectedCategory: job.selectedCategory?.label || null,
    profile,
    // A business read for this build without colours gets neutral ones, never an earlier page's.
    brandColors: profile?.brandColors || (business ? null : competitor.recreatedPage?.brandColors) || null,
    pageAnalysis: competitor.pageAnalysis || null,
    styleDirection,
    userFeedback,
    ...(icp ? { icp } : {}),
  };
}

// ── Runs in this process (stop + no double polling) ─────────────────────

/**
 * Runs this app process follows, by competitor id. Kept on globalThis: Next.js
 * can load this module more than once (instrumentation and route handlers),
 * and a stop must reach a run started from any of them.
 */
function runsInProcess(): Map<string, AbortController> {
  const g = globalThis as typeof globalThis & { __adrivalManusRuns?: Map<string, AbortController> };
  return (g.__adrivalManusRuns ??= new Map<string, AbortController>());
}

const runs = runsInProcess();

function beginRun(competitorId: string): AbortSignal {
  runs.get(competitorId)?.abort();
  const controller = new AbortController();
  runs.set(competitorId, controller);
  return controller.signal;
}

/** Ends a run; it runs in `finally`, so a failure recording credits is logged and never replaces the run's result. */
async function endRun(competitorId: string, signal: AbortSignal): Promise<void> {
  if (runs.get(competitorId)?.signal === signal) runs.delete(competitorId);
  try {
    await recordCredits(competitorId);
  } catch (err) {
    console.error(`[manus] could not record credits for competitor ${competitorId}`, err);
  }
}

/** The agent's credits for this page's task go to the ledger (charged to the run's owner after a restart). */
async function recordCredits(competitorId: string): Promise<void> {
  const competitor = await getCompetitor(competitorId);
  const taskId = competitor?.recreatedPage?.manus?.taskId;
  if (!competitor || !taskId) return;
  const job = await getJob(competitor.runId);
  recordManusTaskCreditsSoon({
    taskId,
    operation: "manus.recreate",
    fallbackUserId: job?.ownerUserId ?? null,
    projectKind: "search",
    projectId: competitor.runId,
    runId: competitor.runId,
  });
}

class StoppedError extends Error {
  constructor() {
    super("Recreation stopped");
    this.name = "AbortError";
  }
}

/** MANUS_POLL_MS shortens every wait proportionally (tests); the default poll is 10 s. */
function timeScale(): number {
  const poll = Number(process.env.MANUS_POLL_MS || "");
  return Number.isFinite(poll) && poll > 0 ? poll / POLL_MS : 1;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new StoppedError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new StoppedError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms * timeScale());
    signal.addEventListener("abort", onAbort, { once: true });
  });

/**
 * The time of the message we just sent, by Manus's clock, so events of
 * earlier turns (an old "stopped", the previous page) are ignored. Falls back
 * to our own clock when the message does not show up.
 */
async function anchorTurn(taskId: string, sentText: string, sentAfter: number, signal: AbortSignal): Promise<number> {
  const probe = sentText.replace(/\s+/g, " ").trim().slice(0, 50);
  for (let i = 0; i < 5; i += 1) {
    try {
      const events = await latestManusEvents(taskId, 20, false);
      const sent = events.find(
        (e) =>
          e.type === "user_message" &&
          String(e.user_message?.content || "").replace(/\s+/g, " ").includes(probe),
      );
      if (sent) return Number(sent.timestamp);
    } catch {
      /* try again */
    }
    await sleep(3_000, signal);
  }
  return sentAfter;
}

// ── Screenshots the user pastes with feedback ───────────────────────────

/** An image the user pasted to show which part of the page they mean. */
export type FeedbackScreenshot = { name: string; dataUrl: string };

export const MAX_SCREENSHOTS = 6;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

/**
 * Keeps only real PNG/JPEG/WebP data URLs within the size limit, at most
 * MAX_SCREENSHOTS. Anything else is dropped.
 */
export function cleanScreenshots(raw: unknown): FeedbackScreenshot[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedbackScreenshot[] = [];
  for (const item of raw) {
    const dataUrl = String((item as { dataUrl?: unknown })?.dataUrl || "");
    const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) continue;
    if (Math.floor((m[2].length * 3) / 4) > MAX_SCREENSHOT_BYTES) continue;
    const ext = m[1] === "jpeg" ? "jpg" : m[1];
    out.push({ name: `screenshot-${out.length + 1}.${ext}`, dataUrl });
    if (out.length >= MAX_SCREENSHOTS) break;
  }
  return out;
}

function screenshotParts(shots: FeedbackScreenshot[]): ManusContentPart[] {
  return shots.map((s) => ({
    type: "file" as const,
    filename: s.name,
    mime_type: s.dataUrl.slice(5, s.dataUrl.indexOf(";")),
    file_data: s.dataUrl,
  }));
}

function screenshotNote(shots: FeedbackScreenshot[]): string {
  return shots.length
    ? `\n\nThe user attached ${shots.length} screenshot${shots.length === 1 ? "" : "s"} (${shots.map((s) => s.name).join(", ")}) showing the parts they mean. Look at them carefully.`
    : "";
}

// ── Start, edit, stop, resume ───────────────────────────────────────────

/**
 * Finds the audience profile for a build. A regenerated ICP gets a new id, so a
 * saved id can go missing: fall back to the current ICP for the same source and
 * stage, and throw (before any spend) when there is none.
 */
export async function resolveTargetIcp(
  target: { icpId: string; stage: AwarenessStage } | null,
  runId: string,
): Promise<{ record: IcpRecord; target: { icpId: string; stage: AwarenessStage } } | null> {
  if (!target) return null;
  const byId = await getIcp(target.icpId);
  if (byId) return { record: byId, target };
  const source = runId.startsWith(LOOKUP_RECREATE_PREFIX)
    ? { kind: "lookup" as const, id: runId.slice(LOOKUP_RECREATE_PREFIX.length) }
    : { kind: "search" as const, id: runId };
  const current = (await getIcps(source.kind, source.id)).find((i) => i.stage === target.stage);
  if (!current) {
    throw new Error("This page's audience profile was removed. Open it again from A/B testing.");
  }
  return { record: current, target: { icpId: current.id, stage: current.stage } };
}

/** Builds the page with the design agent. Returns when the page is ready or the run failed. */
export async function runManusRecreation(
  competitorId: string,
  options: {
    userFeedback?: string | null;
    styleDirection?: StyleDirection | null;
    screenshots?: FeedbackScreenshot[];
    /** Images the page must use. New ones replace the saved set; none given reuses the saved set. */
    assets?: UserAsset[];
    /** A new reader to write for; omitted keeps the one already on the page. */
    targetIcp?: { icpId: string; stage: AwarenessStage } | null;
    /**
     * The client's website for this build (a queued job's own). Omitted, a
     * version keeps its own website (its page's, else its saved business
     * profile's); any other record uses the run's.
     */
    businessUrl?: string | null;
    /**
     * Asked after the client's website is analysed (which can take a while):
     * false means the build is no longer wanted (its job was stopped), so
     * nothing goes to the design agent.
     */
    stillWanted?: () => Promise<boolean>;
  } = {},
): Promise<CompetitorRecord> {
  if (!hasManusKey()) throw new Error("The design agent is not set up yet: add MANUS_API_KEY to the environment.");
  const competitor = await getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");
  if (competitor.pageAnalysis?.status !== "completed") {
    throw new Error("Analyze the competitor landing page first (Get offer & page details).");
  }
  const job = await getJob(competitor.runId);
  if (!job) throw new Error("Search job not found for this competitor");
  // A version keeps its own website (and business) on rebuilds and changes: the run's
  // website may since have been replaced by a later job's.
  const isVersion = Boolean(competitor.recreateOnly?.variantOf);
  const versionUrl = isVersion
    ? competitor.recreatedPage?.businessUrl || competitor.recreateOnly?.businessProfile?.url || null
    : null;
  const businessUrl = resolveBusinessUrl({
    businessUrl: options.businessUrl || versionUrl || job.businessUrl,
    businessProfile: job.businessProfile,
  });
  if (!businessUrl) {
    throw new Error("This search has no business website URL. Re-run search with a business URL so recreation can use your brand.");
  }
  const styleDirection: StyleDirection = options.styleDirection || competitor.recreatedPage?.styleDirection || "brand";
  const feedback = options.userFeedback?.trim() || null;

  // The reader this page is for: a new target from the request, else the one kept on the page.
  // Resolved before anything is stopped or spent: a page saved for an audience
  // profile must never fall back to a plain brief.
  const resolved = await resolveTargetIcp(
    options.targetIcp ?? competitor.recreatedPage?.targetIcp ?? null,
    competitor.runId,
  );
  const targetIcp = resolved?.target ?? null;
  const icp = resolved ? { stage: resolved.record.stage, content: resolved.record } : null;

  // A job's (or version's) website that is not the search's: its business is read
  // now, before anything is stopped or sent. A queued job writes nothing until it
  // is read (a failure builds nothing; the queue records it). A build asked for on
  // the recreate page (no stillWanted) shows "Reading …" on the page first, so the
  // page follows it and a second request is not started, and a failure lands on
  // the page. Other records build for the run's website as they always have.
  let readingId: string | null = null;
  const announce = options.stillWanted
    ? undefined
    : async () => {
        readingId = await markReading(competitor, job, businessUrl);
      };
  let found: Awaited<ReturnType<typeof businessForBuild>> = null;
  try {
    found = options.businessUrl || isVersion ? await businessForBuild(competitor, job, businessUrl, announce) : null;
  } catch (err) {
    // Recorded only while the page still shows this read (not after a Stop or a newer build).
    if (readingId && (await claimReading(competitorId, readingId))) await recordReadFailure(competitorId, err);
    throw err;
  }
  // Stopped (or taken over by a newer build) while the website was read: nothing is
  // saved, created or written over the page.
  if (readingId && !(await claimReading(competitorId, readingId))) {
    return (await getCompetitor(competitorId)) || competitor;
  }
  if (found && options.stillWanted && !(await options.stillWanted())) {
    return (await getCompetitor(competitorId)) || competitor;
  }
  const business = found?.profile ?? null;
  const brandNotice = business && !business.brandColors ? brandNoticeFor(businessUrl) : null;

  // The content as it was when this build was asked for (the light page above is from then too).
  // Read before a running build is stopped: a failed read leaves that build alone.
  const existingContent = await getRecreatedPage(competitorId);

  // A new build replaces a running one.
  const previous = competitor.recreatedPage;
  if (previous?.manus?.taskId && isManusRunActive(previous)) {
    runs.get(competitorId)?.abort();
    await stopManusTask(previous.manus.taskId).catch(() => undefined);
  }

  if (options.assets?.length) saveAssets(competitorId, options.assets);
  const assets = options.assets?.length ? options.assets : loadAssets(competitorId);

  const signal = beginRun(competitorId);
  const input = {
    ...briefInput(competitor, job, businessUrl, styleDirection, feedback, icp, business),
    userAssets: assets.map((a) => ({ name: a.name, caption: a.caption })),
  };
  const existing = competitor.recreatedPage;
  const now = new Date().toISOString();
  const base: RecreatedLandingPage = {
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: "pending",
    businessUrl,
    businessName: input.clientName,
    keyword: input.keyword,
    sourceCompetitorName: competitor.pageName,
    sourceAnalyzedUrl: input.competitorUrl,
    brandColors: input.brandColors || (brandNotice ? null : existing?.brandColors) || NEUTRAL_COLORS,
    // The last page stays visible until the new one is ready, and Undo brings it
    // back afterwards (so a built-in page can be compared with the agent's).
    html: existingContent?.html || null,
    previousHtml: existingContent?.html || existingContent?.previousHtml || null,
    generatedImages: existingContent?.generatedImages || [],
    pipelineVersion: MANUS_PIPELINE_VERSION,
    styleDirection,
    userFeedback: feedback,
    ...(targetIcp ? { targetIcp } : {}),
    publishReady: false,
    publishBlockers: [],
    brandNotice,
    qualityReport: null,
    error: null,
    manus: null,
    progress: progress("send", "Sending the brief to the design agent…", 2),
  };
  const { html: baseHtml, previousHtml: basePrevious, generatedImages: baseImages, ...baseLight } = base;

  try {
    // The new page replaces the old one whole (its source archive is not carried over).
    // A business read for it is kept on the version in the same write (one read
    // without colours is not, and a profile kept for another website goes), so
    // the version's profile and its page's website never disagree.
    await updateCompetitorWith(competitorId, (stored) => ({
      ...(found && stored.recreateOnly
        ? {
            recreateOnly: {
              ...stored.recreateOnly,
              businessProfile: found.fresh ? found.profile : versionProfile(stored, businessUrl),
            },
          }
        : {}),
      recreatedPage: baseLight as RecreatedPageLight,
      recreatedPageHeavy: { html: baseHtml ?? null, previousHtml: basePrevious, generatedImages: baseImages },
    }));
    const brief = buildManusBrief(input);
    const shots = options.screenshots || [];
    const taskMessage = `${buildManusTaskMessage(input)}${screenshotNote(shots)}`;
    const project = await manusProject();
    const connectors = await manusConnectors();
    const sentAt = Date.now();
    const created = await createManusTask({
      title: `Landing page: ${input.clientName} (from ${hostOf(input.competitorUrl)})`,
      projectId: project?.id || null,
      agentProfile: agentProfile(),
      interactive: true,
      structuredOutputSchema: MANUS_RESULT_SCHEMA as unknown as Record<string, unknown>,
      message: {
        connectors,
        content: [
          { type: "text", text: taskMessage },
          {
            type: "file",
            filename: "brief.md",
            mime_type: "text/markdown",
            file_data: `data:text/markdown;base64,${Buffer.from(brief, "utf8").toString("base64")}`,
          },
          ...assets.map((a) => ({
            type: "file" as const,
            filename: a.name,
            mime_type: a.dataUrl.slice(5, a.dataUrl.indexOf(";")),
            file_data: a.dataUrl,
          })),
          ...screenshotParts(shots),
        ],
      },
    });
    console.info(
      `[manus] task ${created.task_id} started for competitor ${competitorId}${project ? ` in project "${project.name}"` : ""}: ${created.task_url || ""}`,
    );
    await savePage(competitorId, {
      manus: {
        taskId: created.task_id,
        taskUrl: created.task_url || null,
        mode: "build",
        turnStartedAt: sentAt,
        startedAt: new Date(sentAt).toISOString(),
        answerContext: buildAnswerContext(input),
        service: (() => {
          const focus = pageServiceFocus(input);
          return { label: focus.service, families: focus.families, keywords: focus.searchKeywords };
        })(),
        questions: [],
        handledEventIds: [],
        nudges: 0,
      },
      progress: progress("study", "The design agent is studying the competitor page and your brand…", 6),
    });
    await saveState(competitorId, { turnStartedAt: await anchorTurn(created.task_id, taskMessage, sentAt, signal) });
    return await follow(competitorId, signal);
  } catch (err) {
    return await fail(competitorId, err, signal);
  } finally {
    await endRun(competitorId, signal);
  }
}

/**
 * A change request on a page the agent built: the same task carries on with
 * the request, so the agent keeps everything it learned. Falls back to a new
 * build with the request when the task can no longer be continued.
 */
export async function editManusRecreation(
  competitorId: string,
  request: string,
  screenshots: FeedbackScreenshot[] = [],
): Promise<CompetitorRecord> {
  const competitor = await getCompetitor(competitorId);
  const page = competitor?.recreatedPage;
  if (!competitor || !page) throw new Error("Competitor not found");
  if (!page.manus?.taskId || !(await getRecreatedPage(competitorId))?.html) {
    return runManusRecreation(competitorId, { userFeedback: request, styleDirection: page.styleDirection || null, screenshots });
  }
  const signal = beginRun(competitorId);
  const taskId = page.manus.taskId;
  await savePage(competitorId, {
    status: "design_pending",
    error: null,
    progress: progress("build", "The design agent is making your changes…", 10),
  });
  try {
    const editMessage = `${buildManusEditMessage(request)}${screenshotNote(screenshots)}`;
    const sentAt = Date.now();
    try {
      await sendManusMessage(
        taskId,
        { content: screenshots.length ? [{ type: "text", text: editMessage }, ...screenshotParts(screenshots)] : editMessage },
        MANUS_RESULT_SCHEMA as unknown as Record<string, unknown>,
      );
    } catch (err) {
      console.warn("[manus] could not continue the task; starting a new build", (err as Error).message);
      await endRun(competitorId, signal);
      return runManusRecreation(competitorId, {
        userFeedback: [page.userFeedback, request].filter(Boolean).join("\n"),
        styleDirection: page.styleDirection || null,
        screenshots,
      });
    }
    await saveState(competitorId, {
      mode: "edit",
      editRequest: request,
      nudges: 0,
      imageFixes: 0,
      report: null,
      turnStartedAt: await anchorTurn(taskId, editMessage, sentAt, signal),
    });
    return await follow(competitorId, signal);
  } catch (err) {
    return await fail(competitorId, err, signal);
  } finally {
    await endRun(competitorId, signal);
  }
}

/** Puts back the page from before the last change or rebuild (and makes that one the Undo). */
export async function undoManusChange(competitorId: string): Promise<CompetitorRecord> {
  await savePageWithContent(competitorId, (page, content) => {
    if (!content?.previousHtml) throw new Error("There is no earlier version to go back to.");
    return {
      html: content.previousHtml,
      previousHtml: content.html || null,
      lastEdit: page.lastEdit ? { ...page.lastEdit, summary: `Undone: ${page.lastEdit.summary}` } : null,
      progress: progress("deliver", "The last change was undone.", 100, { done: true }),
    };
  });
  const latest = await getCompetitor(competitorId);
  if (!latest) throw new Error("Competitor not found");
  return latest;
}

/** Stops the agent's task and marks the page stopped. */
export async function stopManusRecreation(competitorId: string, reason = "Recreation stopped"): Promise<CompetitorRecord> {
  runs.get(competitorId)?.abort();
  runs.delete(competitorId);
  const page = await latestPage(competitorId);
  if (page.manus?.taskId) await stopManusTask(page.manus.taskId).catch(() => undefined);
  await recordCredits(competitorId);
  const stage = (STAGES.find((s) => s.id === page.progress?.phase)?.id || "build") as StageId;
  await saveOutcome(competitorId, (_stored, hasHtml) => ({
    status: hasHtml ? "completed" : "failed",
    error: reason,
    progress: progress(stage, reason, page.progress?.pct || 0, { blocked: reason }),
  }));
  const latest = await getCompetitor(competitorId);
  if (!latest) throw new Error("Failed to stop recreation");
  return latest;
}

/**
 * Picks a run up again after a restart: the agent kept working on its own
 * server, so polling simply carries on. No-op when this process already
 * follows the run.
 */
export async function resumeManusRecreation(competitorId: string): Promise<void> {
  if (runs.has(competitorId)) return;
  const page = (await getCompetitor(competitorId))?.recreatedPage;
  if (!page?.manus?.taskId || !isManusPage(page)) return;
  if (page.status !== "pending" && page.status !== "design_pending") return;
  // A new build is reading the client's website: the task on the page is the earlier build's.
  if (isReadingWebsite(page)) return;
  // Another call may have picked the run up while the page was read.
  if (runs.has(competitorId)) return;
  const signal = beginRun(competitorId);
  console.info(`[manus] resuming task ${page.manus.taskId} for competitor ${competitorId}`);
  void (async () => {
    try {
      await follow(competitorId, signal);
    } catch (err) {
      await fail(competitorId, err, signal);
    } finally {
      await endRun(competitorId, signal);
    }
  })().catch((err: unknown) => console.error(`[manus] resumed run for competitor ${competitorId} ended with an error`, err));
}

// ── Following the task ──────────────────────────────────────────────────

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/** Polls the task until it delivers the page, fails, is stopped or times out. */
async function follow(competitorId: string, signal: AbortSignal): Promise<CompetitorRecord> {
  const startedAt = Date.parse((await latestPage(competitorId)).manus?.startedAt || "") || Date.now();
  const deadline = Date.now() + timeoutMs();
  let lastSaved = 0;
  let lastMessage = "";
  let lastTouch = Date.now();
  // The bar only moves forward: the furthest stage seen and the highest percentage shown.
  let stageAt = STAGES.findIndex((s) => s.id === "study");
  let shownPct = (await latestPage(competitorId)).progress?.pct || 6;
  let activity: Activity = (await latestPage(competitorId)).progress?.details?.activity || [];
  let lastActivityId = "";
  /** When this turn was first seen stopped; the page is collected from then on. */
  let stoppedAt: number | null = null;

  for (;;) {
    if (signal.aborted) throw new StoppedError();
    if (Date.now() > deadline) {
      const taskId = (await latestPage(competitorId)).manus?.taskId;
      if (taskId) await stopManusTask(taskId).catch(() => undefined);
      throw new Error(`The design agent did not finish within ${Math.round(timeoutMs() / 60_000)} minutes, so it was stopped.`);
    }
    // Keep the run's credit hold alive while the agent works.
    const reservationId = getBillingContext()?.reservationId;
    if (reservationId && Date.now() - lastTouch > RESERVATION_TOUCH_MS) {
      await touchReservation(reservationId);
      lastTouch = Date.now();
    }

    const state = (await latestPage(competitorId)).manus;
    if (!state) throw new Error("This page has no design agent task");
    let events: ManusEvent[];
    try {
      // Older runs saved the turn start as text; compare as numbers.
      const turnStart = Number(state.turnStartedAt) || 0;
      events = (await latestManusEvents(state.taskId, 60, true)).filter((e) => e.timestamp >= turnStart);
    } catch (err) {
      console.warn("[manus] poll failed; retrying", (err as Error).message);
      await sleep(POLL_MS, signal);
      continue;
    }
    const status = events.find((e) => e.type === "status_update")?.status_update;
    const agentStatus = status?.agent_status || "running";

    // Live feed: the agent's notes and actions, merged into what was already shown.
    const known = new Set(activity.map((a) => a.id));
    const fresh = activityFromEvents(events).filter((a) => !known.has(a.id));
    if (fresh.length) activity = [...activity, ...fresh].sort((a, b) => a.at - b.at).slice(-ACTIVITY_LIMIT);

    // Progress: the stage the agent's latest work points to (never backwards),
    // how much it has done in that stage, its plan when it reports one, and time.
    const plan = events.find((e) => e.type === "plan_update")?.plan_update?.steps || [];
    const doing = plan.find((s) => s.status === "doing") || plan.find((s) => s.status === "todo");
    const hints = [...fresh.map((a) => stageForActivity(a.text)), doing?.title ? stageForStep(doing.title) : null];
    for (const hinted of hints) {
      if (hinted && hinted !== "deliver") stageAt = Math.max(stageAt, STAGES.findIndex((s) => s.id === hinted));
    }
    const stage = STAGES[stageAt].id;
    const [from, to] = STAGE_RANGE[stage];
    const stageStart = activity.findIndex((a) => stageForActivity(a.text) === stage);
    const doneInStage = stageStart >= 0 ? activity.length - stageStart : 0;
    const byWork = from + (to - from) * (1 - Math.exp(-doneInStage / 10));
    const doneSteps = plan.filter((s) => s.status === "done").length;
    const byPlan = plan.length ? 6 + (86 * doneSteps) / plan.length : 0;
    const elapsedMin = (Date.now() - startedAt) / 60_000;
    const byTime = 6 + 80 * (1 - Math.exp(-elapsedMin / 30));
    shownPct = Math.min(95, Math.max(shownPct, byWork, byPlan, byTime));

    const editing = state.mode === "edit";
    const latest = activity[activity.length - 1];
    const latestNote = [...activity].reverse().find((a) => a.kind === "note");
    const message = sanitizeClientFacingText(
      (latestNote && latest && latestNote.at >= latest.at - 120_000 ? plainText(latestNote.text, 180) : null) ||
        latest?.text ||
        doing?.title ||
        status?.brief ||
        (editing ? "The design agent is making your changes…" : "The design agent is working on the page…"),
    );
    const changed = message !== lastMessage || (latest?.id || "") !== lastActivityId;
    if (agentStatus === "running" && (changed || Date.now() - lastSaved > HEARTBEAT_MS)) {
      await savePage(competitorId, {
        progress: progress(stage, editing ? `Making your changes: ${message}` : message, shownPct, { activity }),
      });
      lastSaved = Date.now();
      lastMessage = message;
      lastActivityId = latest?.id || "";
    }

    if (agentStatus === "error") {
      const detail = events.find((e) => e.type === "error_message")?.error_message?.content;
      throw new Error(`The design agent hit an error${detail ? `: ${detail}` : "."}`);
    }

    if (agentStatus === "waiting") {
      await handleWaiting(competitorId, state, status?.status_detail || null, events);
      await sleep(4_000, signal);
      continue;
    }

    if (agentStatus !== "stopped") stoppedAt = null;

    if (agentStatus === "stopped") {
      // The page is collected as soon as the agent stops. Background jobs
      // (its report, follow-up suggestions) do not hold the page back.
      if (stoppedAt == null) {
        stoppedAt = Date.now();
        await savePage(competitorId, {
          progress: progress("deliver", "Collecting the finished page…", Math.max(shownPct, 95), { activity }),
        });
      }
      const task = await getManusTask(state.taskId).catch(() => null);
      const stoppedFor = Date.now() - stoppedAt;
      const done = await collectResult(competitorId, state, task?.credit_usage ?? null, {
        waitForReport: task?.has_running_background_jobs !== false && stoppedFor < REPORT_WAIT_MS * timeScale(),
      });
      if (done && "waitForReport" in done) {
        await sleep(POLL_MS / 2, signal);
        continue;
      }
      if (done && "fixMessage" in done) {
        // The page repeats an image: one round back to the agent before it is shown.
        await savePage(competitorId, {
          progress: progress("check", "Replacing images used more than once…", Math.max(shownPct, 93), { activity }),
        });
        const sentAt = Date.now();
        await sendManusMessage(
          state.taskId,
          { content: done.fixMessage },
          MANUS_RESULT_SCHEMA as unknown as Record<string, unknown>,
        );
        await saveState(competitorId, {
          imageFixes: (state.imageFixes || 0) + 1,
          nudges: 0,
          report: (done.report as unknown as Record<string, unknown> | null) ?? null,
          turnStartedAt: await anchorTurn(state.taskId, done.fixMessage, sentAt, signal),
        });
        continue;
      }
      if (done) return done;
      // No page yet: background work may still attach it for a short while.
      if (task?.has_running_background_jobs !== false && stoppedFor < FILE_WAIT_MS * timeScale()) {
        await sleep(POLL_MS, signal);
        continue;
      }
      stoppedAt = null;
      // Finished without the file: ask once or twice for it.
      if (state.nudges >= MAX_NUDGES) {
        throw new Error("The design agent finished without attaching the HTML page.");
      }
      const sentAt = Date.now();
      await sendManusMessage(
        state.taskId,
        { content: NUDGE_MESSAGE },
        MANUS_RESULT_SCHEMA as unknown as Record<string, unknown>,
      );
      await saveState(competitorId, { nudges: state.nudges + 1, turnStartedAt: await anchorTurn(state.taskId, NUDGE_MESSAGE, sentAt, signal) });
      continue;
    }

    await sleep(POLL_MS, signal);
  }
}

/** Answers a question or settles a confirmation the agent is waiting on. */
async function handleWaiting(
  competitorId: string,
  state: ManusRecreationState,
  detail: ManusStatusDetail | null,
  events: ManusEvent[],
): Promise<void> {
  const type = detail?.waiting_for_event_type || "messageAskUser";
  const eventId = detail?.waiting_for_event_id || events.find((e) => e.type === "status_update")?.id || "";
  if (!eventId || state.handledEventIds.includes(eventId)) return;
  const handled = (extra: Partial<ManusRecreationState> = {}) =>
    saveState(competitorId, { handledEventIds: [...state.handledEventIds, eventId].slice(-100), ...extra });

  if (type === "messageAskUser" || type === "cascadeAskUser") {
    const asked =
      events.find((e) => e.id === eventId && e.type === "assistant_message") ||
      events.find((e) => e.type === "assistant_message");
    const question = asked?.assistant_message?.content?.trim() || detail?.waiting_description || "The agent is waiting for your input.";
    const expectation = asked?.assistant_message?.question_expectation || null;
    await savePage(competitorId, (page) => ({
      progress: page.progress
        ? { ...page.progress, message: "Answering a question from the design agent…" }
        : progress("study", "Answering a question from the design agent…", 10),
    }));
    const modelAnswers = state.questions.filter((q) => q.byModel).length;
    const { answer, byModel } =
      modelAnswers < MAX_MODEL_ANSWERS
        ? await answerAgentQuestion({
            question,
            options: expectation?.options || [],
            multiple: expectation?.selection_mode === "multiple",
            context: state.answerContext,
            history: state.questions.slice(-6).map((q) => ({ question: q.question, answer: q.answer })),
          })
        : {
            answer: "You have everything you need. Please decide yourself by following brief.md and finish the page without further questions.",
            byModel: false,
          };
    await sendManusMessage(state.taskId, { content: answer });
    console.info(`[manus] answered a question on task ${state.taskId}${byModel ? "" : " (default answer)"}`);
    await handled({
      questions: [
        ...state.questions,
        { eventId, question: question.slice(0, 2000), answer, byModel, at: new Date().toISOString() },
      ].slice(-30),
    });
    return;
  }

  const decision = confirmationFor(type, detail);
  if (decision.input) {
    const confirmed = await confirmManusAction(state.taskId, eventId, decision.input).catch((err) => {
      console.warn(`[manus] confirm ${type} failed`, (err as Error).message);
      return false;
    });
    if (confirmed) {
      await handled();
      return;
    }
  }
  // Declined or not consumable here: tell the agent to carry on without it.
  await sendManusMessage(state.taskId, {
    content: `Skip that step (${detail?.waiting_description || type}). ${decision.reason} Carry on with the brief and deliver ${MANUS_HTML_FILENAME}.`,
  });
  await handled();
}


// ── Result ──────────────────────────────────────────────────────────────

function isHtmlAttachment(a: ManusAttachment): boolean {
  return /\.html?$/i.test(a.filename || a.path || "") || /text\/html/i.test(a.content_type || "");
}

async function download(url: string, maxBytes = 25_000_000): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= maxBytes ? buf : null;
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Files the page refers to by a relative path are put into the page itself. */
async function inlineSiblingFiles(html: string, attachments: ManusAttachment[], htmlName: string): Promise<string> {
  let out = html;
  for (const a of attachments) {
    const name = a.filename || (a.path ? a.path.split("/").pop() : "") || "";
    if (!a.url || !name || name === htmlName || isHtmlAttachment(a)) continue;
    const refs = [a.path, a.path?.replace(/^\/home\/ubuntu\/[^/]+\//, ""), name, `./${name}`].filter(Boolean) as string[];
    const used = refs.filter((r) => out.includes(`"${r}"`) || out.includes(`'${r}'`) || out.includes(`(${r})`));
    if (!used.length) continue;
    const bytes = await download(a.url, 8_000_000);
    if (!bytes) continue;
    const type = a.content_type || (/\.css$/i.test(name) ? "text/css" : /\.js$/i.test(name) ? "text/javascript" : "application/octet-stream");
    for (const ref of used) {
      const r = escapeRegExp(ref);
      if (/css/.test(type)) {
        out = out.replace(new RegExp(`<link[^>]+href=["']${r}["'][^>]*>`, "gi"), `<style>\n${bytes.toString("utf8")}\n</style>`);
      } else if (/javascript/.test(type)) {
        out = out.replace(new RegExp(`<script([^>]*)\\ssrc=["']${r}["']([^>]*)>\\s*</script>`, "gi"), `<script$1$2>\n${bytes.toString("utf8")}\n</script>`);
      } else {
        const dataUri = `data:${type};base64,${bytes.toString("base64")}`;
        out = out.replace(new RegExp(`(["'(])${r}(["')])`, "g"), `$1${dataUri}$2`);
      }
    }
  }
  return out;
}

/** The hero's text: the h1 and what follows it, tags removed. */
function heroText(html: string): string {
  const body = html.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ");
  const at = body.search(/<h1[\s>]/i);
  const from = at >= 0 ? body.slice(at) : body.slice(body.search(/<body[\s>]/i) + 1);
  return from
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

/**
 * Whether the hero names the page's service, as the user searched for it.
 * Null when the run has no service to check against.
 */
export function heroMissesService(
  html: string,
  service: ManusRecreationState["service"],
): string | null {
  if (!service?.keywords.length && !service?.families.length) return null;
  const searched = searchedServiceFocus(service.keywords);
  const focus = { families: service.families.length ? service.families : searched.families, tokens: searched.tokens };
  return offerFitsSearchedService(heroText(html), focus, { requireMatch: true }) ? null : service.label;
}

/** One line of agent-reported text, without control characters or extra spaces. */
function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Names of the competitor that must not appear in the client's page. */
function competitorLeaks(html: string, page: RecreatedLandingPage): string[] {
  const text = html.toLowerCase();
  const found: string[] = [];
  const name = (page.sourceCompetitorName || "").trim();
  if (name.length >= 4 && text.includes(name.toLowerCase())) found.push(name);
  const domain = hostOf(page.sourceAnalyzedUrl || "").toLowerCase();
  const clientDomain = hostOf(page.businessUrl || "").toLowerCase();
  if (domain && domain !== clientDomain && text.includes(domain)) found.push(domain);
  return found;
}

/**
 * Downloads the page the agent attached in this turn and saves it. Null when
 * the turn has no HTML file.
 */
async function collectResult(
  competitorId: string,
  state: ManusRecreationState,
  creditUsage: number | null,
  opts: { waitForReport?: boolean } = {},
): Promise<CompetitorRecord | { fixMessage: string; report: ManusResult | null } | { waitForReport: true } | null> {
  const events = await manusEventsSince(state.taskId, Number(state.turnStartedAt) || 0);
  const attachments = events.flatMap((e) => e.assistant_message?.attachments || []);
  const structured = [...events].reverse().find((e) => e.type === "structured_output_result")?.structured_output_result;
  // The page is there but its report is still being prepared: give it a moment, not more.
  if (!structured && opts.waitForReport && attachments.some((a) => a.url && isHtmlAttachment(a))) {
    return { waitForReport: true };
  }
  // A fix round may end without a new report: the one from earlier in this turn still applies.
  const result = structured?.success
    ? (structured.value as unknown as ManusResult)
    : ((state.report as unknown as ManusResult | null) ?? null);

  const htmlFiles = attachments.filter((a) => a.url && isHtmlAttachment(a));
  const wanted = (result?.html_filename || "").split("/").pop()?.toLowerCase() || "";
  const pick =
    [...htmlFiles].reverse().find((a) => wanted && (a.filename || "").toLowerCase() === wanted) ||
    [...htmlFiles].reverse().find((a) => (a.filename || "").toLowerCase() === MANUS_HTML_FILENAME) ||
    htmlFiles[htmlFiles.length - 1];
  if (!pick?.url) return null;
  const bytes = await download(pick.url);
  let html = bytes?.toString("utf8") || "";
  if (!/<body[\s>]/i.test(html) && !/<html[\s>]/i.test(html)) return null;
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html>\n<html lang="en">\n${html}\n</html>`;

  html = await inlineSiblingFiles(html, attachments, pick.filename || MANUS_HTML_FILENAME);
  // The stored page carries its own images.
  try {
    html = (await embedRemoteImagesInHtml(html, { maxImages: 16 })).html;
  } catch {
    /* remote images stay linked */
  }

  const page = await latestPage(competitorId);
  const repeats = repeatedImages(html);
  if (repeats.length && (state.imageFixes || 0) < MAX_IMAGE_FIXES) {
    console.info(`[manus] task ${state.taskId}: ${repeats.length} image(s) used more than once; asking for a fix`);
    return { fixMessage: repeatFixMessage(describeRepeats(repeats)), report: result };
  }
  const leaks = competitorLeaks(html, page);
  const unresolved = (result?.unresolved || []).map((s) => s.trim()).filter(Boolean);
  const notMatched = (result?.sections || []).filter((s) => !s.layout_matches).map((s) => s.competitor_section);
  const offService = heroMissesService(html, state.service || null);
  const publishBlockers = [
    // The client's colours could not be read: the page uses neutral ones.
    ...(page.brandNotice ? [page.brandNotice] : []),
    ...(offService
      ? [`The hero does not name ${offService}, the service searched for. Ask for a change so the headline and call to action match the competitor's ${offService} offer.`]
      : []),
    ...(repeats.length
      ? [`The same image is used in more than one place (${describeRepeats(repeats).slice(0, 3).join(" | ")}). Ask for a change to replace the repeats.`]
      : []),
    ...(leaks.length ? [`The page still mentions the competitor (${leaks.join(", ")}). Ask for a change to remove it.`] : []),
    ...(notMatched.length ? [`Sections the agent could not match exactly: ${notMatched.slice(0, 5).join(", ")}.`] : []),
    ...(result && !(result.verification.desktop_compared && result.verification.mobile_compared)
      ? ["The agent did not confirm the desktop and mobile comparison."]
      : []),
    ...(result && !(result.brand?.colour_map || []).some((c) => /button|cta/i.test(c.role))
      ? ["The agent did not report the client's button colours. Check the buttons and coloured bands against the client's website."]
      : []),
    ...unresolved.slice(0, 6),
  ];
  // Which client-site element each colour was measured from, so it can be checked at a glance.
  const colourNote = (result?.brand?.colour_map || []).length
    ? `Colours: ${(result?.brand?.colour_map || [])
        .slice(0, 8)
        .map((c) => `${clean(c.role)} ${clean(c.hex)}${c.measured_from ? ` (from ${clean(c.measured_from).slice(0, 60)})` : ""}`)
        .join("; ")}.`
    : "";
  const imageCount = (source: string) => (result?.images || []).filter((i) => i.source === source).length;
  const imageNote = result?.images?.length
    ? `Images: ${[
        imageCount("user_supplied") ? `${imageCount("user_supplied")} you supplied` : "",
        imageCount("client_website") ? `${imageCount("client_website")} from the client's website` : "",
        imageCount("generated") ? `${imageCount("generated")} generated` : "",
      ]
        .filter(Boolean)
        .join(", ")}.`
    : "";
  const summary = [result?.summary, result?.verification?.notes, colourNote, imageNote].filter(Boolean).join(" ");
  const editing = state.mode === "edit";

  await savePageWithContent(competitorId, (stored, content) => ({
    status: "completed",
    html,
    // An edit keeps the page it changed for Undo; a build already set previousHtml when it started.
    previousHtml: editing ? content?.html || content?.previousHtml || null : content?.previousHtml || null,
    lastEdit: editing
      ? {
          at: new Date().toISOString(),
          request: state.editRequest || "",
          changed: [],
          reverted: [],
          repaired: [],
          summary: sanitizeClientFacingText(result?.summary || "The design agent applied your changes."),
        }
      : stored.lastEdit || null,
    differentiationNotes: sanitizeClientFacingText(`Design agent build ${MANUS_PIPELINE_VERSION}. ${summary}`.trim()),
    publishReady: publishBlockers.length === 0,
    publishBlockers,
    error: null,
    manus: { ...state, creditUsage: creditUsage ?? state.creditUsage ?? null },
    progress: progress("deliver", editing ? "Your changes are ready" : "Ready", 100, { done: true }),
  }));
  console.info(`[manus] task ${state.taskId} delivered ${pick.filename || "the page"} (${Math.round(html.length / 1024)} KB)`);
  return (await getCompetitor(competitorId)) || null;
}

/** Saves why a run ended without a page; a stop or a kept earlier page is not an error. */
async function fail(competitorId: string, err: unknown, signal: AbortSignal): Promise<CompetitorRecord> {
  // A stop saves its own state, and a run replaced by a newer one must not touch the page.
  const stopped = signal.aborted || (err as { name?: string })?.name === "AbortError";
  const page = (await getCompetitor(competitorId))?.recreatedPage;
  if (page && !stopped) {
    const message = sanitizeClientFacingText((err as Error)?.message || "Recreation failed");
    await saveOutcome(competitorId, (stored, hasHtml) => {
      const stage = (STAGES.find((s) => s.id === stored.progress?.phase)?.id || "build") as StageId;
      return {
        status: hasHtml ? "completed" : "failed",
        error: message,
        progress: progress(stage, message, stored.progress?.pct || 0, { blocked: message }),
      };
    });
  }
  if (!stopped) console.error("[manus] run failed", err);
  const latest = await getCompetitor(competitorId);
  if (!latest) throw err;
  return latest;
}
