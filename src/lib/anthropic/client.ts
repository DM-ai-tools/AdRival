import Anthropic from "@anthropic-ai/sdk";
import { meterAnthropicClient } from "@/lib/accounting/meteredClients";

let client: Anthropic | null = null;
/** Bumped when Anthropic request shaping changes so HMR rebuilds a clean client. */
const CLIENT_EPOCH = 3;
let clientEpoch = 0;

/**
 * Messages are metered for credit accounting. Anthropic returns
 * `usage.input_tokens` / `usage.output_tokens` on every response, so charges
 * are based on confirmed token counts.
 *
 * Sampling params (`temperature`, `top_p`, `top_k`) are stripped by the meter
 * wrapper — newer Claude models reject them with HTTP 400.
 */
export function getAnthropicClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!client || clientEpoch !== CLIENT_EPOCH) {
    client = meterAnthropicClient(
      new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    );
    clientEpoch = CLIENT_EPOCH;
  }
  return client;
}

export function getAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-5";
}
