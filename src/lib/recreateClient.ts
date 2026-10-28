import type { RecreateJobDto } from "./recreateList";

/*
 * Browser side of "Add to Recreate": the details a recreation is queued
 * with, and the calls that queue it. Types only from server modules, so no
 * server code reaches the browser bundle.
 */

/**
 * The page looks a recreation can take. Same list as STYLE_DIRECTIONS in
 * pipeline/skills/playbook.ts, which reads files from disk and so cannot be
 * imported here (tests/recreateClient.test.ts keeps the two lists equal).
 */
export const STYLE_DIRECTIONS = ["brand", "minimal", "soft", "brutalist"] as const;
export type StyleDirection = (typeof STYLE_DIRECTIONS)[number];

export const STYLE_OPTIONS: ReadonlyArray<{ id: StyleDirection; label: string; hint: string }> = [
  { id: "brand", label: "Match the brand", hint: "The client's look, the competitor's layout." },
  { id: "minimal", label: "Minimal", hint: "Flat, airy, hairline borders, colour used sparingly." },
  { id: "soft", label: "High-end soft", hint: "Large rounded cards, soft shadows, lots of space." },
  { id: "brutalist", label: "Bold / brutalist", hint: "Square corners, solid rules, heavy headlines." },
];

/** Dispatched on `window` after a page is added, so lists of recreations can refresh. */
export const RECREATE_CHANGED_EVENT = "adrival:recreate-changed";

/** What the popup collects before a page is queued. */
export interface RecreateDetails {
  businessUrl: string;
  styleDirection: StyleDirection;
}

/** POST /api/recreate/jobs: a competitor record, or a landing page of a search's offers dashboard. */
export type EnqueueBody = ({ competitorId: string } | { jobId: string; url: string }) & {
  businessUrl?: string;
  styleDirection?: StyleDirection;
  userFeedback?: string;
  icpId?: string;
};

/** A failed recreate request, with a message fit to show as is. */
export class RecreateRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "RecreateRequestError";
    this.status = status;
    this.code = code;
  }
}

const GENERIC_FAILURE = "The page could not be added to Recreate. Try again.";

/** The popup's starting values: the run's website (else its profile's), and the brand look. */
export function defaultDetails(
  job: { businessUrl?: string | null; businessProfile?: { url?: string | null } | null } | null,
): RecreateDetails {
  const businessUrl = (job?.businessUrl || "").trim() || (job?.businessProfile?.url || "").trim();
  return { businessUrl, styleDirection: "brand" };
}

/** A JSON reply as an object; {} for an empty or non-JSON body (a proxy or crash page). */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = JSON.parse(await res.text());
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The error for a failed reply, in words a user can act on. */
function requestError(status: number, body: Record<string, unknown>): RecreateRequestError {
  const code = text(body.code);
  const serverMessage = text(body.error);
  let message: string;
  switch (status) {
    case 402:
      message = serverMessage || "There are not enough credits to recreate this page.";
      break;
    case 403:
      message = "You have view-only access to this search.";
      break;
    case 409:
      message = "This page is already being recreated with these details.";
      break;
    case 429:
      message = "Too many tasks are running, try again shortly.";
      break;
    default:
      // 400 and 404/422 carry a specific reason (e.g. business_url_required); other failures do not.
      message = status >= 400 && status < 500 && serverMessage ? serverMessage : GENERIC_FAILURE;
  }
  return new RecreateRequestError(status, code, message);
}

function announceChange(): void {
  const target = (globalThis as { window?: EventTarget }).window;
  if (target && typeof target.dispatchEvent === "function") target.dispatchEvent(new Event(RECREATE_CHANGED_EVENT));
}

/**
 * Adds a page to the Recreate queue. It starts now when a slot is free
 * (queuedAhead 0), else waits its turn. Throws RecreateRequestError.
 */
export async function enqueueRecreation(
  body: EnqueueBody,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<{ job: RecreateJobDto; queuedAhead: number }> {
  const res = await fetchImpl("/api/recreate/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await readJson(res);
  if (!res.ok) throw requestError(res.status, data);
  const job = data.job as RecreateJobDto | undefined;
  if (!job || typeof job !== "object" || typeof job.id !== "string") {
    throw new RecreateRequestError(res.status, null, GENERIC_FAILURE);
  }
  const queuedAhead = Number(data.queuedAhead);
  announceChange();
  return { job, queuedAhead: Number.isFinite(queuedAhead) && queuedAhead > 0 ? queuedAhead : 0 };
}

/**
 * Makes a lookup ad's page recreatable (the record the queue builds from) and
 * returns its id. Brands the lookup with `businessUrl` first, which can use
 * credits. Another version is always allowed, so no "already recreated" stop.
 */
export async function bridgeLookupAd(
  adId: string,
  businessUrl: string,
  fetchImpl: typeof fetch = (...args) => globalThis.fetch(...args),
): Promise<string> {
  const res = await fetchImpl("/api/lookup/recreate-bridge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adId, businessUrl, confirmRedesign: true }),
  });
  const data = await readJson(res);
  if (!res.ok) throw requestError(res.status, data);
  const competitorId = text(data.competitorId);
  if (!competitorId) throw new RecreateRequestError(res.status, null, GENERIC_FAILURE);
  return competitorId;
}
