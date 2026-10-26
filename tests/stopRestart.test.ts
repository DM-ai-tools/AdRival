import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("stop-restart");
after(() => store.cleanup());

test("a stopped lookup can run its offers report again once the flag is cleared", async () => {
  const {
    clearLookupJobSuppression,
    isLookupJobSuppressed,
    saveLookupJob,
    stopLookupJob,
  } = await import("../src/lib/db");

  const id = `lookup-restart-${Date.now()}`;
  const now = new Date().toISOString();
  await saveLookupJob({
    id,
    queryName: "Echelonn",
    platform: "facebook",
    status: "running",
    progress: {
      stage: "analyzing_offers",
      message: "Analyzing offers…",
      candidatesFound: 1,
      adsFetched: 10,
      pagesScanned: 3,
    },
    candidates: [],
    adIds: ["ad-1"],
    createdAt: now,
    updatedAt: now,
  });

  await stopLookupJob(id, "Stopped by user");
  assert.equal(await isLookupJobSuppressed(id), true);

  const cleared = await clearLookupJobSuppression(id);
  assert.equal(cleared?.progress.stopRequested, false);
  assert.equal(await isLookupJobSuppressed(id), false);
  // Pipeline saves are accepted again.
  assert.equal(
    await saveLookupJob({ ...cleared!, progress: { ...cleared!.progress, stage: "analyzing_offers" } }),
    true,
  );
});

test("a stopped search can run its offers report again once the flag is cleared", async () => {
  const { clearSearchJobSuppression, isSearchJobSuppressed, saveJob, stopSearchJob, getJob } =
    await import("../src/lib/db");

  const id = `search-restart-${Date.now()}`;
  const now = new Date().toISOString();
  await saveJob({
    id,
    keyword: "teeth whitening",
    keywords: ["teeth whitening"],
    platform: "facebook",
    geo: "AU",
    countries: ["AU"],
    status: "completed",
    progress: {
      stage: "analyzing_offers",
      scannedAds: 10,
      scannedPages: 2,
      accepted: 1,
      target: 10,
      rejected: 0,
      message: "Analyzing offers…",
    },
    competitorIds: ["c-1"],
    createdAt: now,
    updatedAt: now,
  } as Parameters<typeof saveJob>[0]);

  await stopSearchJob(id, "Stopped by user");
  assert.equal(await isSearchJobSuppressed(id), true);

  await clearSearchJobSuppression(id);
  assert.equal(await isSearchJobSuppressed(id), false);
  const job = (await getJob(id))!;
  assert.equal(
    await saveJob({ ...job, progress: { ...job.progress, stage: "analyzing_offers" } }),
    true,
  );
});
