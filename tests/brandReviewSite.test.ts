import assert from "node:assert/strict";
import { test } from "node:test";
import { collectSocialHrefsFromWebsite, newLookup, scrapeUrlCandidates } from "../src/lib/pipeline/brandReview";
import { socialLinksToSociavaultParams } from "../src/lib/pipeline/socialParams";

test("an ad on a campaign subdomain still reads the brand's main site, right after the landing page", () => {
  const pages = scrapeUrlCandidates("https://enquire.arcadiafs.com.au/about-us");
  assert.equal(pages[0], "https://enquire.arcadiafs.com.au/about-us");
  assert.equal(pages[1], "https://arcadiafs.com.au");
  assert.ok(pages.indexOf("https://arcadiafs.com.au/contact") < pages.indexOf("https://enquire.arcadiafs.com.au"));
  assert.ok(pages.length <= 8);
});

test("social links come from the main site's footer when the ad's landing page is gone (Arcadia Finance Solutions)", async () => {
  delete process.env.FIRECRAWL_API_KEY;
  const footer = `<html><body><footer>
    <a href="https://www.facebook.com/tr?id=393055733374797&ev=PageView&noscript=1"></a>
    <a class="footer-bottom-social-link" href="https://www.facebook.com/arcadiafs" aria-label="Facebook"></a>
    <a class="footer-bottom-social-link" href="https://www.instagram.com/arcadia_finance_solutions" aria-label="Instagram"></a>
    <a class="footer-bottom-social-link" href="https://au.linkedin.com/company/arcadia-finance-solutions" aria-label="LinkedIn"><span class="custom-icon i-linkedin"></span></a>
  </footer></body></html>`;
  const requested: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    if (url === "https://arcadiafs.com.au") {
      // The bare domain redirects to www and has the footer.
      const res = new Response(footer, { status: 200, headers: { "content-type": "text/html" } });
      Object.defineProperty(res, "url", { value: "https://www.arcadiafs.com.au/" });
      return res;
    }
    if (url.startsWith("https://enquire.arcadiafs.com.au") && url !== "https://enquire.arcadiafs.com.au") {
      return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    }
    return new Response("<html><body>No links here</body></html>", { status: 200, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  try {
    const result = await collectSocialHrefsFromWebsite("https://enquire.arcadiafs.com.au/about-us", newLookup());
    const params = socialLinksToSociavaultParams(result.hrefs);
    assert.ok(params.facebook && /arcadiafs/.test(JSON.stringify(params.facebook)));
    assert.ok(params.instagram && /arcadia_finance_solutions/.test(JSON.stringify(params.instagram)));
    assert.ok(params.linkedin && /company\/arcadia-finance-solutions/.test(JSON.stringify(params.linkedin)));
    // The 404 landing page is not the brand's website: its main site is.
    assert.match(result.canonicalWebsite || "", /^https:\/\/www\.arcadiafs\.com\.au\/?$/);
    // The main site was read second, before the campaign subdomain's pages.
    assert.equal(requested[1], "https://arcadiafs.com.au");
  } finally {
    globalThis.fetch = realFetch;
  }
});
