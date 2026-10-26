import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = await useTempStore("manus-google-search");

// No real provider is reached: Manus and SociaVault are faked through fetch,
// and the AI review is a local server standing in for OpenAI.
process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "5";
process.env.SOCIAVAULT_API_KEY = "test-sv";
process.env.MANUS_SEARCH = "on";
delete process.env.OPENROUTER_API_KEY;
delete process.env.FIRECRAWL_API_KEY;

/** Answers every model call with JSON that fits the review and the query expansion. */
let aiServer: Server;
const aiReady = new Promise<void>((resolve) => {
  aiServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const content = JSON.stringify({
        relevant: true,
        relevanceScore: 0.9,
        advertiserType: "service_provider",
        bodyEvidence: "Gentle family dentistry: check-ups, cleans and implants.",
        isMarketingAgency: false,
        services: ["Family dentistry"],
        reason: "Same service in the same country",
        queries: ["family dentist"],
        domains: [],
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          created: 1,
          model: "test",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  }).listen(0, "127.0.0.1", () => {
    const { port } = aiServer.address() as AddressInfo;
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
    resolve();
  });
});
after(async () => {
  aiServer?.close();
  await store.cleanup();
});

type Event = Record<string, unknown> & { id: string; type: string; timestamp: number };
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Fake Manus and SociaVault. Every Manus round: the first poll is quiet, the
 * second posts the round's lines (first round only), the third stops.
 */
function fakeProviders(realFetch: typeof fetch) {
  const events: Event[] = [];
  const manusCalls: string[] = [];
  const svCalls: Array<{ path: string; params: URLSearchParams }> = [];
  let clock = 1_000;
  let polls = 0;
  let status = "running";
  let step = 0;
  let createBody: Record<string, unknown> = {};
  const push = (type: string, data: Record<string, unknown>) => {
    clock += 1;
    events.push({ id: `e${clock}`, type, timestamp: clock, ...data });
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1") return realFetch(input as RequestInfo, init);
    if (url.hostname === "api.manus.ai") {
      const method = url.pathname.replace("/v2/", "");
      manusCalls.push(method);
      if (method === "task.create") createBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (method === "task.create" || method === "task.sendMessage") {
        step += 1;
        status = "running";
        polls = 0;
        return json({ ok: true, task_id: "S1", task_url: "https://manus.im/app/S1" });
      }
      if (method === "task.listMessages") {
        if (url.searchParams.get("verbose") === "true") {
          polls += 1;
          if (step === 1 && polls === 2) {
            push("assistant_message", {
              assistant_message: {
                content: [
                  'FOUND {"domain":"rivaldental.com.au","advertiser":"Rival Dental","ads":12,"search":"dentist","headline":"Dentist Melbourne","text":"Gentle family dentistry."}',
                  'NOADS {"domain":"teethdirectory.com.au","search":"dentist"}',
                ].join("\n"),
              },
            });
          }
          if (polls === 3) status = "stopped";
        }
        return json({ ok: true, messages: [...events].reverse().map((e) => ({ ...e, timestamp: String(e.timestamp) })) });
      }
      if (method === "task.detail") return json({ ok: true, task: { id: "S1", status, credit_usage: 120 } });
      if (method === "project.list") return json({ ok: true, data: [{ id: "P-goog", name: "Google Comp - AdRival" }] });
      if (method === "task.stop") return json({ ok: true });
      throw new Error(`unexpected Manus call ${method}`);
    }
    if (url.hostname === "api.sociavault.com") {
      svCalls.push({ path: url.pathname, params: url.searchParams });
      if (url.pathname.endsWith("/company-ads") && url.searchParams.get("domain") === "rivaldental.com.au") {
        return json({
          success: true,
          data: {
            number_of_ads_estimate: 12,
            ads: [
              {
                creativeId: "CR1",
                advertiserId: "AR1",
                advertiserName: "Rival Dental Pty Ltd",
                format: "text",
                domain: "rivaldental.com.au",
                adUrl: "https://adstransparency.google.com/advertiser/AR1/creative/CR1",
                firstShown: "2026-06-01",
                lastShown: "2026-10-10",
              },
            ],
          },
        });
      }
      if (url.pathname.endsWith("/ad-details")) {
        return json({
          success: true,
          data: {
            format: "text",
            firstShown: "2026-06-01",
            lastShown: "2026-10-10",
            variations: [
              {
                headline: "Dentist Melbourne | Book Online",
                description: "Gentle family dentistry: check-ups, cleans and implants. Book your dentist visit today.",
                destinationUrl: "https://rivaldental.com.au/book",
              },
            ],
          },
        });
      }
      return json({ success: true, data: { ads: [], results: [], advertisers: [] } });
    }
    throw new Error(`unexpected request ${url.href}`);
  }) as typeof fetch;

  return { fetchImpl: fetchImpl as typeof fetch, manusCalls, svCalls, body: () => createBody };
}

test("a Google search takes sponsored advertisers from the agent, reads their ads from SociaVault and saves the competitor", async () => {
  await aiReady;
  const realFetch = globalThis.fetch;
  const fake = fakeProviders(realFetch);
  const { manusCalls, svCalls } = fake;
  globalThis.fetch = fake.fetchImpl;
  try {
    const { runGoogleFamilySearch } = await import("../src/lib/pipeline/googleSearch");
    const { getJob, getCompetitorsByRun } = await import("../src/lib/db");
    const { makeUser } = await import("./helpers/factories");
    const { runBillable } = await import("../src/lib/accounting/run");
    const user = await makeUser({ credits: 1000 });
    const run = (fn: () => Promise<void>) =>
      runBillable({ user, operation: "search.run", projectKind: "search", projectId: null, runId: "job-google-1" }, fn);
    await run(() => runGoogleFamilySearch("job-google-1", ["dentist"], "google", {
      geo: "AU",
      businessUrl: "https://brightdental.example",
      businessProfile: {
        url: "https://brightdental.example",
        businessName: "Bright Dental",
        industry: "Dental clinic",
        description: "Family dentist.",
        offerings: ["Check-ups", "Implants"],
        competitorKeywords: ["dentist"],
        positioningSummary: "Gentle family dentistry.",
        categories: [],
        locations: [],
        analyzedAt: new Date().toISOString(),
      } as never,
    }));

    const job = (await getJob("job-google-1"))!;
    assert.equal(job.manusSearch?.taskId, "S1");
    // The agent ran first; its confirmed advertiser was fetched from SociaVault for Australia only.
    assert.equal(manusCalls.filter((m) => m !== "project.list")[0], "task.create");
    assert.equal(fake.body().project_id, "P-goog");
    assert.equal(fake.body().agent_profile, "lite");
    const rivalFetch = svCalls.find((c) => c.path.endsWith("/company-ads") && c.params.get("domain") === "rivaldental.com.au");
    assert.ok(rivalFetch, "the sponsored advertiser's ads were fetched");
    assert.equal(rivalFetch!.params.get("region"), "AU");
    // The advertiser with no ads in the Transparency Center was never sent to SociaVault.
    assert.ok(!svCalls.some((c) => c.params.get("domain") === "teethdirectory.com.au"));

    const competitors = await getCompetitorsByRun("job-google-1");
    assert.deepEqual(competitors.map((c) => c.pageName), ["Rival Dental Pty Ltd"]);
    assert.equal(competitors[0].activeAdsCount, 12);
    assert.equal(job.progress.sponsored?.withAds, 1);
    assert.equal(job.progress.sponsored?.checked, 2);
    assert.equal(job.progress.rejectReasons?.sponsoredNoAds, 1);
    // Short of 10, so the web search still ran after the agent's rounds.
    assert.ok(svCalls.some((c) => c.path.endsWith("/search-advertisers")));
    assert.equal(job.status, "partial");

    // The agent's 120 credits are in the ledger for this run, with a cost and app credits charged.
    const { queryProviderCalls } = await import("../src/lib/accounting/service");
    let manusCall = null as null | { usage: { requests?: number }; estimatedCostUsdMicros: number | null; creditsCharged: number; runId: string | null };
    for (let i = 0; i < 50 && !manusCall; i += 1) {
      manusCall = (await queryProviderCalls({ provider: "manus" })).rows[0] ?? null;
      if (!manusCall) await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(manusCall, "Manus credits were recorded");
    assert.equal(manusCall!.usage.requests, 120);
    assert.equal(manusCall!.runId, "job-google-1");
    assert.equal(manusCall!.estimatedCostUsdMicros, 600_000); // 120 × $0.005
    assert.ok(manusCall!.creditsCharged > 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a city/suburb run sends the agent at most three rounds, and a rival with no local address is taken once the search goes country-wide", async () => {
  await aiReady;
  const realFetch = globalThis.fetch;
  const fake = fakeProviders(realFetch);
  globalThis.fetch = fake.fetchImpl;
  try {
    const { runGoogleFamilySearch } = await import("../src/lib/pipeline/googleSearch");
    const { getJob, getCompetitorsByRun } = await import("../src/lib/db");
    const { makeUser } = await import("./helpers/factories");
    const { runBillable } = await import("../src/lib/accounting/run");
    const user = await makeUser({ credits: 1000 });
    const home = { label: "Richmond, Melbourne, VIC", city: "Melbourne", suburb: "Richmond", region: "Victoria", countryCode: "AU", isPrimary: true };
    await runBillable({ user, operation: "search.run", projectKind: "search", projectId: null, runId: "job-google-local" }, () =>
      runGoogleFamilySearch("job-google-local", ["dentist"], "google", {
        geo: "AU",
        geoMode: "company_locations",
        targetLocations: [home],
        businessUrl: "https://brightdental.example",
        businessProfile: {
          url: "https://brightdental.example",
          businessName: "Bright Dental",
          industry: "Dental clinic",
          description: "Family dentist.",
          offerings: ["Check-ups", "Implants"],
          competitorKeywords: ["dentist"],
          positioningSummary: "Gentle family dentistry.",
          categories: [],
          locations: [home],
          primaryMarketCountry: "AU",
          serviceArea: {
            radiusKm: 5,
            nearbyAreas: ["Cremorne", "Abbotsford"],
            widerRadiusKm: 15,
            widerAreas: ["Hawthorn", "Brunswick"],
            metro: "Melbourne",
            region: "Victoria",
          },
          analyzedAt: new Date().toISOString(),
        } as never,
      }),
    );
    // One task, at most three rounds: the first message and two follow-ups.
    assert.equal(fake.manusCalls.filter((m) => m === "task.create").length, 1);
    assert.ok(fake.manusCalls.filter((m) => m === "task.sendMessage").length <= 2);
    // No address was found for the rival, so it waited for the country-wide round and was then taken.
    assert.deepEqual((await getCompetitorsByRun("job-google-local")).map((c) => c.pageName), ["Rival Dental Pty Ltd"]);
    assert.equal((await getJob("job-google-local"))!.progress.accepted, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("by default a Google search uses the web search only, without the Manus agent", async () => {
  await aiReady;
  const realFetch = globalThis.fetch;
  const fake = fakeProviders(realFetch);
  globalThis.fetch = fake.fetchImpl;
  delete process.env.MANUS_SEARCH;
  try {
    const { runGoogleFamilySearch } = await import("../src/lib/pipeline/googleSearch");
    const { getJob } = await import("../src/lib/db");
    const { makeUser } = await import("./helpers/factories");
    const { runBillable } = await import("../src/lib/accounting/run");
    const user = await makeUser({ credits: 1000 });
    await runBillable({ user, operation: "search.run", projectKind: "search", projectId: null, runId: "job-google-web" }, () =>
      runGoogleFamilySearch("job-google-web", ["dentist"], "google", { geo: "AU" }),
    );
    assert.deepEqual(fake.manusCalls, []);
    // The web steps ran: SociaVault's Google search (Firecrawl has no key here) and the Transparency name search.
    assert.ok(fake.svCalls.some((c) => c.path.endsWith("/google/search")));
    assert.ok(fake.svCalls.some((c) => c.path.endsWith("/search-advertisers")));
    assert.equal((await getJob("job-google-web"))!.manusSearch ?? null, null);
  } finally {
    process.env.MANUS_SEARCH = "on";
    globalThis.fetch = realFetch;
  }
});
