/**
 * Manus API v2 (https://open.manus.ai/docs/v2/introduction).
 * Every call is `POST|GET https://api.manus.ai/v2/<method>` with the
 * `x-manus-api-key` header; responses are `{ ok, request_id, ... }`.
 */

const BASE_URL = (process.env.MANUS_API_BASE_URL?.trim() || "https://api.manus.ai").replace(/\/$/, "");

export function hasManusKey(): boolean {
  return Boolean(process.env.MANUS_API_KEY?.trim());
}

export class ManusApiError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number,
  ) {
    super(message);
    this.name = "ManusApiError";
  }
}

export type ManusContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file_url?: string; file_data?: string; file_id?: string; filename?: string; mime_type?: string };

export type ManusMessage = {
  content: string | ManusContentPart[];
  /** Connector ids switched on for the task (from connector.list). */
  connectors?: string[];
};

export type ManusAttachment = {
  type?: "image" | "file" | "voice" | "slides";
  filename?: string;
  url?: string;
  path?: string;
  content_type?: string;
};

export type ManusStatusDetail = {
  waiting_for_event_id?: string;
  waiting_for_event_type?: string;
  waiting_description?: string;
  confirm_input_schema?: { properties?: Record<string, unknown>; required?: string[] } | null;
};

export type ManusEvent = {
  id: string;
  type:
    | "user_message"
    | "assistant_message"
    | "error_message"
    | "status_update"
    | "tool_used"
    | "plan_update"
    | "new_plan_step"
    | "explanation"
    | "user_stop"
    | "structured_output_result"
    | string;
  timestamp: number;
  user_message?: { content?: string };
  assistant_message?: {
    content?: string;
    attachments?: ManusAttachment[];
    question_expectation?: { options?: string[]; selection_mode?: "single" | "multiple" } | null;
  };
  error_message?: { error_type?: string; content?: string };
  status_update?: {
    agent_status?: "running" | "stopped" | "waiting" | "error";
    status_detail?: ManusStatusDetail | null;
    brief?: string;
    description?: string;
  };
  plan_update?: { steps?: Array<{ status?: "todo" | "doing" | "done" | "failed"; title?: string }> };
  structured_output_result?: { success?: boolean; value?: Record<string, unknown>; error?: string | null };
};

export type ManusTask = {
  id: string;
  status: "running" | "stopped" | "waiting" | "error";
  title?: string;
  task_url?: string;
  credit_usage?: number;
  has_running_background_jobs?: boolean;
};

function apiKey(): string {
  const key = process.env.MANUS_API_KEY?.trim();
  if (!key) throw new ManusApiError("MANUS_API_KEY is not set. Add it to the environment to use the design agent.", "unauthenticated", 401);
  return key;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One API call, retried with backoff on rate limits, server errors and dropped connections. */
async function call<T>(method: string, init: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T> {
  const url = new URL(`${BASE_URL}/v2/${method}`);
  for (const [k, v] of Object.entries(init.query || {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const key = apiKey();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt) await sleep(1500 * 2 ** (attempt - 1) + Math.random() * 500);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.body === undefined ? "GET" : "POST",
        headers: {
          "x-manus-api-key": key,
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      lastError = err;
      continue;
    }
    const data = (await res.json().catch(() => null)) as
      | ({ ok?: boolean; error?: { code?: string; message?: string } } & Record<string, unknown>)
      | null;
    if (res.ok && data?.ok !== false) return data as T;
    const code = data?.error?.code || null;
    const message = data?.error?.message || `Manus ${method} failed (${res.status})`;
    lastError = new ManusApiError(message, code, res.status);
    if (res.status === 429 || res.status >= 500) continue;
    throw lastError;
  }
  throw lastError instanceof Error ? lastError : new ManusApiError(`Manus ${method} failed`, null, 0);
}

export type ManusProject = { id: string; name: string; instruction?: string };

export type ManusConnector = { id: string; name: string; type?: string };

/** Connectors installed in the account. */
export async function listManusConnectors(): Promise<ManusConnector[]> {
  const res = await call<{ data?: ManusConnector[] }>("connector.list", {});
  return res.data || [];
}

export async function listManusProjects(): Promise<ManusProject[]> {
  const res = await call<{ data?: ManusProject[] }>("project.list", {});
  return res.data || [];
}

export async function createManusTask(input: {
  message: ManusMessage;
  title?: string;
  /** Manus project (folder) the task is created in; its instruction applies too. */
  projectId?: string | null;
  agentProfile?: string;
  interactive?: boolean;
  structuredOutputSchema?: Record<string, unknown>;
}): Promise<{ task_id: string; task_url?: string; task_title?: string }> {
  return call("task.create", {
    body: {
      message: input.message,
      project_id: input.projectId || undefined,
      title: input.title,
      locale: "en",
      agent_profile: input.agentProfile || undefined,
      interactive_mode: input.interactive ?? true,
      structured_output_schema: input.structuredOutputSchema,
    },
  });
}

export async function sendManusMessage(
  taskId: string,
  message: ManusMessage,
  structuredOutputSchema?: Record<string, unknown>,
): Promise<void> {
  await call("task.sendMessage", {
    body: { task_id: taskId, message, structured_output_schema: structuredOutputSchema },
  });
}

export async function confirmManusAction(
  taskId: string,
  eventId: string,
  input: Record<string, unknown>,
): Promise<boolean> {
  const res = await call<{ confirmed?: boolean }>("task.confirmAction", {
    body: { task_id: taskId, event_id: eventId, input },
  });
  return res.confirmed !== false;
}

export async function getManusTask(taskId: string): Promise<ManusTask> {
  const res = await call<{ task: ManusTask }>("task.detail", { query: { task_id: taskId } });
  return res.task;
}

export async function stopManusTask(taskId: string): Promise<void> {
  await call("task.stop", { body: { task_id: taskId } });
}

/** Newest events first (one page). `verbose` adds plan and tool events. */
export async function latestManusEvents(taskId: string, limit = 50, verbose = true): Promise<ManusEvent[]> {
  const res = await call<{ messages?: ManusEvent[] }>("task.listMessages", {
    query: { task_id: taskId, order: "desc", limit, verbose },
  });
  return res.messages || [];
}

/** Every event since `sinceMs`, oldest first, paging through the history. */
export async function manusEventsSince(taskId: string, sinceMs: number): Promise<ManusEvent[]> {
  const out: ManusEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 40; page += 1) {
    const res = await call<{ messages?: ManusEvent[]; has_more?: boolean; next_cursor?: string }>("task.listMessages", {
      query: { task_id: taskId, order: "desc", limit: 200, verbose: false, cursor },
    });
    const batch = res.messages || [];
    out.push(...batch);
    const reachedStart = batch.some((e) => e.timestamp < sinceMs);
    if (!res.has_more || !res.next_cursor || reachedStart) break;
    cursor = res.next_cursor;
  }
  return out.filter((e) => e.timestamp >= sinceMs).sort((a, b) => a.timestamp - b.timestamp);
}
