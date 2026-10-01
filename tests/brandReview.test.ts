import assert from "node:assert/strict";
import { test } from "node:test";
import { pointsElsewhere, runBrandReview } from "../src/lib/pipeline/brandReview";

test("a searched-for profile that names another business's website is rejected", () => {
  assert.equal(pointsElsewhere("https://otherbrand.com.au", "https://onlineroad.com.au/strategy-session"), true);
  assert.equal(pointsElsewhere("https://www.onlineroad.com.au/", "https://onlineroad.com.au/strategy-session"), false);
  assert.equal(pointsElsewhere("https://linktr.ee/onlineroad", "https://onlineroad.com.au"), false, "link-in-bio pages are not proof");
  assert.equal(pointsElsewhere(null, "https://onlineroad.com.au"), false);
});

test("without Firecrawl or SociaVault the site is read directly, and unsearched platforms are 'not checked'", async () => {
  const saved = { ...process.env };
  for (const key of ["FIRECRAWL_API_KEY", "SOCIAVAULT_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) delete process.env[key];
  const realFetch = globalThis.fetch;
  const html = `<!doctype html><html><body><header><a href="/">Acme</a></header><main><h1>Acme Plumbing</h1></main>
    <footer><a href="https://www.instagram.com/acme_plumbing_au/">Instagram</a>
    <a href="https://www.linkedin.com/company/acme-plumbing-au">LinkedIn</a></footer></body></html>`;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://acmeplumbing.com.au")) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const brand = await runBrandReview({
      pageId: "123456789",
      pageName: "Acme Plumbing",
      websiteHint: "https://acmeplumbing.com.au/emergency",
      sourcePlatform: "facebook",
    });
    assert.equal(brand.instagramHandle, "acme_plumbing_au", "found in the site footer without Firecrawl");
    assert.match(brand.linkedinUrl || "", /linkedin\.com\/company\/acme-plumbing-au/);
    assert.ok(brand.facebookUrl, "the ad's Facebook page is known");
    assert.deepEqual(brand.uncheckedPlatforms, ["twitter", "youtube"], "search could not run, so these are not checked rather than absent");
    assert.ok((brand.lookupIssues || []).includes("Firecrawl is not configured"));
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});
