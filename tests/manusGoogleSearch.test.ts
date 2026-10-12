import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("manus-google-search");

// No real provider is reached: Manus and SociaVault are faked through fetch,
// and the AI review is a local server standing in for OpenAI.
process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "5";
process.env.SOCIAVAULT_API_KEY = "test-sv";
delete process.env.MANUS_SEARCH;
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
after(() => {
  aiServer?.close();
  store.cleanup();
});

type Event = Record<string, unknown> & { id: string; type: string; timestamp: number };
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

test("a Google search takes sponsored advertisers from the agent, reads their ads from SociaVault and saves the competitor", async () => {
  await aiReady;
  const events: Event[] = [];
  const manusCalls: string[] = [];
  const svCalls: Array<{ path: string; params: URLSearchParams }> = [];
  let clock = 1_000;
  let polls = 0;
  let status = "running";
  let step = 0;
  const push = (type: string, data: Record<string, unknown>) => {
    clock += 1;
    events.push({ id: `e${clock}`, type, timestamp: clock, ...data });
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1") return realFetch(input as RequestInfo, init);
    if (url.hostname === "api.manus.ai") {
      const method = url.pathname.replace("/v2/", "");
      manusCalls.push(method);
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
      if (method === "task.detail") return json({ ok: true, task: { id: "S1", status } });
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

    const job = getJob("job-google-1")!;
    assert.equal(job.manusSearch?.taskId, "S1");
    // The agent ran first; its confirmed advertiser was fetched from SociaVault for Australia only.
    assert.equal(manusCalls[0], "task.create");
    const rivalFetch = svCalls.find((c) => c.path.endsWith("/company-ads") && c.params.get("domain") === "rivaldental.com.au");
    assert.ok(rivalFetch, "the sponsored advertiser's ads were fetched");
    assert.equal(rivalFetch!.params.get("region"), "AU");
    // The advertiser with no ads in the Transparency Center was never sent to SociaVault.
    assert.ok(!svCalls.some((c) => c.params.get("domain") === "teethdirectory.com.au"));

    const competitors = getCompetitorsByRun("job-google-1");
    assert.deepEqual(competitors.map((c) => c.pageName), ["Rival Dental Pty Ltd"]);
    assert.equal(competitors[0].activeAdsCount, 12);
    assert.equal(job.progress.sponsored?.withAds, 1);
    assert.equal(job.progress.sponsored?.checked, 2);
    assert.equal(job.progress.rejectReasons?.sponsoredNoAds, 1);
    // Short of 10, so the web search still ran after the agent's rounds.
    assert.ok(svCalls.some((c) => c.path.endsWith("/search-advertisers")));
    assert.equal(job.status, "partial");
  } finally {
    globalThis.fetch = realFetch;
  }
});
