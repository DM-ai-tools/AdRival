import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { getDirectOpenAIClient } from "../openrouter/openaiCompat";
import { getAnthropicClient, getAnthropicModel } from "../anthropic/client";
import { isCreditError } from "../accounting/errors";

export type JsonCaller = (system: string, user: string) => Promise<string>;

const DEFAULT_DIRECT_OPENAI_MODEL = "gpt-4o-mini";

/**
 * Model id for the direct OpenAI API. Accepts an OpenRouter-style slug
 * (`openai/gpt-4o-mini`) and strips the prefix, since the direct API needs the bare id.
 */
export function resolveDirectOpenAiModel(
  env: Record<string, string | undefined>,
): string {
  const raw =
    env.AB_OPENAI_MODEL?.trim() ||
    env.OFFERS_OPENAI_MODEL?.trim() ||
    DEFAULT_DIRECT_OPENAI_MODEL;
  return raw.replace(/^openai\//, "") || DEFAULT_DIRECT_OPENAI_MODEL;
}

export type CompleteJsonDeps = {
  env: Record<string, string | undefined>;
  openai?: () => OpenAI | null;
  anthropic?: () => Anthropic | null;
  anthropicModel?: () => string;
};

export function makeCompleteJson(deps: CompleteJsonDeps): JsonCaller {
  return async (system, user) => {
    let raw: string | null = null;

    const openai = deps.env.OPENAI_API_KEY?.trim() ? deps.openai?.() : null;
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: resolveDirectOpenAiModel(deps.env),
          temperature: 0.15,
          max_tokens: 3000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        });
        raw = completion.choices[0]?.message?.content?.trim() || null;
      } catch (err) {
        if (isCreditError(err)) throw err;
        console.error("[llm-json] OpenAI failed, falling back", err);
      }
    }

    if (!raw && deps.env.ANTHROPIC_API_KEY) {
      try {
        const client = deps.anthropic?.();
        if (client) {
          const completion = await client.messages.create({
            model: (deps.anthropicModel ?? getAnthropicModel)(),
            max_tokens: 3000,
            temperature: 0.15,
            system,
            messages: [{ role: "user", content: user }],
          });
          raw = completion.content
            .map((b) => (b.type === "text" ? b.text : ""))
            .join("\n")
            .trim();
        }
      } catch (err) {
        if (isCreditError(err)) throw err;
        console.error("[llm-json] Anthropic failed", err);
      }
    }

    if (!raw) {
      throw new Error(
        "Landing-page analysis could not get a response. Try again, or contact your administrator if this keeps happening.",
      );
    }
    return raw;
  };
}

/** Text-only JSON completion for the A/B portal: direct OpenAI, then Anthropic. */
export const completeJson: JsonCaller = (system, user) =>
  makeCompleteJson({
    env: process.env,
    openai: getDirectOpenAIClient,
    anthropic: getAnthropicClient,
    anthropicModel: getAnthropicModel,
  })(system, user);
