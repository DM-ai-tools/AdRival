import assert from "node:assert/strict";
import { test } from "node:test";

// No provider is reached: every balance and cost endpoint is faked below.
test("every provider gets a balance or spend row, read from its own endpoint", async () => {
  const env = {
    SOCIAVAULT_API_KEY: "sv",
    OPENROUTER_API_KEY: "or",
    OPENAI_ADMIN_KEY: "oa-admin",
    ANTHROPIC_ADMIN_KEY: "an-admin",
    FIRECRAWL_API_KEY: "fc",
    BRANDFETCH_API_KEY: "bf",
    MANUS_API_KEY: "mn",
  };
  Object.assign(process.env, env);
  delete process.env.RUNWAYML_API_SECRET;
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.sociavault.com") return json({ credits: 5400, subscriptionStatus: "active" });
    if (url.hostname === "openrouter.ai") return json({ data: { total_credits: 50, total_usage: 12.5 } });
    if (url.hostname === "api.manus.ai") return json({ ok: true, data: { total_credits: 3210, periodic_credits: 300 } });
    if (url.hostname === "api.firecrawl.dev") return json({ success: true, data: { remainingCredits: 4100, planCredits: 5000 } });
    if (url.hostname === "api.brandfetch.io") return json({ type: "api-key", usage: { used: 40, quota: 2500 } });
    if (url.hostname === "api.openai.com") {
      return json({ data: [{ results: [{ amount: { value: 1.25 } }] }, { results: [{ amount: { value: 2.5 } }] }], has_more: false });
    }
    if (url.hostname === "api.anthropic.com") return json({ data: [{ results: [{ amount: "1234.5" }] }], has_more: false });
    throw new Error(`unexpected ${url.href}`);
  }) as typeof fetch;
  try {
    const { getProviderBalances } = await import("../src/lib/accounting/providerBalances");
    const { PROVIDER_IDS } = await import("../src/lib/types");
    const rows = await getProviderBalances();
    assert.deepEqual(rows.map((r) => r.provider), [...PROVIDER_IDS]);
    const by = Object.fromEntries(rows.map((r) => [r.provider, r]));
    assert.equal(by.sociavault.balance, 5400);
    assert.equal(by.openrouter.balance, 37.5);
    assert.equal(by.manus.balance, 3210);
    assert.equal(by.firecrawl.balance, 4100);
    assert.equal(by.firecrawl.totalUsed, 900);
    assert.equal(by.brandfetch.balance, 2460);
    assert.equal(by.openai.spentUsd, 3.75);
    // Anthropic reports cents.
    assert.equal(by.anthropic.spentUsd, 12.345);
    // Not configured is said plainly, never a made-up figure.
    assert.equal(by.runway.status, "unavailable");
    assert.equal(by.runway.balance, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
