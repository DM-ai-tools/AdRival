import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("edit-page");
after(() => store.cleanup());

// Imported after useTempStore so `db.ts` picks up ADRIVAL_DATA_DIR.
const { makeUser, makeSearchProject } = await import("./helpers/factories");
const { getCompetitor, saveCompetitor } = await import("@/lib/db");
const { runBillable } = await import("@/lib/accounting/run");
const { editRecreatedPage, undoLastEdit, pageOutline } = await import("@/lib/pipeline/unified/editPage");
const { restoreSlotImages, hasBrokenImages } = await import("@/lib/pipeline/unified/integrity");

const PHOTO = `data:image/png;base64,${"iVBORw0KGgo".padEnd(400, "A")}`;
const PHOTO2 = `data:image/png;base64,${"iVBORw0KGgoTWO".padEnd(400, "C")}`;
const LOGO = `data:image/png;base64,${"iVBORw0KGgoLOGO".padEnd(300, "B")}`;

function page(heroImgSrc: string) {
  return `<!DOCTYPE html><html><head><style>body{margin:0;font-family:sans-serif}.adr-section{padding:60px 20px}</style></head><body>
<header class="adr-header"><a class="adr-brand" href="#"><img data-logo-role="company" src="${LOGO}" alt="Tesla Elevators logo"></a></header>
<main id="adr-sections">
<section class="adr-section adr-section--dark" data-section-id="sec-1" id="sec-1"><img data-adrival-slot="img-sec-1" src="${heroImgSrc}" alt="Home lift"><h1 style="color:#fff">Home lifts across Victoria</h1><p>Designed, installed and maintained.</p></section>
<section class="adr-section" data-section-id="sec-2" id="sec-2"><h2>Why choose us</h2><p>Local engineers, fast service.</p></section>
</main>
<footer class="adr-footer">Footer</footer></body></html>`;
}

test("broken image slots get their generated image back; stray tokens are removed", () => {
  const html = page("adr-asset://0").replace("</main>", `<div style="background:url('adr-asset://3')"></div></main>`);
  assert.equal(hasBrokenImages(html), true);
  const out = restoreSlotImages(html, [{ id: "img-sec-1", publicUrl: PHOTO } as never], { primary: "#3BA9F0" });
  assert.deepEqual(out.fixed, ["img-sec-1"]);
  assert.ok(out.html.includes(`src="${PHOTO}"`));
  assert.ok(!out.html.includes("adr-asset://"));
  assert.equal(hasBrokenImages(out.html), false);
  // A slot with no generated image gets a placeholder rather than a broken image.
  const none = restoreSlotImages(page(""), [], { primary: "#3BA9F0" });
  assert.match(none.html, /data-adrival-slot="img-sec-1" src="data:image\/svg\+xml;base64,/);
});

test("every broken image in the page body is repaired, not only marked slots", () => {
  const gif = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
  const fakePng = `data:image/png;base64,${Buffer.from("not really a png".repeat(30)).toString("base64")}`;
  const html = `<html><head></head><body><header><img data-logo-role="company" src="${LOGO}"></header><main>
    <section data-section-id="sec-1"><img class="hero-bg" src="${gif}" alt="Home lift"></section>
    <section data-section-id="sec-2"><img src="${fakePng}" alt="Lift cabin"></section>
    <section data-section-id="sec-3"><img data-adrival-slot="img-sec-3" src="${PHOTO2}" srcset="adr-asset://2 2x" alt="x"></section>
    <section data-section-id="sec-4"><img src="https://cdn.example.com/lift.jpg" alt="Remote"></section>
  </main></body></html>`;
  assert.equal(hasBrokenImages(html), true);
  const remote = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 1)]).toString("base64")}`;
  const out = restoreSlotImages(html, [{ id: "img-sec-1", publicUrl: PHOTO } as never], { primary: "#3BA9F0" }, new Map([["https://cdn.example.com/lift.jpg", remote]]));
  // The hero's unmarked stand-in gets the generated image that was not on the page.
  assert.match(out.html, new RegExp(`<img class="hero-bg" src="${PHOTO.slice(0, 40)}[^"]*"[^>]*data-adrival-slot="img-sec-1"|<img data-adrival-slot="img-sec-1" class="hero-bg" src="${PHOTO.slice(0, 40)}`));
  // An image whose data does not decode becomes a marked placeholder.
  assert.match(out.html, /data-adrival-slot="img-fix-1"[^>]*|src="data:image\/svg\+xml;base64,[^"]+"[^>]*alt="Lift cabin"/);
  assert.ok(!out.html.includes("srcset="), "a broken srcset is dropped");
  assert.ok(out.html.includes(remote), "a remote image that loads is embedded");
  assert.ok(out.html.includes(LOGO), "the logo is left alone");
  assert.equal(hasBrokenImages(out.html), false);
});

test("the planner sees each part of the page", () => {
  const outline = pageOutline(page(PHOTO));
  assert.deepEqual(outline.map((p) => p.id), ["header", "sec-1", "sec-2", "footer"]);
  assert.equal(outline[1].heading, "Home lifts across Victoria");
  assert.equal(outline[0].heading, "logo, menu and button");
});

/** Anthropic's streaming reply (server-sent events) carrying one text answer. */
function sse(text: string): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 50 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a requested change rewrites only its section, keeps images and logo, and can be undone", { timeout: 180_000 }, async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-test";
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("api.anthropic.com")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body || (input instanceof Request ? await input.text() : "{}")));
    asked.push(body.stream ? "rewrite" : "plan");
    if (!body.stream) {
      const plan = { scope: "targeted", edits: [{ target: "sec-1", instruction: "Make the hero headline dark (#111111) so it is readable." }], reply: "The hero headline becomes dark." };
      return new Response(
        JSON.stringify({ id: "msg_p", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text: JSON.stringify(plan) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // The model sees the hero with its image as a short token and returns it unchanged.
    const sent = JSON.stringify(body.messages);
    assert.ok(sent.includes("adr-asset://0"), "the image is held out of the request");
    assert.ok(!sent.includes(PHOTO.slice(30, 80)), "the base64 photo is not sent");
    const html = `<section class="adr-section adr-section--dark" data-section-id="sec-1"><img data-adrival-slot="img-sec-1" src="adr-asset://0" alt="Home lift"><h1 style="color:#111111">Home lifts across Victoria</h1><p>Designed, installed and maintained.</p></section>`;
    return sse(JSON.stringify({ html }));
  }) as typeof fetch;

  try {
    const user = await makeUser({ credits: 1000 });
    const job = makeSearchProject({ ownerUserId: user.id });
    const before = page("adr-asset://0");
    saveCompetitor({
      id: "c-edit",
      runId: job.id,
      pageId: "p-edit",
      pageName: "Rival Lifts",
      country: "AU",
      activeAdsCount: 3,
      services: [],
      sampleAd: { adArchiveId: "1", title: "", body: "", daysRunning: 10, adLibraryUrl: "" },
      brand: {},
      createdAt: new Date().toISOString(),
      recreatedPage: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "completed",
        html: before,
        brandColors: { primary: "#3BA9F0", secondary: "#0B3B5C", accent: "#3BA9F0", background: "#FFFFFF", text: "#111111" },
        generatedImages: [{ id: "img-sec-1", publicUrl: PHOTO, slotState: "ready" }],
      } as never,
    });

    const outcome = await runBillable(
      { user, operation: "test.edit_page", projectKind: "search", projectId: job.id, runId: job.id },
      () => editRecreatedPage("c-edit", "The headline text colour is not visible, make it readable."),
    );
    assert.equal(outcome.full, false);
    assert.deepEqual(asked, ["plan", "rewrite"]);
    const after = getCompetitor("c-edit")!.recreatedPage!;
    assert.equal(after.status, "completed");
    assert.match(after.html!, /<h1 style="color:#111111">Home lifts across Victoria<\/h1>/);
    assert.ok(after.html!.includes(`src="${PHOTO}"`), "the hero photo is embedded");
    assert.ok(!after.html!.includes("adr-asset://"));
    assert.ok(after.html!.includes(LOGO), "the logo is kept");
    assert.ok(after.html!.includes("<h2>Why choose us</h2><p>Local engineers, fast service.</p>"), "the other section is untouched");
    assert.deepEqual(after.lastEdit?.changed, ["sec-1"]);
    assert.ok(after.lastEdit?.repaired.length, "the broken image is reported as repaired");
    assert.equal(after.previousHtml, before);

    const undone = undoLastEdit("c-edit").recreatedPage!;
    assert.equal(undone.html, before);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});
