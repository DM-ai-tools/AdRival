import { after, describe, test } from "node:test";
import assert from "node:assert/strict";

import { getDb } from "../src/lib/data/client";
import { migrate } from "../src/lib/data/migrate";
import * as runs from "../src/lib/data/runs";
import * as competitors from "../src/lib/data/competitors";
import * as lookups from "../src/lib/data/lookups";
import * as icps from "../src/lib/data/icps";
import * as audit from "../src/lib/data/audit";
import * as identity from "../src/lib/data/identity";
import * as history from "../src/lib/data/importHistory";
import { importStore, planImport } from "../src/lib/data/importStore";
import { verifyImport } from "../src/lib/data/verifyImport";
import { restoreBackup, runBackup } from "../src/lib/data/backup";
import { createMemoryStorage, setStorageForTests } from "../src/lib/data/storageClient";
import type { CompetitorRecord, DatabaseShape, IcpRecord, LookupAdRecord, LookupJob, SearchJob } from "../src/lib/types";
import { fixtureStore, T0, T1 } from "./helpers/storeFixture";
// Aliased: the React hooks lint rule reads any use* call as a hook.
import { useTempStore as tempStore } from "./helpers/store";
import { createPgliteClient, type PgliteTestClient } from "./helpers/testDb";

/*
 * Lone UTF-16 surrogates (text cut in the middle of an emoji) and NUL in
 * scraped text. JSON.stringify writes them as "\ud83c" / "\u0000", which
 * Postgres jsonb rejects; every repository writes them as U+FFFD instead.
 * PGlite is real Postgres code, so it rejects them the same way.
 */

const FFFD = "�";
const HIGH = "\ud83c";
const LOW = "\udf89";
const AD_COPY = `Book your free consult today\n${HIGH}`;

let current: { cleanup(): Promise<void> } | null = null;

async function freshDb(label: string): Promise<void> {
  if (current) await current.cleanup();
  current = await tempStore(label);
}

after(async () => {
  setStorageForTests(null);
  if (current) await current.cleanup();
});

describe("Postgres rejects the raw escapes (the bug)", () => {
  test("a lone surrogate or NUL escape in JSON text is invalid jsonb", async () => {
    await freshDb("json-sanitize-proof");
    const job = { id: "proof", status: "completed", sampleCopy: AD_COPY };
    await assert.rejects(
      getDb().query("insert into jobs (id, status, data) values ($1, $2, $3::jsonb)", ["proof", "completed", JSON.stringify(job)]),
      /invalid input syntax for type json/,
    );
    await assert.rejects(
      getDb().query("insert into jobs (id, status, data) values ($1, $2, $3::jsonb)", [
        "proof",
        "completed",
        JSON.stringify({ ...job, sampleCopy: "a\u0000b" }),
      ]),
      /unsupported Unicode escape sequence/,
    );
  });
});

function searchJob(id: string, extra: Partial<SearchJob> = {}): SearchJob {
  return {
    id,
    keyword: id,
    keywords: [id],
    status: "completed",
    progress: { stage: "done", message: "Done" },
    competitorIds: [],
    createdAt: T0,
    updatedAt: T1,
    ...extra,
  } as unknown as SearchJob;
}

describe("repositories store lone surrogates and NUL as U+FFFD", () => {
  test("saveJob", async () => {
    await freshDb("json-sanitize-repos");
    const job = searchJob("job-s", {
      offersReport: { adCopy: { creatives: [{ sampleCopy: AD_COPY }, { sampleCopy: `x\u0000y${LOW}` }] } },
    } as unknown as Partial<SearchJob>);
    assert.equal(await runs.saveJob(job), true);
    const stored = (await runs.getJob("job-s")) as unknown as { offersReport: { adCopy: { creatives: Array<{ sampleCopy: string }> } } };
    assert.equal(stored.offersReport.adCopy.creatives[0].sampleCopy, `Book your free consult today\n${FFFD}`);
    assert.equal(stored.offersReport.adCopy.creatives[1].sampleCopy, `x${FFFD}y${FFFD}`);
  });

  test("updateJob", async () => {
    const updated = await runs.updateJob("job-s", { keyword: `kw${HIGH}` });
    assert.ok(updated);
    assert.equal((await runs.getJob("job-s"))?.keyword, `kw${FFFD}`);
  });

  test("saveCompetitor (and the job's competitorIds update)", async () => {
    const competitor = {
      id: "comp-s",
      runId: "job-s",
      pageId: "p-s",
      pageName: `Brand ${HIGH}`,
      activeAdsCount: 1,
      createdAt: T0,
      ads: [{ body: "nul\u0000here" }],
    } as unknown as CompetitorRecord;
    assert.equal(await competitors.saveCompetitor(competitor), true);
    const stored = (await competitors.getCompetitor("comp-s")) as unknown as { pageName: string; ads: Array<{ body: string }> };
    assert.equal(stored.pageName, `Brand ${FFFD}`);
    assert.equal(stored.ads[0].body, `nul${FFFD}here`);
    assert.deepEqual((await runs.getJob("job-s"))?.competitorIds, ["comp-s"]);
  });

  test("saveLookupJob and saveLookupAd", async () => {
    const lookup = {
      id: "lk-s",
      queryName: `Query ${LOW}`,
      platform: "facebook",
      status: "completed",
      progress: { stage: "done", message: "Done" },
      candidates: [],
      adIds: [],
      createdAt: T0,
      updatedAt: T1,
    } as unknown as LookupJob;
    assert.equal(await runs.saveLookupJob(lookup), true);
    assert.equal((await runs.getLookupJob("lk-s"))?.queryName, `Query ${FFFD}`);
    const ad = { id: "la-s", lookupId: "lk-s", pageId: "1", pageName: AD_COPY, platform: "facebook", createdAt: T0 } as unknown as LookupAdRecord;
    assert.equal(await lookups.saveLookupAd(ad), true);
    const stored = await lookups.getLookupAd("la-s");
    assert.equal(stored?.pageName, `Book your free consult today\n${FFFD}`);
  });

  test("upsertIcp", async () => {
    const icp = {
      id: "icp-s",
      source: { kind: "search", id: "job-s" },
      stage: "problem_aware",
      createdAt: T0,
      summary: `pain ${HIGH} and \u0000`,
    } as unknown as IcpRecord;
    await icps.upsertIcp(icp);
    assert.equal(((await icps.getIcp("icp-s")) as unknown as { summary: string }).summary, `pain ${FFFD} and ${FFFD}`);
  });

  test("recordAudit", async () => {
    const entry = await audit.recordAudit({
      actorUserId: null,
      actorUsername: `bot${HIGH}`,
      action: "test.sanitize",
      details: { note: "a\u0000b" },
    });
    const { rows } = await getDb().query<{ data: { actorUsername: string; details: { note: string } } }>(
      "select data from audit_logs where id = $1",
      [entry.id],
    );
    assert.equal(rows[0].data.actorUsername, `bot${FFFD}`);
    assert.equal(rows[0].data.details.note, `a${FFFD}b`);
  });

  test("createUser / updateUser displayName", async () => {
    const user = await identity.createUser({ username: "sanitized", displayName: `Ann ${HIGH}`, passwordHash: "x" });
    assert.equal((await identity.getUserById(user.id))?.displayName, `Ann ${FFFD}`);
    await identity.updateUser(user.id, { displayName: "Ann\u0000B" });
    assert.equal((await identity.getUserById(user.id))?.displayName, `Ann${FFFD}B`);
  });
});

/** The fixture store with broken emoji / NUL in a job, a lookup, a competitor, a user and an object key. */
function brokenStore(): DatabaseShape {
  const store = fixtureStore() as unknown as Record<string, Array<Record<string, unknown>>>;
  store.jobs[0].offersReport = {
    adCopy: { creatives: [{ sampleCopy: AD_COPY }, { sampleCopy: "fine 🎉" }, { sampleCopy: `${LOW}lead` }] },
  };
  store.lookupJobs[0].queryName = `Brand ${HIGH}`;
  store.competitors[1].pageName = "No\u0000Page Co";
  store.users[1].displayName = `alice ${HIGH}`;
  store.icps[0].tags = { [`key${HIGH}`]: true };
  return store as unknown as DatabaseShape;
}

describe("importStore and verifyImport with broken text", () => {
  test("the plan reports each changed record; the dry run needs no database", () => {
    const plan = planImport(brokenStore());
    assert.equal(plan.sanitized.values, 6);
    assert.deepEqual(plan.sanitized.records, [
      "users:u-alice",
      "jobs:job-1",
      "lookupJobs:lk-1",
      "competitors:c-2",
      "icps:icp-1",
    ]);
    const warning = plan.warnings.find((w) => w.includes("broken emoji/NUL"));
    assert.ok(warning, plan.warnings.join("\n"));
    assert.match(warning, /^6 text values contained broken emoji\/NUL characters and were stored with U\+FFFD replacement \(records: users:u-alice jobs:job-1 lookupJobs:lk-1 competitors:c-2 icps:icp-1\)$/);
  });

  test("imports, warns, verifies ok; a re-import is idempotent", async () => {
    await freshDb("json-sanitize-import");
    setStorageForTests(createMemoryStorage());
    const report = await importStore(getDb(), brokenStore());
    assert.equal(report.sanitized.values, 6);
    assert.ok(report.warnings.some((w) => w.startsWith("6 text values contained broken emoji/NUL")), report.warnings.join("\n"));

    const job = (await runs.getJob("job-1")) as unknown as { offersReport: { adCopy: { creatives: Array<{ sampleCopy: string }> } } };
    assert.deepEqual(
      job.offersReport.adCopy.creatives.map((c) => c.sampleCopy),
      [`Book your free consult today\n${FFFD}`, "fine 🎉", `${FFFD}lead`],
    );
    assert.equal((await identity.getUserById("u-alice"))?.displayName, `alice ${FFFD}`);
    assert.equal((await competitors.getCompetitor("c-2"))?.pageName, `No${FFFD}Page Co`);

    const result = await verifyImport(getDb(), brokenStore());
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.ok, true);
    assert.ok(result.sanitized.some((line) => line.includes("jobs:job-1")), result.sanitized.join("\n"));

    // The sanitized records (interrupted runs carry each import's time, so they are left out here).
    const sql = `select 'jobs' as t, id, data::text as j from jobs where id = 'job-1'
       union all select 'lookup_jobs', id, data::text from lookup_jobs where id = 'lk-1'
       union all select 'competitors', id, data::text from competitors where id = 'c-2'
       union all select 'users', id, data::text from users where id = 'u-alice'
       union all select 'icps', id, data::text from icps where id = 'icp-1'
       order by 1, 2`;
    const snapshot = await getDb().query(sql);
    assert.equal(snapshot.rows.length, 5);
    await importStore(getDb(), brokenStore());
    assert.deepEqual((await getDb().query(sql)).rows, snapshot.rows);
    assert.deepEqual((await verifyImport(getDb(), brokenStore())).mismatches, []);
  });

  test("a real difference in a sanitized record is still a mismatch", async () => {
    await getDb().query(
      `update jobs set data = jsonb_set(data, '{offersReport,adCopy,creatives,0,sampleCopy}', to_jsonb('tampered'::text))
        where id = 'job-1'`,
    );
    const result = await verifyImport(getDb(), brokenStore());
    assert.equal(result.ok, false);
    assert.ok(result.mismatches.some((m) => m.includes("jobs") && m.includes("job-1")), result.mismatches.join("\n"));
    await importStore(getDb(), brokenStore());
    assert.deepEqual((await verifyImport(getDb(), brokenStore())).mismatches, []);
  });

  test("backup and restore keep the sanitized record exactly", async () => {
    const storage = createMemoryStorage();
    const { date } = await runBackup(getDb(), storage);
    const target: PgliteTestClient = await createPgliteClient();
    try {
      await migrate(target);
      await restoreBackup(target, storage, date);
      for (const table of ["jobs", "lookup_jobs", "competitors", "users", "icps"]) {
        const sql = `select id, data::text as j from ${table} order by id`;
        assert.deepEqual((await target.query(sql)).rows, (await getDb().query(sql)).rows, table);
      }
    } finally {
      await target.close();
    }
  });
});

describe("importHistory with broken text", () => {
  test("mergeStore writes the record with U+FFFD", async () => {
    await freshDb("json-sanitize-history");
    const result = await history.mergeStore({
      jobs: [searchJob("hist-1", { keyword: `kw ${HIGH}` })],
      competitors: [
        { id: "hist-c", runId: "hist-1", pageId: "9", pageName: "a\u0000b", activeAdsCount: 1, createdAt: T0 } as unknown as CompetitorRecord,
      ],
    });
    assert.equal(result.after.jobs, 1);
    assert.equal((await runs.getJob("hist-1"))?.keyword, `kw ${FFFD}`);
    assert.equal((await competitors.getCompetitor("hist-c"))?.pageName, `a${FFFD}b`);
  });
});
