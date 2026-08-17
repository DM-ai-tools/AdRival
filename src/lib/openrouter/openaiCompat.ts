import OpenAI from "openai";
import { getOpenRouterClient, hasOpenRouterKey } from "./client";

/** OpenAI models via OpenRouter (avoids direct platform.openai.com credits). */
export const OPENROUTER_OPENAI_MODEL =
  process.env.OPENROUTER_OPENAI_MODEL || "openai/gpt-4o";

export const OPENROUTER_OPENAI_MINI_MODEL =
  process.env.OPENROUTER_OPENAI_MINI_MODEL || "openai/gpt-4o-mini";

/** Long-form content / design-fit model via OpenRouter */
export const OPENROUTER_OPENAI_CONTENT_MODEL =
  process.env.OPENROUTER_OPENAI_CONTENT_MODEL || "openai/gpt-4.1";

export function hasOpenAICompatKey(): boolean {
  return hasOpenRouterKey() || Boolean(process.env.OPENAI_API_KEY?.trim());
}

/**
 * Prefer OpenRouter (OpenAI models) so features don't burn direct OpenAI credits.
 * Falls back to platform.openai.com when OPENROUTER_API_KEY is missing.
 */
export function getOpenAICompatClient(): OpenAI {
  if (hasOpenRouterKey()) return getOpenRouterClient();
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENROUTER_API_KEY or OPENAI_API_KEY is required");
  }
  return new OpenAI({ apiKey: key });
}

/** Ensure bare OpenAI ids become OpenRouter slugs when routed via OpenRouter. */
export function resolveOpenAICompatModel(model: string): string {
  const m = (model || "").trim();
  if (!m) {
    return hasOpenRouterKey() ? OPENROUTER_OPENAI_MODEL : "gpt-4o";
  }
  if (!hasOpenRouterKey()) return m;
  if (m.includes("/")) return m;
  return `openai/${m}`;
}
