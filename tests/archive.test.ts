import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import { getDb, setClientForTests } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import {
  ARCHIVE_BUCKET,
  ArchivedPageUnavailableError,
  archiveObjectPath,
  archiveOldPages,
  archiveTick,
  deleteArchivedFor,
  startArchiveScheduler,
} from "../src/lib/data/archive";
import {
  createMemoryStorage,
  createSupabaseStorage,
  setStorageForTests,
  StorageNotConfiguredError,
  StorageNotFoundError,
  type StorageLike,
} from "../src/lib/data/storageClient";
import * as competitors from "../src/lib/data/competitors";
import * as identity from "../src/lib/data/identity";
import * as pages from "../src/lib/data/recreatedPages";
import * as runs from "../src/lib/data/runs";
import type { AppUser, CompetitorRecord, RecreatedPageHeavy, SearchJob } from "../src/lib/types";
import { asUser, jsonRequest, readJson } from "./helpers/routeRequest";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Archiving old recreated pages to Storage (an in-memory Storage here; the
 * Supabase REST client is checked against a fake fetch at the end).
 */

process.env.SESSION_SECRET = "archive-test-secret";
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.RECREATED_PAGE_ARCHIVE_DAYS;

const archiveRoute = await import("../src/app/api/admin/archive-pages/route");

let client: PgliteTestClient;
let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(async () => {
  client = await createPgliteClient();
  await migrate(client);
  setClientForTests(client);
  storage = createMemoryStorage();
  setStorageForTests(storage);
});

afterEach(async () => {
  setStorageForTests(null);
  setClientForTests(null);
  await client.close();
});

let seq = 0;

function makeJob(): SearchJob {
  seq += 1;
  const at = new Date().toISOString();
  return {
    id: `arc-job-${seq}`,
    keyword: "plumber",
    keywords: ["plumber"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: { stage: "done", scannedAds: 0, scannedPages: 0, accepted: 1, target: 10, rejected: 0, message: "" },
    competitorIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
  };
}

const HTML = `<html><body>${"<p>recreated copy 0123456789</p>".repeat(2000)}</body></html>`;

function heavyFor(n: number): RecreatedPageHeavy {
  return {
    html: `${HTML}<!-- ${n} -->`,
    previousHtml: "<html>before</html>",
    sourceArchive: {
      html: "<html>source</html>",
      finalUrl: "https://rival.invalid",
      title: "Rival",
      capturedAt: "2026-01-01T00:00:00.000Z",
      source: "playwright",
      nodeCount: 7,
    },
    generatedImages: [],
  };
}

/** A competitor with page content whose last change was `ageDays` ago. */
async function pageAged(ageDays: number, runId?: string): Promise<{ id: string; runId: string; heavy: RecreatedPageHeavy }> {
  let jobId = runId;
  if (!jobId) {
    const job = makeJob();
    assert.equal(await runs.saveJob(job), true);
    jobId = job.id;
  }
  seq += 1;
  const id = `arc-comp-${seq}`;
  const heavy = heavyFor(seq);
  const competitor = {
    id,
    runId: jobId,
    pageId: `arc-page-${seq}`,
    pageName: "Rival",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 1,
    services: [],
    sampleAd: { adArchiveId: "a", title: "t", body: "b", daysRunning: 1, adLibraryUrl: "https://x.invalid" },
    brand: {},
    createdAt: new Date().toISOString(),
  } as CompetitorRecord;
  assert.equal(await competitors.saveCompetitor({ ...competitor, recreatedPageHeavy: heavy }), true);
  // Age 0 keeps the time the page was written (the app's clock, as in production).
  if (ageDays === 0) return { id, runId: jobId, heavy };
  await getDb().query(
    "update recreated_pages set updated_at = now() - make_interval(days => $2::int) where competitor_id = $1",
    [id, ageDays],
  );
  return { id, runId: jobId, heavy };
}

type Row = { content: Buffer | null; archive_path: string | null; archived_at: Date | string | null };

async function row(id: string): Promise<Row | undefined> {
  const { rows } = await getDb().query<Row>(
    "select content, archive_path, archived_at from recreated_pages where competitor_id = $1",
    [id],
  );
  return rows[0];
}

/* ── archiving ── */

test("a page older than 14 days is archived and reads back identically", async () => {
  const old = await pageAged(20);
  const before = (await row(old.id))!.content!;

  assert.deepEqual(await archiveOldPages(), { archived: 1, failed: 0 });

  const after = (await row(old.id))!;
  assert.equal(after.content, null);
  assert.equal(after.archive_path, `${ARCHIVE_BUCKET}/${archiveObjectPath(old.id)}`);
  assert.ok(after.archived_at);
  assert.deepEqual(storage.objects.get(`${ARCHIVE_BUCKET}/${archiveObjectPath(old.id)}`), Buffer.from(before));
  assert.deepEqual(await pages.getRecreatedPage(old.id), old.heavy);
  // The light page still says there is a page.
  const light = await competitors.getCompetitor(old.id);
  assert.equal((light?.recreatedPage as { hasPage?: boolean }).hasPage, true);
});

test("a page younger than the window is untouched", async () => {
  const young = await pageAged(3);
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 0 });
  const r = (await row(young.id))!;
  assert.ok(r.content);
  assert.equal(r.archive_path, null);
  assert.equal(storage.objects.size, 0);
});

test("RECREATED_PAGE_ARCHIVE_DAYS sets the default window; olderThanDays 0 archives everything", async () => {
  const p = await pageAged(3);
  process.env.RECREATED_PAGE_ARCHIVE_DAYS = "2";
  try {
    assert.deepEqual(await archiveOldPages(), { archived: 1, failed: 0 }, "window from the env");
  } finally {
    delete process.env.RECREATED_PAGE_ARCHIVE_DAYS;
  }
  assert.equal((await row(p.id))!.content, null);
  const fresh = await pageAged(0);
  assert.deepEqual(await archiveOldPages({ olderThanDays: 0 }), { archived: 1, failed: 0 }, "olderThanDays 0");
  assert.equal((await row(fresh.id))!.content, null);
});

test("when putObject throws, the content stays in the database (failed: 1)", async () => {
  const old = await pageAged(30);
  setStorageForTests({
    ...storage,
    putObject: () => Promise.reject(new Error("upload refused")),
  });
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 1 });
  const r = (await row(old.id))!;
  assert.ok(r.content);
  assert.equal(r.archive_path, null);
  assert.equal(r.archived_at, null);
  assert.deepEqual(await pages.getRecreatedPage(old.id), old.heavy);
});

test("when the read-back differs, the content is not removed", async () => {
  const old = await pageAged(30);
  setStorageForTests({
    ...storage,
    getObject: () => Promise.resolve(gzipSync("{\"html\":\"something else\"}")),
  });
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 1 });
  assert.ok((await row(old.id))!.content);
  assert.equal((await row(old.id))!.archive_path, null);
});

test("a read-back of the same length but different bytes is caught by the hash", async () => {
  const old = await pageAged(30);
  setStorageForTests({
    ...storage,
    getObject: async (bucket, path) => {
      const real = await storage.getObject(bucket, path);
      const copy = Buffer.from(real);
      copy[copy.length - 1] ^= 0xff;
      return copy;
    },
  });
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 1 });
  assert.ok((await row(old.id))!.content);
});

test("a setRecreatedPage between upload and swap wins: the row is not archived", async () => {
  const old = await pageAged(30);
  const newer: RecreatedPageHeavy = { html: "<html>edited meanwhile</html>" };
  setStorageForTests({
    ...storage,
    putObject: async (bucket, path, body) => {
      // A user edit lands while the upload is in flight (no transaction is held by the archiver).
      assert.equal(await pages.setRecreatedPage(old.id, newer), true);
      await storage.putObject(bucket, path, body);
    },
  });
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 0 });
  const r = (await row(old.id))!;
  assert.ok(r.content);
  assert.equal(r.archive_path, null);
  assert.equal(r.archived_at, null);
  assert.deepEqual(await pages.getRecreatedPage(old.id), newer);
});

test("getRecreatedPage on an archived row whose object is gone throws ArchivedPageUnavailableError", async () => {
  const old = await pageAged(30);
  await archiveOldPages();
  storage.objects.clear();
  await assert.rejects(pages.getRecreatedPage(old.id), ArchivedPageUnavailableError);
});

test("an archived page is unavailable (not a crash) when Storage is not configured", async () => {
  const old = await pageAged(30);
  await archiveOldPages();
  setStorageForTests(null); // the real client, without SUPABASE_URL
  await assert.rejects(pages.getRecreatedPage(old.id), (err: unknown) => {
    assert.ok(err instanceof ArchivedPageUnavailableError);
    assert.ok((err as Error & { cause?: unknown }).cause instanceof StorageNotConfiguredError);
    return true;
  });
});

test("setRecreatedPage on an archived page brings the content back into the database", async () => {
  const old = await pageAged(30);
  await archiveOldPages();
  assert.equal((await row(old.id))!.content, null);
  assert.equal(await pages.setRecreatedPage(old.id, { html: "<html>back</html>" }), true);
  const r = (await row(old.id))!;
  assert.ok(r.content);
  assert.equal(r.archive_path, null);
  assert.equal(r.archived_at, null);
  assert.deepEqual(await pages.getRecreatedPage(old.id), { html: "<html>back</html>" });
});

test("running archiveOldPages twice (or at the same time) archives each page once", async () => {
  const a = await pageAged(30);
  const b = await pageAged(25);
  let puts = 0;
  setStorageForTests({
    ...storage,
    putObject: async (bucket, path, body) => {
      puts += 1;
      await storage.putObject(bucket, path, body);
    },
  });
  const [x, y] = await Promise.all([archiveOldPages(), archiveOldPages()]);
  assert.equal(x.archived + y.archived, 2);
  assert.equal(x.failed + y.failed, 0);
  assert.equal(puts, 2, "each page is uploaded once");
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 0 });
  assert.deepEqual(await pages.getRecreatedPage(a.id), a.heavy);
  assert.deepEqual(await pages.getRecreatedPage(b.id), b.heavy);
});

test("a failed page is tried once per call and again on the next call", async () => {
  const old = await pageAged(30);
  let puts = 0;
  setStorageForTests({
    ...storage,
    putObject: () => {
      puts += 1;
      return Promise.reject(new Error("down"));
    },
  });
  assert.deepEqual(await archiveOldPages(), { archived: 0, failed: 1 });
  assert.equal(puts, 1);
  setStorageForTests(storage);
  assert.deepEqual(await archiveOldPages(), { archived: 1, failed: 0 });
  assert.equal((await row(old.id))!.content, null);
});

test("Storage not configured: archiveOldPages refuses with a message naming the variable", async () => {
  await pageAged(30);
  setStorageForTests(null);
  await assert.rejects(archiveOldPages(), (err: unknown) => {
    assert.ok(err instanceof StorageNotConfiguredError);
    assert.match((err as Error).message, /SUPABASE_URL/);
    return true;
  });
});

test("the scheduler does not start without Storage settings; a tick never overlaps another", async () => {
  setStorageForTests(null);
  assert.equal(startArchiveScheduler(), false);
  setStorageForTests(storage);
  await pageAged(30);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setStorageForTests({
    ...storage,
    putObject: async (bucket, path, body) => {
      await gate;
      await storage.putObject(bucket, path, body);
    },
  });
  const first = archiveTick();
  assert.equal(await archiveTick(), null, "a tick while one runs is skipped");
  release();
  assert.deepEqual(await first, { archived: 1, failed: 0 });
});

/* ── run delete cleans Storage ── */

test("deleting a run deletes its pages' archive objects", async () => {
  const a = await pageAged(30);
  const b = await pageAged(30, a.runId);
  const other = await pageAged(30);
  await archiveOldPages();
  assert.equal(storage.objects.size, 3);
  await runs.deleteHistoryRun(a.runId);
  assert.deepEqual([...storage.objects.keys()], [`${ARCHIVE_BUCKET}/${archiveObjectPath(other.id)}`]);
  assert.equal(await row(b.id), undefined);
});

test("clearing all history deletes every archive object", async () => {
  await pageAged(30);
  await pageAged(30);
  await archiveOldPages();
  assert.equal(storage.objects.size, 2);
  await runs.clearAllHistory();
  assert.equal(storage.objects.size, 0);
});

test("a run delete still succeeds when Storage is down", async () => {
  const a = await pageAged(30);
  await archiveOldPages();
  setStorageForTests({ ...storage, deleteObject: () => Promise.reject(new Error("down")) });
  assert.equal((await runs.deleteHistoryRun(a.runId)).ok, true);
  assert.equal(await row(a.id), undefined);
});

test("deleteArchivedFor ignores objects that are already gone", async () => {
  await deleteArchivedFor(["never-archived"]);
  assert.equal(storage.objects.size, 0);
});

/* ── route ── */

async function makeUser(username: string, role: "admin" | "user", orgId: string | null = null): Promise<AppUser> {
  return identity.createUser({ username, displayName: username, passwordHash: "x", role, orgId });
}

function postArchive(user: AppUser | null, body?: unknown) {
  return asUser(user, async () =>
    readJson(await archiveRoute.POST(jsonRequest("http://localhost/api/admin/archive-pages", "POST", body))),
  );
}

test("the archive route is for platform admins only", async () => {
  await makeUser("root", "admin");
  const org = await identity.createOrganization({ name: "Acme", createdByUserId: null });
  const orgAdmin = await makeUser("acme-admin", "admin", org.id);
  const plain = await makeUser("plain", "user");
  const old = await pageAged(30);

  assert.equal((await postArchive(plain)).status, 403);
  assert.equal((await postArchive(orgAdmin)).status, 403);
  assert.equal((await postArchive(null)).status, 401);
  assert.ok((await row(old.id))!.content, "nothing archived by a refused call");
});

test("a platform admin archives now; olderThanDays 0 takes every page; the call is audited", async () => {
  const root = await makeUser("root", "admin");
  const old = await pageAged(30);
  const fresh = await pageAged(1);

  const first = await postArchive(root);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { archived: 1, failed: 0 });
  assert.equal((await row(old.id))!.content, null);
  assert.ok((await row(fresh.id))!.content);

  const now = await postArchive(root, { olderThanDays: 0 });
  assert.deepEqual(now.body, { archived: 1, failed: 0 });
  assert.equal((await row(fresh.id))!.content, null);

  assert.equal((await postArchive(root, { olderThanDays: -1 })).status, 400);
  assert.equal((await postArchive(root, { olderThanDays: "soon" })).status, 400);

  const { rows } = await getDb().query<{ data: { action: string; details: Record<string, unknown> } }>(
    "select data from audit_logs where data->>'action' = 'admin.archive_pages' order by seq",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].data.details.olderThanDays, 0);
  assert.equal(rows[1].data.details.archived, 1);
});

/* ── Supabase REST client (fake fetch) ── */

type Seen = { method: string; url: string; headers: Record<string, string>; body: unknown };

async function withFetch<T>(
  handler: (req: Seen) => Response | Promise<Response>,
  fn: (seen: Seen[]) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  const seen: Seen[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const req: Seen = {
      method: init?.method ?? "GET",
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers,
      body: init?.body,
    };
    seen.push(req);
    return handler(req);
  }) as typeof fetch;
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ENV = { url: "https://proj.supabase.co", key: "service-role-secret-key" };

function rest(): StorageLike {
  return createSupabaseStorage({ url: ENV.url, serviceRoleKey: ENV.key, retryDelayMs: 1 });
}

test("REST: put creates the bucket once, uploads with upsert, and sends the key only in headers", async () => {
  await withFetch(
    (req) => {
      if (req.url.endsWith("/storage/v1/bucket/b1")) return new Response(JSON.stringify({ statusCode: "404", error: "Bucket not found" }), { status: 400 });
      return new Response("{}", { status: 200 });
    },
    async (seen) => {
      const s = rest();
      await s.putObject("b1", "a/x y.json.gz", Buffer.from("abc"));
      await s.putObject("b1", "a/z.json.gz", Buffer.from("def"));
      const urls = seen.map((r) => `${r.method} ${r.url}`);
      assert.deepEqual(urls, [
        `GET ${ENV.url}/storage/v1/bucket/b1`,
        `POST ${ENV.url}/storage/v1/bucket`,
        `POST ${ENV.url}/storage/v1/object/b1/a/x%20y.json.gz`,
        `POST ${ENV.url}/storage/v1/object/b1/a/z.json.gz`,
      ]);
      assert.deepEqual(JSON.parse(String(seen[1].body)), { id: "b1", name: "b1", public: false });
      const upload = seen[2];
      assert.equal(upload.headers.authorization, `Bearer ${ENV.key}`);
      assert.equal(upload.headers.apikey, ENV.key);
      assert.equal(upload.headers["x-upsert"], "true");
      assert.equal(upload.headers["content-type"], "application/gzip");
      for (const r of seen) assert.ok(!r.url.includes(ENV.key));
    },
  );
});

test("REST: get reads the authenticated endpoint; a missing object is StorageNotFoundError", async () => {
  await withFetch(
    (req) => {
      if (req.url.includes("/bucket/")) return new Response("{}", { status: 200 });
      if (req.url.endsWith("/there.gz")) return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      if (req.url.endsWith("/legacy.gz")) {
        return new Response(JSON.stringify({ statusCode: "404", error: "not_found", message: "Object not found" }), { status: 400 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    },
    async (seen) => {
      const s = rest();
      assert.deepEqual(await s.getObject("b1", "there.gz"), Buffer.from([1, 2, 3]));
      assert.equal(seen[0].url, `${ENV.url}/storage/v1/object/authenticated/b1/there.gz`);
      await assert.rejects(s.getObject("b1", "gone.gz"), StorageNotFoundError);
      await assert.rejects(s.getObject("b1", "legacy.gz"), StorageNotFoundError);
    },
  );
});

test("REST: 5xx and network errors are retried at most twice; 4xx is not retried", async () => {
  let n = 0;
  await withFetch(
    (req) => {
      if (req.url.includes("/bucket/")) return new Response("{}", { status: 200 });
      n += 1;
      if (req.url.endsWith("/flaky.gz")) {
        if (n === 1) throw new TypeError("fetch failed");
        if (n === 2) return new Response("busy", { status: 503 });
        return new Response(new Uint8Array([9]), { status: 200 });
      }
      if (req.url.endsWith("/down.gz")) return new Response("busy", { status: 502 });
      return new Response(JSON.stringify({ error: "denied" }), { status: 403 });
    },
    async () => {
      const s = rest();
      assert.deepEqual(await s.getObject("b1", "flaky.gz"), Buffer.from([9]));
      assert.equal(n, 3);
      n = 0;
      await assert.rejects(s.getObject("b1", "down.gz"), /502/);
      assert.equal(n, 3, "one try and two retries");
      n = 0;
      await assert.rejects(s.getObject("b1", "denied.gz"), /403/);
      assert.equal(n, 1);
    },
  );
});

test("REST: delete treats a missing object as done; list pages through and skips folders", async () => {
  await withFetch(
    async (req) => {
      if (req.method === "DELETE") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      if (req.url.endsWith("/storage/v1/object/list/b1")) {
        const body = JSON.parse(String(req.body)) as { prefix: string; offset: number; limit: number };
        assert.equal(body.prefix, "backups");
        const all = Array.from({ length: body.limit + 1 }, (_, i) => ({ name: `f${i}.gz`, id: `id${i}` }));
        const pageRows = body.offset === 0 ? all.slice(0, body.limit) : [...all.slice(body.limit), { name: "sub", id: null }];
        return new Response(JSON.stringify(pageRows), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
    async (seen) => {
      const s = rest();
      await s.deleteObject("b1", "x.gz");
      assert.equal(seen[0].url, `${ENV.url}/storage/v1/object/b1/x.gz`);
      const names = await s.list("b1", "backups");
      assert.equal(names.length, 1001);
      assert.equal(names[0], "backups/f0.gz");
      assert.ok(!names.includes("backups/sub"));
    },
  );
});

test("REST: missing settings throw a descriptive error that never shows the key", async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.key;
  try {
    const s = createSupabaseStorage();
    await assert.rejects(s.getObject("b1", "x"), (err: unknown) => {
      assert.ok(err instanceof StorageNotConfiguredError);
      assert.match((err as Error).message, /SUPABASE_URL/);
      assert.ok(!(err as Error).message.includes(ENV.key));
      return true;
    });
  } finally {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  process.env.SUPABASE_URL = ENV.url;
  try {
    await assert.rejects(createSupabaseStorage().putObject("b1", "x", Buffer.from("a")), /SUPABASE_SERVICE_ROLE_KEY/);
  } finally {
    delete process.env.SUPABASE_URL;
  }
});

test("REST: an HTTP error message carries the status, never the key", async () => {
  await withFetch(
    () => new Response(`{"message":"bad"}`, { status: 401 }),
    async () => {
      await assert.rejects(rest().deleteObject("b1", "x"), (err: unknown) => {
        assert.match((err as Error).message, /401/);
        assert.ok(!(err as Error).message.includes(ENV.key));
        return true;
      });
    },
  );
});
