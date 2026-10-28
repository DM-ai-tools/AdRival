import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("recreate-versions");
after(() => store.cleanup());

const { makeSearchProject } = await import("./helpers/factories");
const { getCompetitorsByRun, saveCompetitor, saveJob, setRecreatedPage } = await import("@/lib/db");
const { createRecreationVersion, landingPageRecordsByKey } = await import("@/lib/pipeline/landingRecreateBridge");
const { listRecreationsForUser } = await import("@/lib/data/competitors");
const { landingPageMatchKey } = await import("@/lib/pipeline/sameLandingPageAds");
import type { CompetitorRecord } from "@/lib/types";

const URL_A = "https://onlineroad.com.au/strategy-session/";

function source(runId: string, id: string, status: "completed" | "failed" = "completed"): CompetitorRecord {
  return {
    id,
    runId,
    pageId: `page-${id}`,
    pageName: "Online Road",
    country: "AU",
    platform: "facebook",
    activeAdsCount: 3,
    services: [],
    sampleAd: { adArchiveId: `ad-${id}`, title: "Free session", body: "Grow", daysRunning: 30, adLibraryUrl: "https://facebook.com/ads/library/?id=1", landingPageUrl: URL_A },
    brand: { website: "https://onlineroad.com.au" },
    pageAnalysis: { status, analyzedUrl: URL_A } as CompetitorRecord["pageAnalysis"],
    createdAt: new Date().toISOString(),
  };
}

test("creating two versions of one page keeps both", async () => {
  const job = await makeSearchProject();
  const src = source(job.id, "c-src");
  await saveCompetitor(src);
  const a = await createRecreationVersion(src);
  const b = await createRecreationVersion(src);
  assert.notEqual(a.id, b.id);
  assert.match(a.id, /^rv-[0-9a-f]{16}$/);
  assert.equal(a.runId, job.id);
  assert.equal(a.recreatedPage, null);
  assert.equal(a.recreateOnly?.variantOf, "c-src");
  assert.equal(a.recreateOnly?.fromCompetitorId, "c-src");
  assert.equal(a.recreateOnly?.matchKey, landingPageMatchKey(URL_A));
  assert.equal(a.pageAnalysis?.status, "completed");
});

test("a source whose analysis is not completed cannot be versioned", async () => {
  const job = await makeSearchProject();
  const src = source(job.id, "c-bad", "failed");
  await saveCompetitor(src);
  await assert.rejects(() => createRecreationVersion(src));
  await assert.rejects(() => createRecreationVersion({ ...src, pageAnalysis: null }));
});

test("versions do not replace the source in landingPageRecordsByKey", async () => {
  const job = await makeSearchProject();
  const src = source(job.id, "c-src2");
  await saveCompetitor(src);
  await createRecreationVersion(src);
  const byKey = await landingPageRecordsByKey(job.id);
  assert.equal(byKey.get(landingPageMatchKey(URL_A)!)?.id, "c-src2");
});

test("versions are excluded from getCompetitorsByRun", async () => {
  const job = await makeSearchProject();
  const src = source(job.id, "c-src3");
  await saveCompetitor(src);
  await createRecreationVersion(src);
  assert.deepEqual((await getCompetitorsByRun(job.id)).map((c) => c.id), ["c-src3"]);
});

test("listRecreationsForUser scopes to the owner and the space, only pages with a recreation", async () => {
  const now = new Date().toISOString();
  const base = await makeSearchProject({ ownerUserId: "u-1" });
  const inSpace = { ...(await makeSearchProject({ ownerUserId: "u-1" })), spaceId: "sp-1", updatedAt: now };
  await saveJob(inSpace);
  const other = await makeSearchProject({ ownerUserId: "u-2" });

  const mk = async (runId: string, id: string, withPage: boolean) => {
    const src = source(runId, id);
    await saveCompetitor(src);
    const v = await createRecreationVersion(src);
    if (withPage) await setRecreatedPage(v.id, { html: "<html>x</html>" });
    return v;
  };
  const noSpaceDone = await mk(base.id, "c-a", true);
  await mk(base.id, "c-a2", false);
  const spaceDone = await mk(inSpace.id, "c-b", true);
  await mk(other.id, "c-c", true);
  // A legacy source record that already holds a page is listed too.
  const legacy = source(base.id, "c-legacy");
  await saveCompetitor(legacy);
  await setRecreatedPage("c-legacy", { html: "<html>old</html>" });

  const noSpace = (await listRecreationsForUser("u-1", null)).map((c) => c.id);
  assert.ok(noSpace.includes(noSpaceDone.id));
  assert.ok(noSpace.includes("c-legacy"));
  assert.ok(!noSpace.includes(spaceDone.id), "a space's pages stay out of the no-space list");
  assert.equal(noSpace.length, 2, "queued versions without a page and other users' pages are left out");

  assert.deepEqual((await listRecreationsForUser("u-1", "sp-1")).map((c) => c.id), [spaceDone.id]);
});
