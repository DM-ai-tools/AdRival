import OpenAI from "openai";
import { meterOpenAiClient } from "@/lib/accounting/meteredClients";

/**
 * OpenRouter OpenAI-compatible client.
 * Docs: https://openrouter.ai/docs
 * Perplexity Sonar: https://openrouter.ai/perplexity/sonar
 *
 * Completions are metered for credit accounting. OpenRouter's usage accounting
 * (https://openrouter.ai/docs/cookbook/administration/usage-accounting) returns
 * native token counts plus the real USD `cost` per request, so charges here are
 * based on confirmed usage rather than an estimate.
 */
export function getOpenRouterClient() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const client = new OpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer":
        process.env.OPENROUTER_SITE_URL || "https://adrival.up.railway.app",
      "X-Title": process.env.OPENROUTER_APP_NAME || "AdRival",
    },
  });
  return meterOpenAiClient(client, "openrouter", {
    requestUsageAccounting: true,
  });
}

export const OPENROUTER_PERPLEXITY_MODEL =
  process.env.OPENROUTER_MODEL || "perplexity/sonar";

export function hasOpenRouterKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}
