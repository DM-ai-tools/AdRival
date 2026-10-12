import assert from "node:assert/strict";
import { test } from "node:test";

// No real provider is reached: the Manus API is faked below.
process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "5";
process.env.MANUS_SEARCH = "on";

type Event = Record<string, unknown> & { id: string; type: string; timestamp: number };

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A fake Manus task that reads sponsored results: the first step posts two
 * advertisers while running and a third only in its final list; the second
 * step (a follow-up message) posts one more and then keeps working until the
 * run says stop.
 */
function fakeManus() {
  const events: Event[] = [];
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  let clock = 1_000;
  let polls = 0;
  let status: "running" | "stopped" | "waiting" = "running";
  let step = 0;
  const push = (type: string, data: Record<string, unknown>, id = `e${clock}`) => {
    clock += 1;
    events.push({ id, type, timestamp: clock, ...data });
  };
  const advance = () => {
    polls += 1;
    if (step === 1 && polls === 2) {
      push("tool_used", { tool_used: { tool: "browser", brief: "Browsing", params: { url: "https://www.google.com.au/search?q=dentist" } } });
      push("assistant_message", {
        assistant_message: {
          content: [
            "Checked the first two sponsored advertisers:",
            '- FOUND {"domain":"https://www.smiledental.com.au/book","advertiser":"Smile Dental Pty Ltd","ads":14,"search":"dentist","headline":"Dentist Pakenham | Book Online","text":"Gentle family dentistry. Book today."}',
            '- NOADS {"domain":"healthdirectory.com.au","search":"dentist"}',
            "FOUND {not json}",
          ].join("\n"),
        },
      });
    } else if (step === 1 && polls === 4) {
      push("assistant_message", { assistant_message: { content: "All searches done." } });
      push("status_update", { status_update: { agent_status: "stopped" } });
      status = "stopped";
    } else if (step === 1 && polls === 5) {
      push("structured_output_result", {
        structured_output_result: {
          success: true,
          value: {
            blocked_by_google: false,
            advertisers: [
              { domain: "smiledental.com.au", advertiser: "Smile Dental", has_ads: true, ads: 14, search: "dentist", headline: null, text: null },
              { domain: "brightteeth.com.au", advertiser: "Bright Teeth", has_ads: true, ads: null, search: "dentist near me", headline: "Bright Teeth", text: null },
            ],
          },
          error: null,
        },
      });
    } else if (step === 2 && polls === 7) {
      push("assistant_message", {
        assistant_message: { content: 'FOUND {"domain":"casey-dental.com.au","advertiser":"Casey Dental","ads":"~30","search":"dentist Narre Warren","headline":null,"text":null}' },
      });
    }
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    assert.equal(url.hostname, "api.manus.ai");
    const method = url.pathname.replace("/v2/", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ method, body });
    switch (method) {
      case "task.create":
        step = 1;
        push("user_message", { user_message: { content: (body.message as { content: string }).content } });
        return json({ ok: true, task_id: "S1", task_url: "https://manus.im/app/S1" });
      case "task.sendMessage":
        step = 2;
        status = "running";
        push("user_message", { user_message: { content: (body.message as { content: string }).content } });
        return json({ ok: true });
      case "task.listMessages": {
        if (url.searchParams.get("verbose") === "true") advance();
        const limit = Number(url.searchParams.get("limit") || 50);
        const page = [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
        return json({ ok: true, messages: page.map((e) => ({ ...e, timestamp: String(e.timestamp) })), has_more: false });
      }
      case "task.detail":
        return json({ ok: true, task: { id: "S1", status } });
      case "project.list":
        return json({ ok: true, data: [{ id: "P-red", name: "Redesign Pipeline" }, { id: "P-goog", name: "Google Comp - AdRival" }] });
      case "task.stop":
        status = "stopped";
        return json({ ok: true });
      default:
        throw new Error(`unexpected Manus call ${method}`);
    }
  };
  return { fetchImpl, sent };
}

test("sponsored lines are read from the agent's messages, bad lines skipped", async () => {
  const { parseSponsoredLines, normalizeDomain } = await import("../src/lib/pipeline/manusSearch");
  const finds = parseSponsoredLines(
    [
      "```",
      'FOUND {"domain":"www.Acme.com.au/","advertiser":"Acme","ads":3,"search":"plumber","headline":"Plumber | 24/7","text":"Fast"}',
      "```",
      '* NOADS: {"domain":"quotes.example","search":"plumber"}',
      'FOUND {"domain":"not a domain","search":"x"}',
      "FOUND {broken",
    ].join("\n"),
  );
  assert.deepEqual(
    finds.map((f) => [f.domain, f.hasAds, f.adsCount, f.headline]),
    [
      ["acme.com.au", true, 3, "Plumber | 24/7"],
      ["quotes.example", false, null, null],
    ],
  );
  assert.equal(normalizeDomain("HTTPS://www.Example.co.uk/path?q=1"), "example.co.uk");
});

test("the brief opens Google in the run's country and checks the Transparency Center there", async () => {
  const { buildSponsoredMessage } = await import("../src/lib/pipeline/manusSearch");
  const first = buildSponsoredMessage(
    { country: "AU", platform: "youtube", industry: "Dental clinic" },
    { queries: ["dentist pakenham"], skipDomains: ["brightdental.example"] },
    true,
  );
  assert.match(first, /https:\/\/www\.google\.com\.au\/search\?q=dentist\+pakenham&gl=au&hl=en&pws=0/);
  assert.match(first, /adstransparency\.google\.com\/\?region=AU&domain=<domain>&platform=YOUTUBE/);
  // Competitors come from anywhere on the page, not only ads.
  assert.match(first, /ads, the normal results, and the Maps \/ local pack/);
  assert.doesNotMatch(first, /Read only the results labelled "Sponsored"/);
  assert.match(first, /brightdental\.example/);
  assert.match(first, /FOUND \{"domain"/);
  const more = buildSponsoredMessage(
    { country: "GB", platform: "google" },
    { queries: ["plumber"], skipDomains: [], morePages: true },
    false,
  );
  assert.match(more, /www\.google\.co\.uk\/search\?q=plumber&gl=gb&hl=en&pws=0&start=10/);
  assert.match(more, /region GB/);
  assert.match(more, /More places/);
});

test("finds stream in while the agent works, a follow-up step reuses the task, and stop ends it", async () => {
  const fake = fakeManus();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl as typeof fetch;
  try {
    const { SponsoredSearchAgent } = await import("../src/lib/pipeline/manusSearch");
    let stopped = false;
    const activity: string[] = [];
    const tasks: string[] = [];
    const agent = new SponsoredSearchAgent(
      { title: "Google sponsored search: dentist (AU)", country: "AU", platform: "google", industry: "Dental" },
      { isStopped: () => stopped, onActivity: (t) => activity.push(t), onTask: (t) => tasks.push(t.taskId) },
    );

    const batches: string[][] = [];
    const first = await agent.runStep({ queries: ["dentist", "dentist near me"], skipDomains: ["brightdental.example"] }, async (finds) => {
      batches.push(finds.map((f) => `${f.domain}:${f.hasAds ? "ads" : "none"}`));
    });
    assert.equal(first.outcome, "finished");
    assert.deepEqual(tasks, ["S1"]);
    // The lines came first (while running); the final list only added what was new.
    assert.deepEqual(batches, [["smiledental.com.au:ads", "healthdirectory.com.au:none"], ["brightteeth.com.au:ads"]]);
    assert.ok(activity.some((a) => /google\.com\.au/.test(a)));
    const create = fake.sent.find((s) => s.method === "task.create")!.body;
    assert.equal(create.agent_profile, "lite");
    assert.equal(create.interactive_mode, false);
    // Search tasks go into the "Google Comp - AdRival" folder.
    assert.equal(create.project_id, "P-goog");
    assert.ok(create.structured_output_schema);

    // Next ring: a follow-up message to the same task; the run fills up and says stop.
    const second = await agent.runStep({ queries: ["dentist Narre Warren"], skipDomains: [] }, async (finds) => {
      batches.push(finds.map((f) => f.domain));
      stopped = true;
    });
    assert.equal(second.outcome, "stopped");
    assert.deepEqual(batches[2], ["casey-dental.com.au"]);
    assert.equal(fake.sent.filter((s) => s.method === "task.create").length, 1);
    assert.equal(fake.sent.filter((s) => s.method === "task.sendMessage").length, 1);
    assert.ok(fake.sent.some((s) => s.method === "task.stop"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed task start is reported so the web search can take over", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error: { code: "insufficient_credits", message: "Not enough credits" } }), { status: 402 })) as typeof fetch;
  try {
    const { SponsoredSearchAgent } = await import("../src/lib/pipeline/manusSearch");
    const agent = new SponsoredSearchAgent({ title: "t", country: "AU", platform: "google" }, { isStopped: () => false });
    const result = await agent.runStep({ queries: ["dentist"], skipDomains: [] }, async () => undefined);
    assert.equal(result.outcome, "failed");
    assert.match(result.reason || "", /credits/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a run sends the agent at most three rounds: nearer rings, wider rings with the country, then find more", async () => {
  const { groupIntoRounds, interleaveQueries } = await import("../src/lib/pipeline/manusSearch");
  const step = (label: string, level: number | null) => ({ label, level });
  const local = [step("nearby", 0), step("wider", 1), step("outer", 2), step("state", 3), step("country", null), step("more", null)];
  assert.deepEqual(
    groupIntoRounds(local).map((r) => r.map((s) => s.label)),
    [["nearby", "wider"], ["outer", "state", "country"], ["more"]],
  );
  assert.deepEqual(
    groupIntoRounds([step("country", null), step("more", null)]).map((r) => r.map((s) => s.label)),
    [["country"], ["more"]],
  );
  assert.deepEqual(
    groupIntoRounds([step("nearby", 0), step("country", null), step("more", null)]).map((r) => r.map((s) => s.label)),
    [["nearby"], ["country"], ["more"]],
  );
  for (const n of [1, 2, 5, 8]) {
    const many = [...Array.from({ length: n }, (_, i) => step(`ring${i}`, i)), step("country", null), step("more", null)];
    const rounds = groupIntoRounds(many);
    assert.ok(rounds.length <= 3);
    assert.equal(rounds.flat().length, many.length);
  }
  // Each ring gets some of the round's six searches.
  assert.deepEqual(
    interleaveQueries([
      ["skate shop Ivanhoe", "skate shop Footscray", "skate shop Essendon", "skate shop Kew"],
      ["skate shop Melbourne", "skate shop Ivanhoe", "roller skates Melbourne"],
    ]),
    ["skate shop Ivanhoe", "skate shop Melbourne", "skate shop Footscray", "skate shop Essendon", "roller skates Melbourne", "skate shop Kew"],
  );
});
