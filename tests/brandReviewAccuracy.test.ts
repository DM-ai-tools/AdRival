import assert from "node:assert/strict";
import test, { after } from "node:test";
import { useTempStore } from "./helpers/store";

const store = useTempStore("brand-review-accuracy");
after(() => store.cleanup());

// Imported after useTempStore so `db.ts` picks up ADRIVAL_DATA_DIR.
const { makeUser, makeSearchProject } = await import("./helpers/factories");
const { runBillable } = await import("@/lib/accounting/run");
const { runBrandReview } = await import("@/lib/pipeline/brandReview");
const { extractFacebookUrl } = await import("@/lib/pipeline/socialParams");
const { profileMatchesBrand } = await import("@/lib/pipeline/brandProfiles");

test("Facebook links keep a profile.php id and skip the Meta Pixel", () => {
  assert.equal(
    extractFacebookUrl("https://www.facebook.com/profile.php?id=61558166964441#"),
    "https://www.facebook.com/profile.php?id=61558166964441",
  );
  assert.equal(extractFacebookUrl("https://web.facebook.com/salandscapes/?ref=footer"), "https://www.facebook.com/salandscapes");
  assert.equal(extractFacebookUrl("https://www.facebook.com/tr?id=123&ev=PageView&noscript=1"), null);
  assert.equal(extractFacebookUrl("https://www.facebook.com/profile.php"), null);
  assert.equal(extractFacebookUrl("https://www.facebook.com/sharer/sharer.php?u=x"), null);
});

test("a profile is matched to the brand by its website or its name", () => {
  const brand = { name: "S&A Landscapes", website: "https://salandscapes.com.au/company" };
  assert.deepEqual(profileMatchesBrand({ names: ["S&A Landscapes"], website: null }, brand), { site: "none", name: true });
  assert.deepEqual(profileMatchesBrand({ names: ["Smith Landscapes"], website: "https://smithlandscapes.com" }, brand), { site: "other", name: false });
  assert.equal(profileMatchesBrand({ names: ["sa_landscapes"], website: "https://www.salandscapes.com.au" }, brand).site, "same");
  assert.equal(profileMatchesBrand({ names: ["Green Gardens"], website: "https://linktr.ee/greengardens" }, brand).name, false);
});

test("every platform on the site gets its real count; a searched account of another business is rejected", { timeout: 60_000 }, async () => {
  const saved = { ...process.env };
  for (const key of ["FIRECRAWL_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];
  process.env.SOCIAVAULT_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const site = `<!doctype html><html><head></head><body>
    <noscript><img src="https://www.facebook.com/tr?id=999&ev=PageView&noscript=1"></noscript>
    <header><a href="/">S&amp;A Landscapes</a></header>
    <footer><a href="https://www.facebook.com/profile.php?id=61558166964441#"><i class="fab fa-facebook"></i></a>
    <a href="https://www.instagram.com/salandscapes_/"><i class="fab fa-instagram"></i></a></footer></body></html>`;
  const calls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname.endsWith("salandscapes.com.au")) {
      return new Response(site, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.hostname === "api.sociavault.com") {
      calls.push(`${url.pathname}?${url.searchParams.toString()}`);
      const p = url.pathname;
      if (p.endsWith("/facebook/profile")) {
        const target = url.searchParams.get("url") || "";
        // The ad's numeric page id answers too; the site's profile link has the counts.
        if (!target.includes("61558166964441")) return new Response("not found", { status: 404 });
        return json({ success: true, data: { name: "S&A Landscapes", followerCount: 64, likeCount: 64, website: null, category: "Home Improvement" }, credits_used: 1 });
      }
      if (p.endsWith("/instagram/profile")) {
        return json({ success: true, data: { data: { user: { username: "salandscapes_", full_name: "S&A Landscapes", edge_followed_by: { count: 1234 }, external_url: "https://salandscapes.com.au" } } }, credits_used: 1 });
      }
      if (p.endsWith("/twitter/profile")) {
        return json({ success: true, data: { core: { name: "SA Lighting Co", screen_name: "salighting" }, legacy: { followers_count: 6455, entities: { url: { urls: [{ expanded_url: "https://salighting.com" }] } } } }, credits_used: 1 });
      }
      if (p.endsWith("/google/search")) {
        const q = url.searchParams.get("query") || "";
        if (/x\.com|twitter/.test(q)) return json({ success: true, data: { results: [{ url: "https://x.com/salighting", title: "SA Lighting" }] }, credits_used: 1 });
        return json({ success: true, data: { results: [] }, credits_used: 1 });
      }
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;

  try {
    const user = await makeUser({ credits: 1000 });
    const job = makeSearchProject({ ownerUserId: user.id });
    const brand = await runBillable(
      { user, operation: "test.brand_review", projectKind: "search", projectId: job.id, runId: job.id },
      () =>
        runBrandReview({
          pageId: "1234567890",
          pageName: "S&A Landscapes",
          websiteHint: "https://salandscapes.com.au/company",
          sourcePlatform: "facebook",
          // An earlier review stored the wrong X account; it must not come back.
          previous: { twitterHandle: "salighting", twitterFollowers: 6455 },
        }),
    );
    assert.equal(brand.facebookUrl, "https://www.facebook.com/profile.php?id=61558166964441");
    assert.equal(brand.facebookFollowers, 64);
    assert.equal(brand.instagramHandle, "salandscapes_");
    assert.equal(brand.instagramFollowers, 1234);
    assert.equal(brand.twitterHandle ?? null, null, "another business's X account is not used");
    assert.equal(brand.twitterFollowers ?? null, null);
    assert.ok(!calls.some((c) => c.includes("tr%3Fid")), "the Meta Pixel is never looked up as a page");
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});
