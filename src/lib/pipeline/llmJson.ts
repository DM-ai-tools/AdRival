import {
  getOpenRouterClient,
  hasOpenRouterKey,
  OPENROUTER_PERPLEXITY_MODEL,
} from "../openrouter/client";
import { OPENROUTER_FAST_MODEL, resolveOpenAICompatModel } from "../openrouter/openaiCompat";
import { getAnthropicClient, getAnthropicModel } from "../anthropic/client";
import { isCreditError } from "../accounting/errors";

export type JsonCaller = (system: string, user: string) => Promise<string>;

/** Text-only JSON completion: OpenRouter OpenAI, then Anthropic, then OpenRouter Perplexity. */
export const completeJson: JsonCaller = async (system, user) => {
  let raw: string | null = null;

  if (hasOpenRouterKey()) {
    try {
      const completion = await getOpenRouterClient().chat.completions.create({
        model: resolveOpenAICompatModel(
          process.env.OFFERS_OPENAI_MODEL?.trim() || OPENROUTER_FAST_MODEL,
        ),
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
      console.error("[llm-json] OpenRouter OpenAI failed, falling back", err);
    }
  }

  if (!raw && process.env.ANTHROPIC_API_KEY) {
    try {
      const completion = await getAnthropicClient().messages.create({
        model: getAnthropicModel(),
        max_tokens: 3000,
        temperature: 0.15,
        system,
        messages: [{ role: "user", content: user }],
      });
      raw = completion.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n")
        .trim();
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.error("[llm-json] Anthropic failed, falling back", err);
    }
  }

  if (!raw && hasOpenRouterKey()) {
    try {
      const completion = await getOpenRouterClient().chat.completions.create({
        model: OPENROUTER_PERPLEXITY_MODEL,
        temperature: 0.15,
        max_tokens: 3000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });
      raw = completion.choices[0]?.message?.content?.trim() || "";
    } catch (err) {
      if (isCreditError(err)) throw err;
      console.error("[llm-json] OpenRouter Perplexity failed", err);
    }
  }

  if (!raw) {
    throw new Error(
      "Landing-page analysis could not get a response. Try again, or contact your administrator if this keeps happening.",
    );
  }
  return raw;
};
