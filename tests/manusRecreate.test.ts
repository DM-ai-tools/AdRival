import assert from "node:assert/strict";
import { after, test } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("manus-recreate");
after(() => store.cleanup());

// No real provider is reached: Manus and the file downloads are faked below,
// and with no OpenAI/OpenRouter key the question gets the default answer.
process.env.MANUS_API_KEY = "test-key";
process.env.MANUS_POLL_MS = "10";
process.env.MANUS_PROJECT_NAME = "redeisgn pipeline";
delete process.env.MANUS_PROJECT_ID;
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENAI_API_KEY;

type Event = Record<string, unknown> & { id: string; type: string; timestamp: number };

/** A small fake of the Manus task API: one task that asks a question, then delivers. */
function fakeManus() {
  const events: Event[] = [];
  const sent: Array<{ method: string; body: Record<string, unknown> }> = [];
  let clock = 1_000;
  let polls = 0;
  let stage: "build" | "asked" | "answered" | "fixing" | "delivered" | "editing" | "edited" = "build";
  const push = (type: string, data: Record<string, unknown>, id = `e${clock}`) => {
    clock += 1;
    events.push({ id, type, timestamp: clock, ...data });
  };
  // The first delivery uses one photo twice; the fixed one does not.
  const photo = `data:image/jpeg;base64,${"P".repeat(6000)}`;
  const html = (label: string, repeat = false) =>
    `<!doctype html><html><head><title>${label}</title></head><body><header><img src="hero.png" alt="Bright Dental logo"></header><h1>${label}</h1><p>Rival Clinic</p><img src="${photo}" alt="Smiling patient">${repeat ? `<section><h2>Why us</h2><img src="${photo}" alt="Smiling patient again"></section>` : ""}</body></html>`;

  const advance = () => {
    polls += 1;
    if (stage === "build" && polls >= 2) {
      push("assistant_message", {
        assistant_message: { content: "Should the hero use a photo or an illustration?", question_expectation: { options: ["Photo", "Illustration"], selection_mode: "single" } },
      }, "Q1");
      push("status_update", { status_update: { agent_status: "waiting", status_detail: { waiting_for_event_id: "Q1", waiting_for_event_type: "messageAskUser" } } });
      stage = "asked";
    } else if (stage === "answered") {
      push("assistant_message", {
        assistant_message: {
          content: "Done. [Page](/home/ubuntu/site/index.html)",
          attachments: [
            { type: "file", filename: "index.html", path: "/home/ubuntu/site/index.html", url: "https://files.test/v1/index.html", content_type: "text/html" },
            { type: "image", filename: "hero.png", path: "/home/ubuntu/site/hero.png", url: "https://files.test/hero.png", content_type: "image/png" },
          ],
        },
      });
      push("status_update", { status_update: { agent_status: "stopped" } });
      push("structured_output_result", {
        structured_output_result: {
          success: true,
          value: {
            html_filename: "index.html",
            summary: "Rebuilt all 6 sections for Bright Dental.",
            sections: [{ competitor_section: "Hero", rebuilt_as: "Hero", layout_matches: true }],
            brand: { logo_source: "brightdental.example header", colours: ["#0F7A6C"], fonts: ["Inter"] },
            verification: { desktop_compared: true, mobile_compared: true, notes: "Matched at 1440 and 390." },
            unresolved: ["Add real patient reviews."],
          },
          error: null,
        },
      });
      stage = "delivered";
    } else if (stage === "fixing") {
      push("assistant_message", {
        assistant_message: {
          content: "Replaced the repeated photo.",
          attachments: [
            { type: "file", filename: "index.html", url: "https://files.test/v1fixed/index.html", content_type: "text/html" },
            { type: "image", filename: "hero.png", path: "/home/ubuntu/site/hero.png", url: "https://files.test/hero.png", content_type: "image/png" },
          ],
        },
      });
      push("status_update", { status_update: { agent_status: "stopped" } });
      stage = "delivered";
    } else if (stage === "editing") {
      push("status_update", { status_update: { agent_status: "running" } });
      push("assistant_message", {
        assistant_message: {
          content: "Updated.",
          attachments: [{ type: "file", filename: "index.html", url: "https://files.test/v2/index.html", content_type: "text/html" }],
        },
      });
      push("status_update", { status_update: { agent_status: "stopped" } });
      stage = "edited";
    }
  };

  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "files.test") {
      if (url.pathname === "/hero.png") return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200 });
      return new Response(html(url.pathname.includes("v2") ? "Version two" : "Version one", url.pathname === "/v1/index.html"), { status: 200 });
    }
    assert.equal(url.hostname, "api.manus.ai");
    const method = url.pathname.replace("/v2/", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ method, body });
    switch (method) {
      case "task.create": {
        const content = (body.message as { content: Array<{ type: string; text?: string }> }).content;
        push("user_message", { user_message: { content: content.find((p) => p.type === "text")?.text } });
        push("status_update", { status_update: { agent_status: "running" } });
        push("plan_update", { plan_update: { steps: [{ title: "Capture the competitor page", status: "doing" }, { title: "Build the HTML", status: "todo" }] } });
        return json({ ok: true, task_id: "T1", task_url: "https://manus.im/app/T1" });
      }
      case "task.sendMessage": {
        const text = String((body.message as { content: string }).content);
        push("user_message", { user_message: { content: text } });
        if (stage === "asked") stage = "answered";
        else if (/appear more than once/.test(text)) stage = "fixing";
        else if (stage === "delivered") stage = "editing";
        return json({ ok: true });
      }
      case "task.listMessages": {
        advance();
        const limit = Number(url.searchParams.get("limit") || 50);
        // Like the real API: times come as strings.
        const page = [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
        return json({ ok: true, messages: page.map((e) => ({ ...e, timestamp: String(e.timestamp) })), has_more: false });
      }
      case "connector.list":
        return json({ ok: true, data: [{ id: "C-fc", name: "Firecrawl" }, { id: "C-sl", name: "Slack" }, { id: "C-oa", name: "OpenAI" }] });
      case "project.list":
        return json({ ok: true, data: [{ id: "P0", name: "Research" }, { id: "P1", name: "Redesign Pipeline" }] });
      case "task.detail":
        // Like the real API after a finished task: background jobs (report, suggestions) still running.
        return json({ ok: true, task: { id: "T1", status: "stopped", has_running_background_jobs: true, credit_usage: 321 } });
      case "task.stop":
        return json({ ok: true });
      default:
        throw new Error(`unexpected Manus call ${method}`);
    }
  };
  return { fetchImpl, sent, events };
}

test("the design agent builds the page, its question is answered, and a change request continues the same task", async () => {
  const fake = fakeManus();
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetchImpl as typeof fetch;
  try {
    const { saveJob, updateCompetitor, getCompetitor } = await import("../src/lib/db");
    const { makeSearchProject, makeCompetitor } = await import("./helpers/factories");
    const { runManusRecreation, editManusRecreation } = await import("../src/lib/pipeline/manus/run");

    const job = makeSearchProject({ keyword: "dentist" });
    saveJob({
      ...job,
      businessUrl: "https://brightdental.example",
      businessProfile: {
        url: "https://brightdental.example",
        businessName: "Bright Dental",
        industry: "Dental",
        description: "Family dentist.",
        offerings: ["Check-ups", "Implants"],
        competitorKeywords: ["dentist"],
        positioningSummary: "Gentle family dentistry.",
        categories: [],
        locations: [],
        analyzedAt: new Date().toISOString(),
      } as never,
    });
    const competitor = makeCompetitor({ runId: job.id, pageName: "Rival Clinic" });
    updateCompetitor(competitor.id, {
      pageAnalysis: {
        status: "completed",
        analyzedUrl: "https://rivalclinic.example/offer",
        analyzedAt: new Date().toISOString(),
        offer: { primaryOffer: "Free check-up", cta: "Book now" },
        pageArchitecture: { sections: [{ name: "Hero", purpose: "Offer", summary: "" }] },
      },
    });

    const { cleanAssets, loadAssets } = await import("../src/lib/pipeline/manus/assets");
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString("base64")}`;
    const assets = cleanAssets([
      { dataUrl: png, caption: "Q3 results stat" },
      { dataUrl: "data:image/svg+xml;base64,PHN2Zz4=", caption: "dropped: not a photo format" },
    ]);
    assert.equal(assets.length, 1);
    const built = await runManusRecreation(competitor.id, { styleDirection: "brand", assets });
    // The images are kept, so a later rebuild without new ones still uses them.
    assert.deepEqual(loadAssets(competitor.id).map((a) => [a.name, a.caption, a.dataUrl]), [["asset-1.png", "Q3 results stat", png]]);
    const page = built.recreatedPage!;
    assert.equal(page.status, "completed", page.error || "");
    assert.equal(page.pipelineVersion, "manus-1");
    assert.match(page.html || "", /Version one/);
    // The first delivery used a photo twice: it went back to the agent once, and the fixed page was kept.
    assert.equal(fake.sent.filter((s) => s.method === "task.sendMessage" && /appear more than once/.test(JSON.stringify(s.body))).length, 1);
    assert.equal((page.html || "").split("Smiling patient").length - 1, 1);
    assert.ok(!page.publishBlockers?.some((b) => /same image/.test(b)));
    // The sibling image the page referred to by a relative path is now inside the page.
    assert.match(page.html || "", /src="data:image\/png;base64,/);
    // The competitor's name was left in the page: flagged, not published as ready.
    assert.equal(page.publishReady, false);
    assert.ok(page.publishBlockers?.some((b) => /Rival Clinic/.test(b)));
    assert.ok(page.publishBlockers?.includes("Add real patient reviews."));
    assert.equal(page.manus?.creditUsage, 321);

    // The brief went as an attached file, with the task in interactive mode.
    const create = fake.sent.find((s) => s.method === "task.create")!;
    assert.equal(create.body.interactive_mode, true);
    // Created in the user's "Redesign Pipeline" project, found from the typed name.
    assert.equal(create.body.project_id, "P1");
    // Firecrawl and OpenAI connectors are switched on, nothing else.
    assert.deepEqual((create.body.message as { connectors?: string[] }).connectors, ["C-fc", "C-oa"]);
    const parts = (create.body.message as { content: Array<{ type: string; filename?: string; file_data?: string }> }).content;
    const brief = Buffer.from(String(parts.find((p) => p.filename === "brief.md")?.file_data).split(",")[1], "base64").toString("utf8");
    assert.match(brief, /https:\/\/rivalclinic\.example\/offer/);
    assert.match(brief, /Visual check before delivering/);
    // The user's image goes with the task as a file, and the brief says to use it.
    assert.ok(parts.some((p) => p.filename === "asset-1.png" && p.file_data === png));
    assert.match(brief, /Images the user supplied \(must be used\)/);
    assert.match(brief, /- asset-1\.png: Q3 results stat/);

    // The question was answered once, with the default answer (no model key here).
    assert.equal(page.manus?.questions.length, 1);
    assert.match(page.manus!.questions[0].answer, /^Choose: Photo\./);

    const edited = await editManusRecreation(competitor.id, "Make the hero darker");
    const after = edited.recreatedPage!;
    assert.equal(after.status, "completed", after.error || "");
    assert.match(after.html || "", /Version two/);
    assert.match(after.previousHtml || "", /Version one/);
    assert.equal(after.lastEdit?.request, "Make the hero darker");
    // Same task, no second task.create.
    assert.equal(fake.sent.filter((s) => s.method === "task.create").length, 1);
    assert.equal(getCompetitor(competitor.id)?.recreatedPage?.manus?.taskId, "T1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the design agent is not named to client users", async () => {
  const { maskClientFacingText } = await import("../src/lib/clientFacing");
  assert.equal(maskClientFacingText("Manus is building the page"), "design agent is building the page");
});

test("the project is found from the name as typed, and an unclear name matches nothing", async () => {
  const { matchManusProject } = await import("../src/lib/pipeline/manus/run");
  const projects = [
    { id: "P0", name: "Research" },
    { id: "P1", name: "Redesign Pipeline" },
    { id: "P2", name: "Ads audit" },
  ];
  assert.equal(matchManusProject(projects, "redeisgn pipeline")?.id, "P1");
  assert.equal(matchManusProject(projects, "Redesign  pipeline")?.id, "P1");
  assert.equal(matchManusProject(projects, "redesign")?.id, "P1");
  assert.equal(matchManusProject(projects, "landing pages"), null);
});

test("the live feed shows the agent's notes and actions, and actions are matched to stages", async () => {
  const { activityFromEvents, stageForActivity } = await import("../src/lib/pipeline/manus/run");
  const feed = activityFromEvents([
    { id: "b", type: "tool_used", timestamp: 2, tool_used: { tool: "browser", brief: "Browsing", params: { url: "https://www.rivalclinic.example/offer" } } } as never,
    { id: "a", type: "assistant_message", timestamp: 1, assistant_message: { content: "The brief is clear. I'll inspect the **competitor** page. [notes](/home/ubuntu/notes.md)" } },
    { id: "c", type: "tool_used", timestamp: 3, tool_used: { tool: "shell", brief: "Executing command", message: { action: "Executing command", param: "cat > /home/ubuntu/x.py" } } } as never,
    { id: "q", type: "assistant_message", timestamp: 4, assistant_message: { content: "Photo or illustration?", question_expectation: { options: ["Photo"] } } },
  ]);
  assert.deepEqual(
    feed.map((f) => [f.kind, f.text]),
    [
      ["note", "The brief is clear. I'll inspect the competitor page. notes"],
      ["action", "Browsing rivalclinic.example"],
      ["action", "Executing command"],
    ],
  );
  assert.equal(stageForActivity("Browsing rivalclinic.example"), "study");
  assert.equal(stageForActivity("Creating file /home/ubuntu/site/index.html"), "build");
  assert.equal(stageForActivity("Comparing my page with the competitor side by side"), "check");
});

test("the page stays on the searched service: the brief names it and a hero about something else is flagged", async () => {
  const { pageServiceFocus, buildManusBrief } = await import("../src/lib/pipeline/manus/brief");
  const { heroMissesService } = await import("../src/lib/pipeline/manus/run");
  const input = {
    competitorName: "Rival Agency",
    competitorUrl: "https://rival.example/seo",
    clientUrl: "https://trafficradius.example",
    clientName: "Traffic Radius",
    keyword: "seo agency",
    searchKeywords: ["seo agency", "seo services melbourne"],
    selectedCategory: null,
    profile: null,
    brandColors: null,
    pageAnalysis: {
      status: "completed" as const,
      analyzedUrl: "https://rival.example/seo",
      analyzedAt: "",
      offer: { headline: "Rank higher on Google with SEO that compounds", primaryOffer: "Free SEO audit", cta: "Get my free SEO audit" },
    },
    styleDirection: "brand" as const,
    userFeedback: null,
  };
  const focus = pageServiceFocus(input);
  assert.equal(focus.service, "SEO");
  assert.deepEqual(focus.families, ["seo"]);
  const brief = buildManusBrief(input);
  assert.match(brief, /This page sells \*\*SEO\*\*/);
  assert.match(brief, /Hero headline: "Rank higher on Google with SEO that compounds"/);

  const service = { label: focus.service, families: focus.families, keywords: focus.searchKeywords };
  const offTopic = `<html><body><header>Menu</header><h1>Google Ads that pay for themselves</h1><p>Book a PPC strategy call.</p></body></html>`;
  const onTopic = `<html><body><h1>Climb Google's rankings with SEO built to last</h1><p>Claim your free SEO review.</p></body></html>`;
  assert.equal(heroMissesService(offTopic, service), "SEO");
  assert.equal(heroMissesService(onTopic, service), null);
});

test("a photo used twice is caught, while the logo, icons and SVGs may repeat", async () => {
  const { repeatedImages } = await import("../src/lib/pipeline/manus/imageCheck");
  const photo = `data:image/jpeg;base64,${"A".repeat(6000)}`;
  const other = `data:image/jpeg;base64,${"B".repeat(6000)}`;
  const icon = `data:image/png;base64,${"C".repeat(200)}`;
  const page = `<html><head><style>.hero{background:url('${other}')} .site-logo{background:url(https://client.example/logo.png)} .x-logo{background:url(https://client.example/logo.png)}</style></head><body>
    <header><img class="logo" src="https://client.example/logo.png" alt="Client logo"></header>
    <section><h2>Our work</h2><img src="${photo}" alt="Team at work"><img src="${icon}" alt=""><img src="https://cdn.client.example/a.jpg?w=800" alt="Office"></section>
    <section><h2>Why us</h2><img src="${photo}" alt="Team at work again"><img src="${icon}" alt=""><img src="https://cdn.client.example/a.jpg?w=400" alt="Office small"><img src="https://client.example/badge.svg" alt=""><img src="https://client.example/badge.svg" alt=""></section>
    <footer><img src="https://client.example/logo.png" alt="Client logo"></footer>
  </body></html>`;
  const repeats = repeatedImages(page);
  assert.equal(repeats.length, 2);
  assert.ok(repeats.some((r) => r.places.some((p) => p.includes('"Team at work"') && p.includes('"Our work"'))));
  assert.ok(repeats.some((r) => r.places.some((p) => p.includes('"Office small"'))));
  assert.equal(repeatedImages(page.replace(/<section><h2>Why us[\s\S]*?<\/section>/, "")).length, 0);
});
