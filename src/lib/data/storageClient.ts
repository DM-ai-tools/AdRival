/*
 * Supabase Storage over its REST API with plain `fetch` (no supabase-js).
 * Server side only: it authenticates with the service-role key, which must
 * never reach a browser, a log line or an error message.
 *
 * Endpoints used (Storage API v1, under `${SUPABASE_URL}/storage/v1`):
 *   GET    /bucket/{bucket}                     bucket exists?
 *   POST   /bucket                              create {id, name, public:false}
 *   POST   /object/{bucket}/{path}              upload (x-upsert: true)
 *   GET    /object/authenticated/{bucket}/{path} download
 *   DELETE /object/{bucket}/{path}              delete one object
 *   POST   /object/list/{bucket}                list {prefix, limit, offset, sortBy}
 * Every request sends `Authorization: Bearer <key>` and `apikey: <key>` (the
 * API gateway in front of Storage wants the apikey header).
 */

/** What the archive (Task 8) and the backups (Task 10) need from Storage. */
export interface StorageLike {
  putObject(bucket: string, path: string, body: Buffer): Promise<void>;
  getObject(bucket: string, path: string): Promise<Buffer>;
  deleteObject(bucket: string, path: string): Promise<void>;
  /** Full object paths (`prefix/name`) directly under `prefix` (one level, like the Storage API), folders left out. */
  list(bucket: string, prefix: string): Promise<string[]>;
}

/** The object does not exist. */
export class StorageNotFoundError extends Error {
  constructor(bucket: string, path: string) {
    super(`Storage object not found: ${bucket}/${path}`);
    this.name = "StorageNotFoundError";
  }
}

/** SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. */
export class StorageNotConfiguredError extends Error {
  constructor(variable: string) {
    super(`Supabase Storage is not configured: set ${variable} in the environment.`);
    this.name = "StorageNotConfiguredError";
  }
}

/** A Storage request failed (HTTP status or network); the message never contains the key. */
export class StorageRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "StorageRequestError";
  }
}

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const LIST_PAGE = 1000;

export interface SupabaseStorageOptions {
  /** Defaults to SUPABASE_URL, read on each call. */
  url?: string;
  /** Defaults to SUPABASE_SERVICE_ROLE_KEY, read on each call. */
  serviceRoleKey?: string;
  /** First retry delay (doubles after); default 500 ms. */
  retryDelayMs?: number;
}

/** Both settings are present (an in-memory Storage set for tests also counts). */
export function storageConfigured(): boolean {
  return Boolean(override || (process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()));
}

/** Each path segment URL-encoded, slashes kept. */
function encodePath(path: string): string {
  return path
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

/** A short, key-free description of an error body. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

/** Storage answers a missing object with 404, or (older versions) 400 and a body whose statusCode is "404". */
function looksNotFound(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /"statusCode"\s*:\s*"?404"?/.test(body) || /not[_ ]?found/i.test(body);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof StorageRequestError) return err.status === null || err.status >= 500;
  return false;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Supabase Storage client. Settings are read when a call is made. */
export function createSupabaseStorage(options: SupabaseStorageOptions = {}): StorageLike {
  const retryDelay = options.retryDelayMs ?? 500;
  const ensured = new Map<string, Promise<void>>();

  function settings(): { base: string; key: string } {
    const url = (options.url ?? process.env.SUPABASE_URL ?? "").trim();
    if (!url) throw new StorageNotConfiguredError("SUPABASE_URL");
    const key = (options.serviceRoleKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
    if (!key) throw new StorageNotConfiguredError("SUPABASE_SERVICE_ROLE_KEY");
    return { base: `${url.replace(/\/+$/, "")}/storage/v1`, key };
  }

  /** One request; a network failure or timeout becomes a StorageRequestError with no status. */
  async function send(
    what: string,
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: BodyInit } = {},
  ): Promise<Response> {
    const { base, key } = settings();
    try {
      return await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, apikey: key, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new StorageRequestError(`Storage ${what} failed: ${reason.replaceAll(key, "[key]")}`, null);
    }
  }

  async function failure(what: string, res: Response): Promise<StorageRequestError> {
    const { key } = settings();
    const body = (await bodySnippet(res)).replaceAll(key, "[key]");
    return new StorageRequestError(`Storage ${what} failed: HTTP ${res.status}${body ? ` ${body}` : ""}`, res.status);
  }

  async function withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
        await wait(retryDelay * 2 ** attempt);
      }
    }
  }

  /** Creates the bucket (private) when it does not exist; once per bucket per process. */
  function ensureBucket(bucket: string): Promise<void> {
    let pending = ensured.get(bucket);
    if (!pending) {
      pending = createBucketIfMissing(bucket);
      ensured.set(bucket, pending);
      // A failed check is tried again on the next call.
      void pending.catch(() => ensured.delete(bucket));
    }
    return pending;
  }

  async function createBucketIfMissing(bucket: string): Promise<void> {
    const found = await send(`bucket check ${bucket}`, "GET", `/bucket/${encodeURIComponent(bucket)}`);
    if (found.ok) {
      await found.body?.cancel();
      return;
    }
    const body = await bodySnippet(found);
    if (!looksNotFound(found.status, body)) {
      throw new StorageRequestError(`Storage bucket check ${bucket} failed: HTTP ${found.status}`, found.status);
    }
    const created = await send(`bucket create ${bucket}`, "POST", "/bucket", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: bucket, name: bucket, public: false }),
    });
    if (created.ok) {
      await created.body?.cancel();
      return;
    }
    const text = await bodySnippet(created);
    // Created by someone else in between.
    if (created.status === 409 || /already exists|duplicate/i.test(text)) return;
    throw failureFromText(`bucket create ${bucket}`, created.status, text);
  }

  function failureFromText(what: string, status: number, text: string): StorageRequestError {
    const { key } = settings();
    return new StorageRequestError(`Storage ${what} failed: HTTP ${status}${text ? ` ${text.replaceAll(key, "[key]")}` : ""}`, status);
  }

  return {
    async putObject(bucket, path, body) {
      await withRetries(() => ensureBucket(bucket));
      await withRetries(async () => {
        const what = `upload ${bucket}/${path}`;
        const res = await send(what, "POST", `/object/${encodeURIComponent(bucket)}/${encodePath(path)}`, {
          headers: { "content-type": "application/gzip", "x-upsert": "true", "cache-control": "no-cache" },
          body: new Uint8Array(body),
        });
        if (!res.ok) throw await failure(what, res);
        await res.body?.cancel();
      });
    },

    async getObject(bucket, path) {
      return withRetries(async () => {
        const what = `download ${bucket}/${path}`;
        const res = await send(what, "GET", `/object/authenticated/${encodeURIComponent(bucket)}/${encodePath(path)}`);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        const text = await bodySnippet(res);
        if (looksNotFound(res.status, text)) throw new StorageNotFoundError(bucket, path);
        throw failureFromText(what, res.status, text);
      });
    },

    async deleteObject(bucket, path) {
      const what = `delete ${bucket}/${path}`;
      const res = await send(what, "DELETE", `/object/${encodeURIComponent(bucket)}/${encodePath(path)}`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      const text = await bodySnippet(res);
      if (looksNotFound(res.status, text)) return;
      throw failureFromText(what, res.status, text);
    },

    async list(bucket, prefix) {
      const folder = prefix.replace(/^\/+|\/+$/g, "");
      const out: string[] = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const what = `list ${bucket}/${folder}`;
        const res = await send(what, "POST", `/object/list/${encodeURIComponent(bucket)}`, {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prefix: folder, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } }),
        });
        if (!res.ok) throw await failure(what, res);
        const rows = (await res.json()) as Array<{ name: string; id: string | null }>;
        for (const r of rows) {
          // Folders come back with a null id.
          if (r.id === null || r.id === undefined) continue;
          out.push(folder ? `${folder}/${r.name}` : r.name);
        }
        if (rows.length < LIST_PAGE) return out;
      }
    },
  };
}

/** An in-memory Storage for tests; `objects` is keyed `bucket/path`. */
export function createMemoryStorage(): StorageLike & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  const key = (bucket: string, path: string) => `${bucket}/${path}`;
  return {
    objects,
    putObject: (bucket, path, body) => {
      objects.set(key(bucket, path), Buffer.from(body));
      return Promise.resolve();
    },
    getObject: (bucket, path) => {
      const found = objects.get(key(bucket, path));
      return found ? Promise.resolve(Buffer.from(found)) : Promise.reject(new StorageNotFoundError(bucket, path));
    },
    deleteObject: (bucket, path) => {
      objects.delete(key(bucket, path));
      return Promise.resolve();
    },
    list: (bucket, prefix) => {
      const folder = prefix.replace(/^\/+|\/+$/g, "");
      const start = folder ? `${bucket}/${folder}/` : `${bucket}/`;
      // One level, like the Storage list endpoint.
      return Promise.resolve(
        [...objects.keys()]
          .filter((k) => k.startsWith(start) && !k.slice(start.length).includes("/"))
          .map((k) => k.slice(bucket.length + 1))
          .sort(),
      );
    },
  };
}

let override: StorageLike | null = null;
let real: StorageLike | null = null;

/** The Storage in use: the test override when set, else the Supabase client. */
export function getStorage(): StorageLike {
  if (override) return override;
  real ??= createSupabaseStorage();
  return real;
}

/** Swaps in a Storage for tests; null goes back to the Supabase client. */
export function setStorageForTests(impl: StorageLike | null): void {
  override = impl;
}
