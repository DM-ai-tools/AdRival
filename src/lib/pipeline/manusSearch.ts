import {
  confirmManusAction,
  createManusTask,
  getManusTask,
  hasManusKey,
  latestManusEvents,
  sendManusMessage,
  stopManusTask,
  type ManusEvent,
} from "../manus/client";
import { activityFromEvents, confirmationFor, plainText } from "../manus/events";
import { findManusProject } from "../manus/projects";

/**
 * Google / YouTube keyword search: a Manus agent (lite profile) opens Google
 * in the chosen country, picks the competing businesses for each keyword
 * (ads, normal results, the Maps / local pack) and checks each one's domain
 * in the Google Ads Transparency Center.
 * It writes one line per checked advertiser while it works, so the app can
 * fetch their ads from SociaVault and review them before the agent finishes.
 * City/suburb searches send each wider ring as a follow-up to the same task.
 */

/** One competitor the agent picked from Google and checked in the Transparency Center. */
export type SponsoredFind = {
  domain: string;
  advertiser: string | null;
  /** Ads the Transparency Center shows for the country, when the agent could read it. */
  adsCount: number | null;
  /** The Google search it appeared for. */
  search: string;
  headline: string | null;
  text: string | null;
  hasAds: boolean;
};

export type SponsoredStep = {
  queries: string[];
  /** Also read page 2 of the results and reload once (the "find more" round). */
  morePages?: boolean;
  /** Domains not to report again: the client's own and every one already checked. */
  skipDomains: string[];
};

export type SponsoredStepResult = { outcome: "finished" | "stopped" | "failed"; reason?: string };

const POLL_MS = 10_000;
/** Searches given to the agent per step. */
export const MAX_SPONSORED_QUERIES_PER_STEP = 6;
/** Domains listed in the "already checked" part of a message. */
const MAX_SKIP_LIST = 150;
/** After the agent stops, how long its structured list may lag behind. */
const RESULT_WAIT_MS = 45_000;
/** Questions answered for the agent before it is only told to carry on. */
const MAX_ANSWERS = 6;

const GOOGLE_HOSTS: Record<string, string> = {
  AU: "www.google.com.au",
  GB: "www.google.co.uk",
  NZ: "www.google.co.nz",
  CA: "www.google.ca",
  IN: "www.google.co.in",
  SG: "www.google.com.sg",
  DE: "www.google.de",
  AE: "www.google.ae",
  US: "www.google.com",
};

const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia", US: "the USA", GB: "the UK", CA: "Canada", NZ: "New Zealand", IN: "India", SG: "Singapore", DE: "Germany", AE: "the UAE",
};

/** Messages (rounds) one search run may send to its Manus task. */
export const MAX_AGENT_ROUNDS = 3;

/**
 * The run's search steps grouped into at most MAX_AGENT_ROUNDS rounds, in
 * order. A country-wide run: the country, then the "find more" round. A
 * city/suburb run: the nearer rings, then the wider rings with the country,
 * then the "find more" round. Steps with a `level` are local rings.
 */
export function groupIntoRounds<T extends { level: number | null }>(steps: T[], max = MAX_AGENT_ROUNDS): T[][] {
  const rings = steps.filter((s) => s.level != null);
  const country = steps.filter((s) => s.level == null);
  let rounds: T[][];
  if (!rings.length) {
    rounds = country.map((s) => [s]);
  } else {
    const near = Math.ceil(rings.length / 2);
    rounds = [rings.slice(0, near), [...rings.slice(near), ...country.slice(0, 1)], country.slice(1)];
  }
  rounds = rounds.filter((r) => r.length);
  while (rounds.length > max) {
    const last = rounds.pop()!;
    rounds[rounds.length - 1].push(...last);
  }
  return rounds;
}

/** Searches from several steps mixed so each step gets some: every step's first, then every second… */
export function interleaveQueries(lists: string[][], max = MAX_SPONSORED_QUERIES_PER_STEP): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i += 1) {
    for (const list of lists) {
      const q = list[i]?.trim();
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      out.push(q);
      if (out.length >= max) break;
    }
  }
  return out;
}

/**
 * Off by default: the agent was too slow in production, so Google / YouTube
 * searches use the web search. MANUS_SEARCH=on (with a Manus key) turns it on.
 */
export function manusSearchEnabled(): boolean {
  return hasManusKey() && /^(on|true|1|yes)$/i.test(process.env.MANUS_SEARCH?.trim() || "");
}

function agentProfile(): string {
  return process.env.MANUS_SEARCH_PROFILE?.trim() || "lite";
}

/** The Manus project (cloud folder) search tasks go into. */
export const DEFAULT_SEARCH_PROJECT_NAME = "Google Comp - AdRival";

/**
 * MANUS_SEARCH_PROJECT_ID, else the project named MANUS_SEARCH_PROJECT_NAME
 * (default "Google Comp - AdRival"; empty turns the folder off). A name that
 * matches no project leaves the task outside any folder rather than losing
 * the search, and says so.
 */
async function searchProject(): Promise<{ id: string | null; warning: string | null }> {
  const id = process.env.MANUS_SEARCH_PROJECT_ID?.trim();
  if (id) return { id, warning: null };
  const name = (process.env.MANUS_SEARCH_PROJECT_NAME ?? DEFAULT_SEARCH_PROJECT_NAME).trim();
  if (!name) return { id: null, warning: null };
  const found = await findManusProject(name);
  if ("missing" in found) {
    return { id: null, warning: `Manus project "${name}" was not found (projects: ${found.missing}); the search task was created outside it.` };
  }
  return { id: found.id, warning: null };
}

/** MANUS_POLL_MS shortens every wait proportionally (tests); the default poll is 10 s. */
function timeScale(): number {
  const poll = Number(process.env.MANUS_POLL_MS || "");
  return Number.isFinite(poll) && poll > 0 ? poll / POLL_MS : 1;
}

/** How long one step (a ring, the country, the "find more" round) may take. */
function stepTimeoutMs(): number {
  const minutes = Number(process.env.MANUS_SEARCH_TIMEOUT_MINUTES || 20);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 20) * 60_000 * timeScale();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function normalizeDomain(raw: string | null | undefined): string | null {
  const d = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = plainText(value, max);
  return t || null;
}

function toCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 0 && String(value ?? "").trim() !== "" ? Math.round(n) : null;
}

/**
 * `FOUND {...}` and `NOADS {...}` lines from the agent's messages. Lines may
 * sit in a list or a code block; anything that is not valid JSON is skipped.
 */
export function parseSponsoredLines(text: string): SponsoredFind[] {
  const out: SponsoredFind[] = [];
  const re = /(FOUND|NOADS)\s*:?\s*(\{[^\n]*\})/g;
  for (const m of text.matchAll(re)) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(m[2]) as Record<string, unknown>;
    } catch {
      continue;
    }
    const domain = normalizeDomain(row.domain as string);
    if (!domain) continue;
    out.push({
      domain,
      advertiser: cleanText(row.advertiser, 120),
      adsCount: toCount(row.ads),
      search: cleanText(row.search, 160) || "",
      headline: cleanText(row.headline, 200),
      text: cleanText(row.text, 400),
      hasAds: m[1] === "FOUND",
    });
  }
  return out;
}

/** The final list the agent is asked for, in case some lines were never posted. */
export const SPONSORED_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["advertisers", "blocked_by_google"],
  properties: {
    advertisers: {
      type: "array",
      description: "Every competitor checked in the Transparency Center during this request.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["domain", "advertiser", "has_ads", "ads", "search", "headline", "text"],
        properties: {
          domain: { type: "string", description: "The competitor's website domain, e.g. example.com.au" },
          advertiser: { type: ["string", "null"], description: "Advertiser name in the Transparency Center" },
          has_ads: { type: "boolean", description: "The Transparency Center shows ads for this domain in the country" },
          ads: { type: ["integer", "null"], description: "Number of ads the Transparency Center shows, if visible" },
          search: { type: "string", description: "The Google search it appeared for" },
          headline: { type: ["string", "null"], description: "Title of its Google result (ad headline, result title or Maps name)" },
          text: { type: ["string", "null"], description: "Text of its Google result (ad text, snippet or Maps category)" },
        },
      },
    },
    blocked_by_google: { type: "boolean", description: "Google blocked every search (CAPTCHA / unusual traffic)" },
  },
} as const;

type SchemaRow = {
  domain?: string;
  advertiser?: string | null;
  has_ads?: boolean;
  ads?: number | null;
  search?: string;
  headline?: string | null;
  text?: string | null;
};

export function findsFromStructured(value: unknown): SponsoredFind[] {
  const rows = (value as { advertisers?: SchemaRow[] } | null)?.advertisers;
  if (!Array.isArray(rows)) return [];
  const out: SponsoredFind[] = [];
  for (const row of rows) {
    const domain = normalizeDomain(row?.domain);
    if (!domain) continue;
    out.push({
      domain,
      advertiser: cleanText(row.advertiser, 120),
      adsCount: toCount(row.ads),
      search: cleanText(row.search, 160) || "",
      headline: cleanText(row.headline, 200),
      text: cleanText(row.text, 400),
      hasAds: row.has_ads !== false,
    });
  }
  return out;
}

export function googleSearchUrl(query: string, country: string, page = 1): string {
  const host = GOOGLE_HOSTS[country] || "www.google.com";
  const params = new URLSearchParams({ q: query, gl: country.toLowerCase(), hl: "en", pws: "0" });
  if (page > 1) params.set("start", String((page - 1) * 10));
  return `https://${host}/search?${params.toString()}`;
}

export function transparencyUrl(domain: string, country: string, platform: "google" | "youtube"): string {
  const params = new URLSearchParams({ region: country, domain });
  if (platform === "youtube") params.set("platform", "YOUTUBE");
  return `https://adstransparency.google.com/?${params.toString()}`;
}

export type SponsoredBriefInput = {
  country: string;
  platform: "google" | "youtube";
  /** What the client sells, so the agent can skip results that are plainly unrelated. */
  industry?: string | null;
  /** An online store: skip marketplaces and department stores. */
  productSeed?: boolean;
};

/**
 * The message for one step: the first one carries the full instructions,
 * later ones only the new searches. The agent takes the competing businesses
 * Google shows for each search (ads, normal results, the Maps / local pack),
 * not only ads: many competitors that advertise do not show an ad to a
 * browser outside the country.
 */
export function buildSponsoredMessage(input: SponsoredBriefInput, step: SponsoredStep, first: boolean): string {
  const { country, platform } = input;
  const countryName = COUNTRY_NAMES[country] || country;
  const searches = step.queries
    .map((q) => `- "${q}" → ${googleSearchUrl(q, country)}${step.morePages ? `  (page 2: ${googleSearchUrl(q, country, 2)})` : ""}`)
    .join("\n");
  const skip = step.skipDomains.slice(0, MAX_SKIP_LIST);
  const skipText = skip.length ? `\nAlready checked, do not report again: ${skip.join(", ")}\n` : "";
  const exampleDomain = country === "AU" ? "example.com.au" : "example.com";
  const ytFilter =
    platform === "youtube"
      ? " The link filters to YouTube; count only video ads. A business with no video ads counts as no ads."
      : "";
  const morePages = step.morePages
    ? "\nAlso open page 2 of each search, and the Maps \"More places\" list, for businesses not checked yet.\n"
    : "";

  if (!first) {
    return `Next searches, same instructions as before (competing businesses from the Google results and Maps, Transparency Center region ${country}, post a FOUND or NOADS line for each one as you go):
${searches}
${skipText}${morePages}
When every search is done, stop.`;
  }

  return `Find the businesses competing on Google in ${countryName} for these searches, and check which of them run Google ads. Work in your browser only: do not write code, create files or websites, and do not ask me anything.

Searches (open each link; it is Google ${countryName}, English):
${searches}
${morePages}
For each search:
1. Pick up to 8 businesses that sell what was searched, from anywhere on the page: ads, the normal results, and the Maps / local pack when it shows (open a Maps listing to get its website; skip listings with no website).
2. Note each one's website domain (e.g. ${exampleDomain}), its name, and the title and text Google shows for it.
3. If Google shows a consent page, accept it. If it shows a CAPTCHA or "unusual traffic" page, wait a few seconds and retry once, then try https://www.google.com/search with the same q, gl and hl. If still blocked, move on to the next search.

Only real businesses that sell it. Skip ${input.productSeed ? "marketplaces, department and general stores, " : ""}directories and listing sites, review, quote and job sites, news, blogs and guides, government and comparison sites.${input.industry ? ` The client is in: ${input.industry}. Skip businesses that plainly sell something unrelated.` : ""}
${skipText}
Then check each new business's domain in the Google Ads Transparency Center for ${countryName}:
https://adstransparency.google.com/?region=${country}&domain=<domain>${platform === "youtube" ? "&platform=YOUTUBE" : ""}
Wait for the results to load and read how many ads it shows and the advertiser name.${ytFilter}

Right after checking each domain, post one line in your reply (exactly this format, valid JSON on one line):
FOUND {"domain":"${exampleDomain}","advertiser":"Name in Transparency Center","ads":12,"search":"the search","headline":"title Google shows","text":"text Google shows"}
or, when the Transparency Center shows no ads in ${countryName}:
NOADS {"domain":"${exampleDomain}","search":"the search"}
Post these lines as you go (a short message after every two or three domains), not only at the end. Use null for anything you could not read.

When every search is done, stop.`;
}

/** The answer to any question the agent asks: it has everything it needs. */
const CARRY_ON =
  "Please decide yourself and carry on with the searches. Post a FOUND or NOADS line for each business you check and stop when every search is done.";

/**
 * One Manus task for a whole search run. Each step (a ring, the country,
 * the "find more" round) is a message to the same task, so the agent keeps
 * what it already checked.
 */
export class SponsoredSearchAgent {
  taskId: string | null = null;
  taskUrl: string | null = null;
  /** Domains already handed to the app (from lines or the final list). */
  private reported = new Set<string>();
  private handledEvents = new Set<string>();
  private answers = 0;
  private running = false;

  constructor(
    private readonly brief: SponsoredBriefInput & { title: string },
    private readonly hooks: {
      /** True once the run is stopped or the list is full: the task is stopped too. */
      isStopped: () => boolean | Promise<boolean>;
      /** The agent's latest action or note, for the live progress line. */
      onActivity?: (text: string) => void;
      /** Called once the task exists, to save its id on the run. */
      onTask?: (task: { taskId: string; taskUrl: string | null }) => void | Promise<void>;
    },
  ) {}

  /** Sends one step and streams new finds to `onFinds` until the agent stops. Errors from `onFinds` are thrown. */
  async runStep(step: SponsoredStep, onFinds: (finds: SponsoredFind[]) => Promise<void>): Promise<SponsoredStepResult> {
    if (await this.hooks.isStopped()) return { outcome: "stopped" };
    const scale = timeScale();
    const first = !this.taskId;
    const content = buildSponsoredMessage(this.brief, step, first);
    try {
      if (first) {
        const project = await searchProject();
        if (project.warning) console.warn(`[manusSearch] ${project.warning}`);
        const created = await createManusTask({
          message: { content },
          title: this.brief.title,
          projectId: project.id,
          agentProfile: agentProfile(),
          interactive: false,
          structuredOutputSchema: SPONSORED_RESULT_SCHEMA as unknown as Record<string, unknown>,
        });
        this.taskId = created.task_id;
        this.taskUrl = created.task_url || null;
        await this.hooks.onTask?.({ taskId: this.taskId, taskUrl: this.taskUrl });
      } else {
        // Events already in the task belong to earlier steps.
        await this.markSeen();
        await sendManusMessage(this.taskId!, { content }, SPONSORED_RESULT_SCHEMA as unknown as Record<string, unknown>);
      }
    } catch (err) {
      return { outcome: "failed", reason: (err as Error).message };
    }
    this.running = true;

    const sentAt = Date.now();
    const deadline = sentAt + stepTimeoutMs();
    let stoppedAt: number | null = null;
    let sawNewEvent = false;
    let gotStructured = false;
    let blocked = false;

    while (true) {
      await sleep(POLL_MS * scale);
      if (await this.hooks.isStopped()) {
        await this.stop();
        return { outcome: "stopped" };
      }
      if (Date.now() > deadline) {
        await this.stop();
        return { outcome: "failed", reason: `the search agent did not finish within ${Math.round(stepTimeoutMs() / 60_000 / scale)} minutes` };
      }

      let events: ManusEvent[];
      let status: string;
      try {
        events = await latestManusEvents(this.taskId!, 100, true);
        status = (await getManusTask(this.taskId!)).status;
      } catch (err) {
        await this.stop();
        return { outcome: "failed", reason: (err as Error).message };
      }

      const fresh = events
        .filter((e) => !this.handledEvents.has(e.id))
        .sort((a, b) => a.timestamp - b.timestamp);
      for (const e of fresh) this.handledEvents.add(e.id);
      // Our own message is not a sign the agent has picked the step up.
      if (fresh.some((e) => e.type !== "user_message")) sawNewEvent = true;

      const finds: SponsoredFind[] = [];
      for (const e of fresh) {
        if (e.type === "assistant_message" && e.assistant_message?.content) {
          finds.push(...parseSponsoredLines(e.assistant_message.content));
        } else if (e.type === "structured_output_result") {
          gotStructured = true;
          const value = e.structured_output_result?.value;
          if (e.structured_output_result?.success !== false) {
            finds.push(...findsFromStructured(value));
            blocked = Boolean((value as { blocked_by_google?: boolean } | undefined)?.blocked_by_google);
          }
        }
      }
      // Messages carrying result lines are summed up by the caller instead.
      const feed = activityFromEvents(fresh).filter((a) => !/\b(FOUND|NOADS)\b/.test(a.text));
      const latest = feed[feed.length - 1];
      if (latest) this.hooks.onActivity?.(latest.text);

      const newFinds = finds.filter((f) => {
        if (this.reported.has(f.domain)) return false;
        this.reported.add(f.domain);
        return true;
      });
      // Errors here (e.g. SociaVault out of credits) end the run: stop the agent first.
      if (newFinds.length) {
        try {
          await onFinds(newFinds);
        } catch (err) {
          await this.stop();
          throw err;
        }
      }

      if (status === "error") {
        this.running = false;
        return { outcome: "failed", reason: "the search agent reported an error" };
      }
      if (status === "waiting") {
        try {
          await this.settleWaiting(events);
        } catch (err) {
          await this.stop();
          return { outcome: "failed", reason: (err as Error).message };
        }
        continue;
      }
      // A just-sent message can still show the previous "stopped" for a moment.
      const settled = sawNewEvent || Date.now() - sentAt > 30_000 * scale;
      if (status === "stopped" && settled) {
        stoppedAt ??= Date.now();
        // The final list is prepared after the agent stops; give it a moment.
        if (gotStructured || Date.now() - stoppedAt > RESULT_WAIT_MS * scale) {
          this.running = false;
          if (blocked && this.reported.size === 0) {
            return { outcome: "failed", reason: "Google blocked the search agent's searches" };
          }
          return { outcome: "finished" };
        }
      } else if (status === "running") {
        stoppedAt = null;
      }
    }
  }

  /** Stops the task when it is still working (list full, run stopped, or a failure). */
  async stop(): Promise<void> {
    if (!this.taskId || !this.running) return;
    this.running = false;
    await stopManusTask(this.taskId).catch(() => undefined);
  }

  private async markSeen() {
    const events = await latestManusEvents(this.taskId!, 100, true);
    for (const e of events) this.handledEvents.add(e.id);
  }

  /** A question gets "carry on"; confirmations are settled like the recreate agent's. */
  private async settleWaiting(events: ManusEvent[]) {
    const waiting = [...events]
      .sort((a, b) => b.timestamp - a.timestamp)
      .find((e) => e.type === "status_update" && e.status_update?.agent_status === "waiting");
    const detail = waiting?.status_update?.status_detail || null;
    const eventId = detail?.waiting_for_event_id;
    const key = `waiting:${eventId || waiting?.id || "?"}`;
    if (!this.taskId || this.handledEvents.has(key)) return;
    this.handledEvents.add(key);
    const type = detail?.waiting_for_event_type || "";
    if (type === "messageAskUser" || type === "cascadeAskUser" || !eventId) {
      this.answers += 1;
      if (this.answers > MAX_ANSWERS) throw new Error("the search agent kept asking questions");
      await sendManusMessage(this.taskId, { content: CARRY_ON });
      return;
    }
    const decision = confirmationFor(type, detail);
    if (decision.input && (await confirmManusAction(this.taskId, eventId, decision.input).catch(() => false))) return;
    await sendManusMessage(this.taskId, {
      content: `Skip that step. ${decision.reason} ${CARRY_ON}`,
    });
  }
}
