import Anthropic from "@anthropic-ai/sdk";
import { meterAnthropicClient } from "@/lib/accounting/meteredClients";

let client: Anthropic | null = null;

/**
 * Messages are metered for credit accounting. Anthropic returns
 * `usage.input_tokens` / `usage.output_tokens` on every response, so charges
 * are based on confirmed token counts.
 */
export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!client) {
    client = meterAnthropicClient(
      new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    );
  }
  return client;
}

export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";
}
