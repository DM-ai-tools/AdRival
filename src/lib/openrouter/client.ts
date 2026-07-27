import OpenAI from "openai";

/**
 * OpenRouter OpenAI-compatible client.
 * Docs: https://openrouter.ai/docs
 * Perplexity Sonar: https://openrouter.ai/perplexity/sonar
 */
export function getOpenRouterClient() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  return new OpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer":
        process.env.OPENROUTER_SITE_URL || "https://adrival.up.railway.app",
      "X-Title": process.env.OPENROUTER_APP_NAME || "AdRival",
    },
  });
}

export const OPENROUTER_PERPLEXITY_MODEL =
  process.env.OPENROUTER_MODEL || "perplexity/sonar";
