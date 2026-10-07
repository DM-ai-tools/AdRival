import type {
  CompetitorRecord,
  ManusRecreationState,
  RecreatedLandingPage,
  RecreationProgressDetails,
  RecreationProgressStage,
  SearchJob,
} from "../../types";
import { getCompetitor, getJob, updateCompetitor } from "../../db";
import { getBillingContext } from "../../accounting/context";
import { touchReservation } from "../../accounting/service";
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
  listManusProjects,
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
/** Times a delivered page that repeats an image goes back to the agent before it is shown with a note. */
const MAX_IMAGE_FIXES = 1;

function repeatFixMessage(lines: string[]): string {
  return `Some images appear more than once on the page you delivered:
${lines.map((l) => `- ${l}`).join("\n")}

Replace every repeat so each photo appears only once. For each repeated spot use another suitable image: the user's images or the client's website first; create a new one with the OpenAI connector (gpt-image-2) only if none fits, or build that spot without a photo the way the competitor would look. Keep everything else exactly as it is, re-check the page, and attach the complete updated ${MANUS_HTML_FILENAME}. Do not deploy or publish anything.`;
}

const NUDGE_MESSAGE = `Please attach the complete final page as a single self-contained ${MANUS_HTML_FILENAME} file (inline CSS and JS, images as data URIs or absolute https URLs) to your reply. Do not deploy or publish it.`;

function timeoutMs(): number {
  const minutes = Number(process.env.MANUS_TIMEOUT_MINUTES || 90);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 90) * 60_000;
}

function agentProfile(): string {
  return process.env.MANUS_AGENT_PROFILE?.trim() || "standard";
}

/** Letters and digits only, lower case: "Redesign  Pipeline" → "redesignpipeline". */
function projectKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Edit distance, for project names typed with a small slip ("redeisgn" / "redesign"). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** Picks the project for a name: exact match, then one containing it, then one a typo away. */
export function matchManusProject<T extends { id: string; name: string }>(projects: T[], name: string): T | null {
  const want = projectKey(name);
  if (!want) return null;
  const exact = projects.filter((p) => projectKey(p.name) === want);
  if (exact.length) return exact[0];
  const containing = projects.filter((p) => projectKey(p.name).includes(want) || want.includes(projectKey(p.name)));
  if (containing.length === 1) return containing[0];
  const close = projects
    .map((p) => ({ p, d: editDistance(projectKey(p.name), want) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(want.length / 6)))
    .sort((a, b) => a.d - b.d);
  return close.length && (close.length === 1 || close[0].d < close[1].d) ? close[0].p : null;
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

let projectCache: { key: string; id: string; name: string } | null = null;

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
  if (projectCache?.key === name) return { id: projectCache.id, name: projectCache.name };
  const projects = await listManusProjects();
  const hit = matchManusProject(projects, name);
  if (!hit) {
    const names = projects.map((p) => `"${p.name}"`).join(", ") || "none";
    throw new Error(`The design agent project "${name}" was not found. Projects in the account: ${names}. Set MANUS_PROJECT_NAME to one of them.`);
  }
  projectCache = { key: name, id: hit.id, name: hit.name };
  return { id: hit.id, name: hit.name };
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

function latestPage(competitorId: string): RecreatedLandingPage {
  const page = getCompetitor(competitorId)?.recreatedPage;
  if (!page) throw new Error("Competitor not found");
  return page;
}

function savePage(competitorId: string, patch: Partial<RecreatedLandingPage>): RecreatedLandingPage {
  const page = latestPage(competitorId);
  const next: RecreatedLandingPage = { ...page, ...patch, updatedAt: new Date().toISOString() };
  updateCompetitor(competitorId, { recreatedPage: next });
  return next;
}

function saveState(competitorId: string, patch: Partial<ManusRecreationState>): ManusRecreationState {
  const page = latestPage(competitorId);
  if (!page.manus) throw new Error("This page has no design agent task");
  const manus = { ...page.manus, ...patch };
  savePage(competitorId, { manus });
  return manus;
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

/** Markdown links, images and extra spaces removed, cut to a readable length. */
function plainText(text: string, max: number): string {
  const clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

type ToolUsed = {
  tool?: string;
  brief?: string;
  description?: string;
  message?: { action?: string; param?: string };
  params?: { url?: string };
};

/**
 * The agent's own narration and the actions it runs, as Manus shows them
 * ("Browsing rival.com", "Executing command"), oldest first. Commands and
 * file contents are not included.
 */
export function activityFromEvents(events: ManusEvent[]): Activity {
  const out: Activity = [];
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type === "assistant_message") {
      const msg = e.assistant_message;
      if (!msg?.content || msg.question_expectation) continue;
      const text = plainText(msg.content, 420);
      if (text) out.push({ id: e.id, at: e.timestamp, kind: "note", text: sanitizeClientFacingText(text) });
    } else if (e.type === "tool_used") {
      const tool = (e as ManusEvent & { tool_used?: ToolUsed }).tool_used;
      let text = tool?.brief || tool?.message?.action || tool?.description || "";
      const param = tool?.message?.param || "";
      const url = tool?.params?.url || (/^https?:\/\//.test(param) ? param : "");
      if (url && /brows|visit|navigat|open|scrap|crawl|fetch/i.test(`${text} ${tool?.tool || ""}`)) {
        try {
          text = `${text || "Browsing"} ${new URL(url).hostname.replace(/^www\./, "")}`;
        } catch {
          /* keep the brief */
        }
      }
      text = plainText(text, 140);
      if (text) out.push({ id: e.id, at: e.timestamp, kind: "action", text: sanitizeClientFacingText(text) });
    }
  }
  return out;
}

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

function resolveBusinessUrl(job: SearchJob): string | null {
  const url = (job.businessUrl || "").trim() || (job.businessProfile?.url || "").trim();
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function briefInput(
  competitor: CompetitorRecord,
  job: SearchJob,
  businessUrl: string,
  styleDirection: StyleDirection,
  userFeedback: string | null,
): ManusBriefInput {
  const profile = job.businessProfile || null;
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
    brandColors: profile?.brandColors || competitor.recreatedPage?.brandColors || null,
    pageAnalysis: competitor.pageAnalysis || null,
    styleDirection,
    userFeedback,
  };
}

// ── Runs in this process (stop + no double polling) ─────────────────────

const runs = new Map<string, AbortController>();

function beginRun(competitorId: string): AbortSignal {
  runs.get(competitorId)?.abort();
  const controller = new AbortController();
  runs.set(competitorId, controller);
  return controller.signal;
}

function endRun(competitorId: string, signal: AbortSignal) {
  if (runs.get(competitorId)?.signal === signal) runs.delete(competitorId);
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
      if (sent) return sent.timestamp;
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

/** Builds the page with the design agent. Returns when the page is ready or the run failed. */
export async function runManusRecreation(
  competitorId: string,
  options: {
    userFeedback?: string | null;
    styleDirection?: StyleDirection | null;
    screenshots?: FeedbackScreenshot[];
    /** Images the page must use. New ones replace the saved set; none given reuses the saved set. */
    assets?: UserAsset[];
  } = {},
): Promise<CompetitorRecord> {
  if (!hasManusKey()) throw new Error("The design agent is not set up yet: add MANUS_API_KEY to the environment.");
  const competitor = getCompetitor(competitorId);
  if (!competitor) throw new Error("Competitor not found");
  if (competitor.pageAnalysis?.status !== "completed") {
    throw new Error("Analyze the competitor landing page first (Get offer & page details).");
  }
  const job = getJob(competitor.runId);
  if (!job) throw new Error("Search job not found for this competitor");
  const businessUrl = resolveBusinessUrl(job);
  if (!businessUrl) {
    throw new Error("This search has no business website URL. Re-run search with a business URL so recreation can use your brand.");
  }
  const styleDirection: StyleDirection = options.styleDirection || competitor.recreatedPage?.styleDirection || "brand";
  const feedback = options.userFeedback?.trim() || null;

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
    ...briefInput(competitor, job, businessUrl, styleDirection, feedback),
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
    brandColors: input.brandColors || existing?.brandColors || {
      primary: "#0F7A6C",
      secondary: "#134E4A",
      accent: "#F59E0B",
      background: "#FFFFFF",
      text: "#0F172A",
    },
    // The last page stays visible until the new one is ready, and Undo brings it
    // back afterwards (so a built-in page can be compared with the agent's).
    html: existing?.html || null,
    previousHtml: existing?.html || existing?.previousHtml || null,
    generatedImages: existing?.generatedImages || [],
    pipelineVersion: MANUS_PIPELINE_VERSION,
    styleDirection,
    userFeedback: feedback,
    publishReady: false,
    publishBlockers: [],
    qualityReport: null,
    error: null,
    manus: null,
    progress: progress("send", "Sending the brief to the design agent…", 2),
  };
  updateCompetitor(competitorId, { recreatedPage: base });

  try {
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
    savePage(competitorId, {
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
    saveState(competitorId, { turnStartedAt: await anchorTurn(created.task_id, taskMessage, sentAt, signal) });
    return await follow(competitorId, signal);
  } catch (err) {
    return fail(competitorId, err, signal);
  } finally {
    endRun(competitorId, signal);
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
  const competitor = getCompetitor(competitorId);
  const page = competitor?.recreatedPage;
  if (!competitor || !page) throw new Error("Competitor not found");
  if (!page.manus?.taskId || !page.html) {
    return runManusRecreation(competitorId, { userFeedback: request, styleDirection: page.styleDirection || null, screenshots });
  }
  const signal = beginRun(competitorId);
  const taskId = page.manus.taskId;
  savePage(competitorId, {
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
      endRun(competitorId, signal);
      return runManusRecreation(competitorId, {
        userFeedback: [page.userFeedback, request].filter(Boolean).join("\n"),
        styleDirection: page.styleDirection || null,
        screenshots,
      });
    }
    saveState(competitorId, {
      mode: "edit",
      editRequest: request,
      nudges: 0,
      imageFixes: 0,
      report: null,
      turnStartedAt: await anchorTurn(taskId, editMessage, sentAt, signal),
    });
    return await follow(competitorId, signal);
  } catch (err) {
    return fail(competitorId, err, signal);
  } finally {
    endRun(competitorId, signal);
  }
}

/** Puts back the page from before the last change or rebuild (and makes that one the Undo). */
export function undoManusChange(competitorId: string): CompetitorRecord {
  const page = latestPage(competitorId);
  if (!page.previousHtml) throw new Error("There is no earlier version to go back to.");
  savePage(competitorId, {
    html: page.previousHtml,
    previousHtml: page.html || null,
    lastEdit: page.lastEdit ? { ...page.lastEdit, summary: `Undone: ${page.lastEdit.summary}` } : null,
    progress: progress("deliver", "The last change was undone.", 100, { done: true }),
  });
  const latest = getCompetitor(competitorId);
  if (!latest) throw new Error("Competitor not found");
  return latest;
}

/** Stops the agent's task and marks the page stopped. */
export async function stopManusRecreation(competitorId: string, reason = "Recreation stopped"): Promise<CompetitorRecord> {
  runs.get(competitorId)?.abort();
  runs.delete(competitorId);
  const page = latestPage(competitorId);
  if (page.manus?.taskId) await stopManusTask(page.manus.taskId).catch(() => undefined);
  const stage = (STAGES.find((s) => s.id === page.progress?.phase)?.id || "build") as StageId;
  savePage(competitorId, {
    status: page.html ? "completed" : "failed",
    error: reason,
    progress: progress(stage, reason, page.progress?.pct || 0, { blocked: reason }),
  });
  const latest = getCompetitor(competitorId);
  if (!latest) throw new Error("Failed to stop recreation");
  return latest;
}

/**
 * Picks a run up again after a restart: the agent kept working on its own
 * server, so polling simply carries on. No-op when this process already
 * follows the run.
 */
export function resumeManusRecreation(competitorId: string): void {
  if (runs.has(competitorId)) return;
  const page = getCompetitor(competitorId)?.recreatedPage;
  if (!page?.manus?.taskId || !isManusPage(page)) return;
  if (page.status !== "pending" && page.status !== "design_pending") return;
  const signal = beginRun(competitorId);
  console.info(`[manus] resuming task ${page.manus.taskId} for competitor ${competitorId}`);
  void follow(competitorId, signal)
    .catch((err) => fail(competitorId, err, signal))
    .finally(() => endRun(competitorId, signal));
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
  const startedAt = Date.parse(latestPage(competitorId).manus?.startedAt || "") || Date.now();
  const deadline = Date.now() + timeoutMs();
  let lastSaved = 0;
  let lastMessage = "";
  let lastTouch = Date.now();
  // The bar only moves forward: the furthest stage seen and the highest percentage shown.
  let stageAt = STAGES.findIndex((s) => s.id === "study");
  let shownPct = latestPage(competitorId).progress?.pct || 6;
  let activity: Activity = latestPage(competitorId).progress?.details?.activity || [];
  let lastActivityId = "";

  for (;;) {
    if (signal.aborted) throw new StoppedError();
    if (Date.now() > deadline) {
      const taskId = latestPage(competitorId).manus?.taskId;
      if (taskId) await stopManusTask(taskId).catch(() => undefined);
      throw new Error(`The design agent did not finish within ${Math.round(timeoutMs() / 60_000)} minutes, so it was stopped.`);
    }
    // Keep the run's credit hold alive while the agent works.
    const reservationId = getBillingContext()?.reservationId;
    if (reservationId && Date.now() - lastTouch > RESERVATION_TOUCH_MS) {
      touchReservation(reservationId);
      lastTouch = Date.now();
    }

    const state = latestPage(competitorId).manus;
    if (!state) throw new Error("This page has no design agent task");
    let events: ManusEvent[];
    try {
      events = (await latestManusEvents(state.taskId, 60, true)).filter((e) => e.timestamp >= state.turnStartedAt);
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
      savePage(competitorId, {
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

    if (agentStatus === "stopped") {
      const task = await getManusTask(state.taskId).catch(() => null);
      if (task?.has_running_background_jobs === true) {
        await sleep(POLL_MS, signal);
        continue;
      }
      savePage(competitorId, {
        progress: progress("deliver", "Collecting the finished page…", Math.max(shownPct, 95), { activity }),
      });
      // The structured report follows the stop by a moment.
      await sleep(5_000, signal);
      const done = await collectResult(competitorId, state, task?.credit_usage ?? null);
      if (done && "fixMessage" in done) {
        // The page repeats an image: one round back to the agent before it is shown.
        savePage(competitorId, {
          progress: progress("check", "Replacing images used more than once…", Math.max(shownPct, 93), { activity }),
        });
        const sentAt = Date.now();
        await sendManusMessage(
          state.taskId,
          { content: done.fixMessage },
          MANUS_RESULT_SCHEMA as unknown as Record<string, unknown>,
        );
        saveState(competitorId, {
          imageFixes: (state.imageFixes || 0) + 1,
          nudges: 0,
          report: (done.report as unknown as Record<string, unknown> | null) ?? null,
          turnStartedAt: await anchorTurn(state.taskId, done.fixMessage, sentAt, signal),
        });
        continue;
      }
      if (done) return done;
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
      saveState(competitorId, { nudges: state.nudges + 1, turnStartedAt: await anchorTurn(state.taskId, NUDGE_MESSAGE, sentAt, signal) });
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
    const current = latestPage(competitorId).progress;
    savePage(competitorId, {
      progress: current
        ? { ...current, message: "Answering a question from the design agent…" }
        : progress("study", "Answering a question from the design agent…", 10),
    });
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
    handled({
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
      handled();
      return;
    }
  }
  // Declined or not consumable here: tell the agent to carry on without it.
  await sendManusMessage(state.taskId, {
    content: `Skip that step (${detail?.waiting_description || type}). ${decision.reason} Carry on with the brief and deliver ${MANUS_HTML_FILENAME}.`,
  });
  handled();
}

/**
 * Confirmations the run settles by itself. Anything that publishes, sends,
 * buys or connects an account is declined; the agent only needs to work in
 * its own sandbox and hand back a file.
 */
function confirmationFor(
  type: string,
  detail: ManusStatusDetail | null,
): { input: Record<string, unknown> | null; reason: string } {
  const deploying = /deploy|publish/i.test(detail?.waiting_description || "");
  switch (type) {
    case "terminalExecute":
      return { input: { accept: true, always_allow: true }, reason: "" };
    case "webdevRunAction":
      return deploying
        ? { input: { accept: false }, reason: "Do not deploy or publish anything." }
        : { input: { accept: true, mode: "speed" }, reason: "" };
    case "apiHighCreditNotice":
      return { input: { action: "accept" }, reason: "" };
    case "mapreduceAction":
      return { input: { accept: true }, reason: "" };
    case "needConnectMyBrowser":
      return { input: { action: "skip" }, reason: "Use your own browser." };
    case "videoGenerate":
      return { input: null, reason: "The page needs no video." };
    case "deployAction":
      return { input: { accept: false }, reason: "Do not deploy or publish anything." };
    case "webdevRequestSecrets":
      return { input: { accept: false }, reason: "No secrets are available; the page needs none." };
    default: {
      const acceptable = Boolean(detail?.confirm_input_schema?.properties && "accept" in detail.confirm_input_schema.properties);
      return {
        input: acceptable ? { accept: false } : null,
        reason: "That action is not needed for this job.",
      };
    }
  }
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
): Promise<CompetitorRecord | { fixMessage: string; report: ManusResult | null } | null> {
  const events = await manusEventsSince(state.taskId, state.turnStartedAt);
  const attachments = events.flatMap((e) => e.assistant_message?.attachments || []);
  const structured = [...events].reverse().find((e) => e.type === "structured_output_result")?.structured_output_result;
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

  const page = latestPage(competitorId);
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
    ...unresolved.slice(0, 6),
  ];
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
  const summary = [result?.summary, result?.verification?.notes, imageNote].filter(Boolean).join(" ");
  const editing = state.mode === "edit";

  savePage(competitorId, {
    status: "completed",
    html,
    // An edit keeps the page it changed for Undo; a build already set previousHtml when it started.
    previousHtml: editing ? page.html || page.previousHtml || null : page.previousHtml || null,
    lastEdit: editing
      ? {
          at: new Date().toISOString(),
          request: state.editRequest || "",
          changed: [],
          reverted: [],
          repaired: [],
          summary: sanitizeClientFacingText(result?.summary || "The design agent applied your changes."),
        }
      : page.lastEdit || null,
    differentiationNotes: sanitizeClientFacingText(`Design agent build ${MANUS_PIPELINE_VERSION}. ${summary}`.trim()),
    publishReady: publishBlockers.length === 0,
    publishBlockers,
    error: null,
    manus: { ...state, creditUsage: creditUsage ?? state.creditUsage ?? null },
    progress: progress("deliver", editing ? "Your changes are ready" : "Ready", 100, { done: true }),
  });
  console.info(`[manus] task ${state.taskId} delivered ${pick.filename || "the page"} (${Math.round(html.length / 1024)} KB)`);
  return getCompetitor(competitorId) || null;
}

/** Saves why a run ended without a page; a stop or a kept earlier page is not an error. */
function fail(competitorId: string, err: unknown, signal: AbortSignal): CompetitorRecord {
  // A stop saves its own state, and a run replaced by a newer one must not touch the page.
  const stopped = signal.aborted || (err as { name?: string })?.name === "AbortError";
  const page = getCompetitor(competitorId)?.recreatedPage;
  if (page && !stopped) {
    const message = sanitizeClientFacingText((err as Error)?.message || "Recreation failed");
    const stage = (STAGES.find((s) => s.id === page.progress?.phase)?.id || "build") as StageId;
    savePage(competitorId, {
      status: page.html ? "completed" : "failed",
      error: message,
      progress: progress(stage, message, page.progress?.pct || 0, { blocked: message }),
    });
  }
  if (!stopped) console.error("[manus] run failed", err);
  const latest = getCompetitor(competitorId);
  if (!latest) throw err;
  return latest;
}
