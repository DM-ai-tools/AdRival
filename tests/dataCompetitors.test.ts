import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { getDb, setClientForTests, type Queryable, type TestClient } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import { ArchivedPageUnavailableError } from "../src/lib/data/archive";
import * as competitors from "../src/lib/data/competitors";
import * as pages from "../src/lib/data/recreatedPages";
import * as lookups from "../src/lib/data/lookups";
import * as icps from "../src/lib/data/icps";
import * as runs from "../src/lib/data/runs";
import type {
  CompetitorRecord,
  IcpRecord,
  LookupAdRecord,
  LookupJob,
  RecreatedLandingPage,
  RecreatedPageHeavy,
  SearchCompetitorAdRecord,
  SearchJob,
} from "../src/lib/types";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * The shared client is wrapped in a spy that records the SQL text of every
 * statement, on the client and on every transaction handle.
 */
const statements: string[] = [];
let base: PgliteTestClient;

function spyQueryable(q: Queryable): Queryable {
  return {
    query<R = Record<string, unknown>>(text: string, params?: unknown[]) {
      statements.push(text);
      return q.query<R>(text, params);
    },
  };
}

before(async () => {
  base = await createPgliteClient();
  await migrate(base);
  const spy: TestClient = {
    ...spyQueryable(base),
    tx: (fn) => base.tx((t) => fn(spyQueryable(t))),
  };
  setClientForTests(spy);
});

after(async () => {
  setClientForTests(null);
  await base.close();
});

let seq = 0;

function makeJob(overrides: Partial<SearchJob> = {}): SearchJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `job-${seq}`,
    keyword: `keyword ${seq}`,
    keywords: [`keyword ${seq}`],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "running",
    progress: {
      stage: "searching_ads",
      scannedAds: 0,
      scannedPages: 0,
      accepted: 0,
      target: 10,
      rejected: 0,
      message: "Starting",
    },
    competitorIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeLookup(overrides: Partial<LookupJob> = {}): LookupJob {
  seq += 1;
  const at = new Date(Date.UTC(2026, 0, 2, 0, 0, seq)).toISOString();
  return {
    id: `lookup-${seq}`,
    queryName: `Brand ${seq}`,
    platform: "facebook",
    status: "running",
    progress: { stage: "fetching_ads", message: "Fetching", candidatesFound: 0, adsFetched: 0, pagesScanned: 0 },
    candidates: [],
    adIds: [],
    ownerUserId: "owner-1",
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function makeCompetitor(runId: string, overrides: Partial<CompetitorRecord> = {}): CompetitorRecord {
  seq += 1;
  return {
    id: `comp-${seq}`,
    runId,
    pageId: `page-${seq}`,
    pageName: `Competitor ${seq}`,
    country: "AU",
    platform: "facebook",
    activeAdsCount: 12,
    services: [],
    sampleAd: { adArchiveId: `ad-${seq}`, title: "t", body: "b", daysRunning: 10, adLibraryUrl: "https://x.invalid/ad" },
    brand: { website: "https://x.invalid" },
    createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, seq)).toISOString(),
    ...overrides,
  };
}

function makePage(overrides: Partial<RecreatedLandingPage> = {}): RecreatedLandingPage {
  return {
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    businessUrl: "https://client.invalid",
    keyword: "plumber",
    sourceCompetitorName: "Rival",
    sourceAnalyzedUrl: "https://rival.invalid",
    brandColors: { primary: "#000", secondary: "#111", accent: "#222", background: "#fff", text: "#000" },
    differentiationNotes: "notes",
    ...overrides,
  };
}

function makeLookupAd(lookupId: string, overrides: Partial<LookupAdRecord> = {}): LookupAdRecord {
  seq += 1;
  return {
    id: `lad-${seq}`,
    lookupId,
    adArchiveId: `arch-${seq}`,
    pageId: "p",
    pageName: "P",
    country: "AU",
    isActive: true,
    title: "t",
    body: "b",
    adLibraryUrl: "https://x.invalid",
    raw: {},
    createdAt: new Date(Date.UTC(2026, 0, 4, 0, 0, seq)).toISOString(),
    ...overrides,
  };
}

function makeSearchAd(runId: string, competitorId: string, overrides: Partial<SearchCompetitorAdRecord> = {}): SearchCompetitorAdRecord {
  seq += 1;
  return {
    id: `sad-${seq}`,
    runId,
    competitorId,
    pageId: "p",
    pageName: "P",
    platform: "facebook",
    adArchiveId: `arch-${seq}`,
    country: "AU",
    isActive: true,
    title: "t",
    body: "b",
    adLibraryUrl: "https://x.invalid",
    raw: {},
    createdAt: new Date(Date.UTC(2026, 0, 5, 0, 0, seq)).toISOString(),
    ...overrides,
  };
}

function makeIcp(id: string, sourceId: string, overrides: Partial<IcpRecord> = {}): IcpRecord {
  return {
    id,
    source: { kind: "search", id: sourceId },
    stage: "problem_aware",
    createdAt: new Date().toISOString(),
    painPoints: ["p"],
    demographics: { ageRange: null, role: null, budget: null, location: null, other: null },
    psychographics: [],
    saysOutLoud: [],
    interests: [],
    hopesAndDesires: [],
    stageNotes: "",
    suggestedAngle: "",
    ...overrides,
  };
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getDb().query<{ n: number }>(sql, params);
  return rows[0].n;
}

const TWO_MB_HTML = `<html><body>${"<p>competitor copy 0123456789</p>".repeat(64 * 1024)}</body></html>`;

/* ── (a) heavy content split ── */

test("(a) a 2 MB page is stored apart: getCompetitor is light, getRecreatedPage returns the identical html", async () => {
  const job = makeJob();
  assert.equal(await runs.saveJob(job), true);
  const heavy: RecreatedPageHeavy = {
    html: TWO_MB_HTML,
    sourceArchive: {
      html: "<html>source</html>",
      finalUrl: "https://rival.invalid",
      title: "Rival",
      capturedAt: "2026-01-01T00:00:00.000Z",
      source: "playwright",
      nodeCount: 42,
    },
    previousHtml: "<html>before</html>",
    generatedImages: [],
  };
  assert.ok(TWO_MB_HTML.length >= 2 * 1024 * 1024);
  const c = makeCompetitor(job.id, { recreatedPage: makePage() });
  assert.equal(await competitors.saveCompetitor({ ...c, recreatedPageHeavy: heavy }), true);

  const light = await competitors.getCompetitor(c.id);
  assert.ok(light?.recreatedPage);
  const page = light.recreatedPage as unknown as Record<string, unknown>;
  for (const key of ["html", "sourceArchive", "previousHtml", "generatedImages"]) {
    assert.ok(!(key in page), `light page must not carry ${key}`);
  }
  assert.equal(page.hasPage, true);
  assert.ok((page.pageBytes as number) >= TWO_MB_HTML.length);
  assert.equal(typeof page.pageUpdatedAt, "string");
  assert.equal(page.differentiationNotes, "notes");

  const rowSize = await count("select length(data::text)::int as n from competitors where id = $1", [c.id]);
  assert.ok(rowSize < 10_000, `competitor row is ${rowSize} chars`);
  const stored = await count("select octet_length(content)::int as n from recreated_pages where competitor_id = $1", [c.id]);
  assert.ok(stored > 0 && stored < TWO_MB_HTML.length / 4, `gzip content is ${stored} bytes`);

  const loaded = await pages.getRecreatedPage(c.id);
  assert.ok(loaded);
  assert.equal(loaded.html, TWO_MB_HTML);
  assert.deepEqual(loaded.sourceArchive, heavy.sourceArchive);
  assert.equal(loaded.previousHtml, "<html>before</html>");
});

test("(a) a full page passed in recreatedPage (today's callers) is split the same way", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c = makeCompetitor(job.id, { recreatedPage: makePage({ html: "<html>inline</html>" }) });
  assert.equal(await competitors.saveCompetitor(c), true);
  const light = await competitors.getCompetitor(c.id);
  assert.ok(light?.recreatedPage && !("html" in light.recreatedPage));
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<html>inline</html>");
});

test("setRecreatedPage replaces content, clears archive_path and archived_at, and updates the marker", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c = makeCompetitor(job.id, { recreatedPage: makePage({ status: "pending" }) });
  await competitors.saveCompetitor(c);
  assert.equal(await pages.getRecreatedPage(c.id), null);
  const before = await competitors.getCompetitor(c.id);
  assert.equal((before?.recreatedPage as { hasPage?: boolean }).hasPage, false);

  await getDb().query(
    "insert into recreated_pages (competitor_id, archive_path, archived_at, bytes) values ($1, 'pages/x.gz', now(), 10)",
    [c.id],
  );
  await assert.rejects(pages.getRecreatedPage(c.id), ArchivedPageUnavailableError);

  await pages.setRecreatedPage(c.id, { html: "<html>new</html>" });
  const { rows } = await getDb().query<{ archive_path: string | null; archived_at: string | null }>(
    "select archive_path, archived_at from recreated_pages where competitor_id = $1",
    [c.id],
  );
  assert.equal(rows[0].archive_path, null);
  assert.equal(rows[0].archived_at, null);
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<html>new</html>");
  const after = await competitors.getCompetitor(c.id);
  assert.equal((after?.recreatedPage as { hasPage?: boolean }).hasPage, true);
});

test("deleting a competitor removes its page row (cascade)", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c = makeCompetitor(job.id, { recreatedPage: makePage() });
  await competitors.saveCompetitor({ ...c, recreatedPageHeavy: { html: "<p>x</p>" } });
  assert.equal(await count("select count(*)::int as n from recreated_pages where competitor_id = $1", [c.id]), 1);
  await runs.deleteHistoryRun(job.id);
  assert.equal(await count("select count(*)::int as n from recreated_pages where competitor_id = $1", [c.id]), 0);
});

test("re-saving or patching a competitor without heavy fields keeps its page", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c = makeCompetitor(job.id, { recreatedPage: makePage() });
  await competitors.saveCompetitor({ ...c, recreatedPageHeavy: { html: "<p>keep</p>" } });
  const light = await competitors.getCompetitor(c.id);
  assert.ok(light?.recreatedPage);
  await competitors.updateCompetitor(c.id, { recreatedPage: { ...light.recreatedPage, status: "failed" } });
  const patched = await competitors.getCompetitor(c.id);
  assert.equal(patched?.recreatedPage?.status, "failed");
  assert.equal((patched?.recreatedPage as { hasPage?: boolean }).hasPage, true);
  assert.equal((await pages.getRecreatedPage(c.id))?.html, "<p>keep</p>");
  await competitors.updateCompetitor(c.id, { recreatedPage: null });
  assert.equal(await pages.getRecreatedPage(c.id), null);
});

/* ── (b) list and history queries never touch recreated_pages ── */

test("(b) list/history functions and updateCompetitor never reference recreated_pages", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c = makeCompetitor(job.id, { recreatedPage: makePage() });
  await competitors.saveCompetitor({ ...c, recreatedPageHeavy: { html: TWO_MB_HTML } });
  const light = await competitors.getCompetitor(c.id);
  assert.ok(light?.recreatedPage);

  statements.length = 0;
  const byRun = await competitors.getCompetitorsByRun(job.id);
  const all = await competitors.listAllCompetitors();
  const history = await runs.listHistoryRuns();
  const updated = await competitors.updateCompetitor(c.id, { pageName: "Renamed" });
  await competitors.updateCompetitor(c.id, { recreatedPage: { ...light.recreatedPage, status: "completed" } });
  await competitors.getRecreateOnlyPagesByRun(job.id);
  await competitors.getCompetitor(c.id);

  assert.ok(statements.length > 0, "the spy recorded nothing");
  const offending = statements.filter((s) => /recreated_pages/i.test(s));
  assert.deepEqual(offending, []);
  assert.equal(byRun.length, 1);
  assert.ok(all.some((x) => x.id === c.id));
  assert.ok(history.some((h) => h.id === job.id));
  assert.equal(updated?.pageName, "Renamed");
  for (const x of [...byRun, ...all]) assert.ok(!x.recreatedPage || !("html" in x.recreatedPage));
});

/* ── competitor writes and run lifecycle ── */

test("saveCompetitor adds the id to the job's competitorIds and the pageId to seen pages; recreateOnly does neither", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const found = makeCompetitor(job.id);
  const held = makeCompetitor(job.id, {
    recreateOnly: { sourceUrl: "https://lp.invalid", matchKey: "lp.invalid", fromCompetitorId: null },
  });
  assert.equal(await competitors.saveCompetitor(found), true);
  assert.equal(await competitors.saveCompetitor(held), true);
  // Saving again is an upsert, not a duplicate.
  assert.equal(await competitors.saveCompetitor({ ...found, pageName: "Again" }), true);

  const stored = await runs.getJob(job.id);
  assert.deepEqual(stored?.competitorIds, [found.id]);
  const seen = await runs.getSeenPageIds();
  assert.ok(seen.has(found.pageId));
  assert.ok(!seen.has(held.pageId));
  assert.deepEqual((await competitors.getCompetitorsByRun(job.id)).map((x) => [x.id, x.pageName]), [[found.id, "Again"]]);
  assert.deepEqual((await competitors.getRecreateOnlyPagesByRun(job.id)).map((x) => x.id), [held.id]);
  // A held page (recreateOnly is an object) is not counted as found.
  await runs.updateJob(job.id, { competitorIds: [] });
  const summary = (await runs.listHistoryRuns()).find((h) => h.id === job.id);
  assert.equal(summary?.competitorCount, 1);
  const owner = await count("select count(*)::int as n from competitors where id = $1 and owner_user_id = 'owner-1'", [found.id]);
  assert.equal(owner, 1);
});

test("saveCompetitor refuses a missing or deleted run and writes nothing", async () => {
  const missing = makeCompetitor("no-such-run");
  assert.equal(await competitors.saveCompetitor(missing), false);
  assert.equal(await competitors.getCompetitor(missing.id), null);

  const job = makeJob();
  await runs.saveJob(job);
  await runs.deleteHistoryRun(job.id);
  const late = makeCompetitor(job.id);
  assert.equal(await competitors.saveCompetitor({ ...late, recreatedPageHeavy: { html: "<p>late</p>" } }), false);
  assert.equal(await competitors.getCompetitor(late.id), null);
  assert.equal(await count("select count(*)::int as n from recreated_pages where competitor_id = $1", [late.id]), 0);
});

/* ── lookup ads ── */

test("saveLookupAds upserts ads and adds their ids to the lookup; a stopped or deleted lookup is refused", async () => {
  const lookup = makeLookup();
  await runs.saveLookupJob(lookup);
  const a = makeLookupAd(lookup.id);
  const b = makeLookupAd(lookup.id);
  assert.equal(await lookups.saveLookupAds([a, b]), true);
  assert.equal(await lookups.saveLookupAd({ ...a, title: "changed" }), true);
  assert.deepEqual((await runs.getLookupJob(lookup.id))?.adIds.sort(), [a.id, b.id].sort());
  assert.equal((await lookups.getLookupAd(a.id))?.title, "changed");
  assert.equal((await lookups.getLookupAds(lookup.id)).length, 2);

  assert.equal(await lookups.saveLookupAds([makeLookupAd("no-such-lookup")]), false);

  await runs.stopLookupJob(lookup.id);
  const late = makeLookupAd(lookup.id);
  assert.equal(await lookups.saveLookupAd(late), false);
  assert.equal(await lookups.getLookupAd(late.id), null);

  const other = makeLookup();
  await runs.saveLookupJob(other);
  await runs.deleteLookupHistoryRun(other.id);
  assert.equal(await lookups.saveLookupAd(makeLookupAd(other.id)), false);
});

test("updateLookupAd keeps the last good offer when a pending refresh arrives", async () => {
  const lookup = makeLookup();
  await runs.saveLookupJob(lookup);
  const ad = makeLookupAd(lookup.id, {
    pageAnalysis: {
      status: "completed",
      analyzedUrl: "https://lp.invalid",
      analyzedAt: "2026-01-01T00:00:00.000Z",
      offer: { primaryOffer: "50% off" },
      summary: "good",
    } as LookupAdRecord["pageAnalysis"],
  });
  await lookups.saveLookupAd(ad);
  const next = await lookups.updateLookupAd(ad.id, {
    pageAnalysis: { status: "pending", analyzedUrl: "https://lp.invalid", analyzedAt: "2026-01-02T00:00:00.000Z" },
  });
  assert.equal(next?.pageAnalysis?.status, "pending");
  assert.equal(next?.pageAnalysis?.offer?.primaryOffer, "50% off");
  assert.equal((await lookups.getLookupAd(ad.id))?.pageAnalysis?.summary, "good");
  assert.equal(await lookups.updateLookupAd("no-such-ad", { title: "x" }), null);
});

/* ── search competitor ads ── */

test("saveSearchCompetitorAds replaces one competitor's ads; a deleted run is refused", async () => {
  const job = makeJob();
  await runs.saveJob(job);
  const c1 = makeCompetitor(job.id);
  const c2 = makeCompetitor(job.id);
  const first = [makeSearchAd(job.id, c1.id), makeSearchAd(job.id, c1.id)];
  const keep = makeSearchAd(job.id, c2.id);
  assert.equal(await lookups.saveSearchCompetitorAds([...first, keep]), true);
  const replacement = makeSearchAd(job.id, c1.id);
  assert.equal(
    await lookups.saveSearchCompetitorAds([replacement], { replaceCompetitorId: c1.id, runId: job.id }),
    true,
  );
  assert.deepEqual((await lookups.getSearchCompetitorAdsByCompetitor(job.id, c1.id)).map((a) => a.id), [replacement.id]);
  assert.deepEqual((await lookups.getSearchCompetitorAdsByCompetitor(job.id, c2.id)).map((a) => a.id), [keep.id]);
  assert.equal((await lookups.getSearchCompetitorAdsByRun(job.id)).length, 2);
  assert.equal(await lookups.saveSearchCompetitorAds([]), true);
  assert.equal(await lookups.saveSearchCompetitorAd(makeSearchAd("no-such-run", "c")), false);

  await runs.deleteHistoryRun(job.id);
  const late = makeSearchAd(job.id, c1.id);
  assert.equal(await lookups.saveSearchCompetitorAd(late), false);
  assert.equal((await lookups.getSearchCompetitorAdsByRun(job.id)).length, 0);
});

/* ── (c) ICPs ── */

test("(c) upsertIcp twice with the same kind/id/stage leaves one row", async () => {
  await icps.upsertIcp(makeIcp("icp-1", "run-icp"));
  await icps.upsertIcp(makeIcp("icp-2", "run-icp", { suggestedAngle: "newer" }));
  await icps.upsertIcp(makeIcp("icp-3", "run-icp", { stage: "solution_aware" }));
  const list = await icps.getIcps("search", "run-icp");
  assert.equal(list.length, 2);
  const problem = list.filter((i) => i.stage === "problem_aware");
  assert.equal(problem.length, 1);
  assert.equal(problem[0].id, "icp-2");
  assert.equal(problem[0].suggestedAngle, "newer");
  assert.equal(await icps.getIcp("icp-1"), null);
  assert.equal((await icps.getIcp("icp-2"))?.suggestedAngle, "newer");
  // Same id again: updated in place.
  await icps.upsertIcp(makeIcp("icp-2", "run-icp", { suggestedAngle: "newest" }));
  assert.equal(
    await count("select count(*)::int as n from icps where source_id = 'run-icp' and stage = 'problem_aware'"),
    1,
  );
  assert.equal((await icps.getIcp("icp-2"))?.suggestedAngle, "newest");
});
