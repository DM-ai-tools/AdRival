import test from "node:test";
import assert from "node:assert/strict";
import { makeCompleteJson, resolveDirectOpenAiModel } from "../src/lib/pipeline/llmJson";
import { InsufficientCreditsError } from "../src/lib/accounting/errors";

type Calls = { openai: number; anthropic: number; openaiArgs?: Record<string, unknown> };

function build(opts: {
  env: Record<string, string | undefined>;
  openai?: "ok" | "plain" | "credit" | "none";
  anthropic?: boolean;
}) {
  const calls: Calls = { openai: 0, anthropic: 0 };
  const creditErr = new InsufficientCreditsError(10, 1);
  const openaiClient = {
    chat: {
      completions: {
        create: async (args: Record<string, unknown>) => {
          calls.openai++;
          calls.openaiArgs = args;
          if (opts.openai === "plain") throw new Error("boom");
          if (opts.openai === "credit") throw creditErr;
          return { choices: [{ message: { content: " openai-text " } }] };
        },
      },
    },
  };
  const anthropicClient = {
    messages: {
      create: async () => {
        calls.anthropic++;
        return { content: [{ type: "text", text: "anthropic-text" }] };
      },
    },
  };
  const fn = makeCompleteJson({
    env: opts.env,
    openai: () => (opts.openai && opts.openai !== "none" ? (openaiClient as never) : null),
    anthropic: () => (opts.anthropic ? (anthropicClient as never) : null),
    anthropicModel: () => "claude-test",
  });
  return { fn, calls, creditErr };
}

test("OpenAI key set and succeeding: Anthropic never called", async () => {
  const { fn, calls } = build({
    env: { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a", AB_OPENAI_MODEL: "openai/gpt-4o" },
    openai: "ok",
    anthropic: true,
  });
  assert.equal(await fn("sys", "usr"), "openai-text");
  assert.equal(calls.openai, 1);
  assert.equal(calls.anthropic, 0);
  assert.equal(calls.openaiArgs?.model, "gpt-4o");
  assert.deepEqual(calls.openaiArgs?.response_format, { type: "json_object" });
  assert.equal(calls.openaiArgs?.temperature, 0.15);
  assert.equal(calls.openaiArgs?.max_tokens, 3000);
});

test("OpenAI plain error falls back to Anthropic", async () => {
  const { fn, calls } = build({ env: { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" }, openai: "plain", anthropic: true });
  assert.equal(await fn("s", "u"), "anthropic-text");
  assert.equal(calls.openai, 1);
  assert.equal(calls.anthropic, 1);
});

test("OpenAI credit error is rethrown, Anthropic not called", async () => {
  const { fn, calls, creditErr } = build({ env: { OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a" }, openai: "credit", anthropic: true });
  await assert.rejects(fn("s", "u"), (e) => e === creditErr);
  assert.equal(calls.anthropic, 0);
});

test("no OpenAI key goes straight to Anthropic", async () => {
  const { fn, calls } = build({ env: { ANTHROPIC_API_KEY: "a" }, openai: "ok", anthropic: true });
  assert.equal(await fn("s", "u"), "anthropic-text");
  assert.equal(calls.openai, 0);
});

test("no keys at all rejects with the could-not-get-a-response error", async () => {
  const { fn } = build({ env: {}, openai: "none", anthropic: false });
  await assert.rejects(fn("s", "u"), /could not get a response/);
});

test("resolveDirectOpenAiModel precedence, prefix strip, blanks ignored", () => {
  assert.equal(resolveDirectOpenAiModel({ AB_OPENAI_MODEL: "a", OFFERS_OPENAI_MODEL: "b" }), "a");
  assert.equal(resolveDirectOpenAiModel({ OFFERS_OPENAI_MODEL: "b" }), "b");
  assert.equal(resolveDirectOpenAiModel({}), "gpt-4o-mini");
  assert.equal(resolveDirectOpenAiModel({ AB_OPENAI_MODEL: "openai/gpt-4o-mini" }), "gpt-4o-mini");
  assert.equal(
    resolveDirectOpenAiModel({ AB_OPENAI_MODEL: "  ", OFFERS_OPENAI_MODEL: " openai/gpt-4.1 " }),
    "gpt-4.1",
  );
  assert.equal(resolveDirectOpenAiModel({ AB_OPENAI_MODEL: " ", OFFERS_OPENAI_MODEL: "" }), "gpt-4o-mini");
});
