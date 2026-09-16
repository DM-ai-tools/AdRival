import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ProviderId } from "@/lib/types";
import {
  extractAnthropicUsage,
  extractOpenAiUsage,
  meterProviderCall,
} from "./meter";

/**
 * The SDK clients are wrapped once at their factory instead of at each of the
 * ~40 call sites. Every completion therefore lands in the ledger, and adding a
 * new call site cannot accidentally bypass accounting.
 */

const METERED = Symbol.for("adrival.metered");

function alreadyWrapped(target: object): boolean {
  return (target as Record<symbol, boolean>)[METERED] === true;
}

function markWrapped(target: object) {
  Object.defineProperty(target, METERED, { value: true, enumerable: false });
}

type ChatCreate = OpenAI["chat"]["completions"]["create"];

/**
 * Meter `chat.completions.create`.
 *
 * `requestUsageAccounting` adds OpenRouter's documented `usage: {include:true}`
 * flag, which makes it return `usage.cost` (real USD charged) alongside token
 * counts. It is not sent to the OpenAI API, which does not accept it.
 */
export function meterOpenAiClient(
  client: OpenAI,
  provider: ProviderId,
  options?: { requestUsageAccounting?: boolean },
): OpenAI {
  const completions = client.chat.completions;
  if (alreadyWrapped(completions)) return client;

  const original = completions.create.bind(completions) as ChatCreate;

  const metered = ((params: Parameters<ChatCreate>[0], requestOptions?: Parameters<ChatCreate>[1]) => {
    const model = typeof params?.model === "string" ? params.model : null;
    const finalParams = options?.requestUsageAccounting
      ? { ...params, usage: { include: true } }
      : params;
    return meterProviderCall(
      {
        provider,
        model,
        operation: `${provider}.chat.completions`,
        extractUsage: extractOpenAiUsage,
      },
      () => original(finalParams as Parameters<ChatCreate>[0], requestOptions),
    );
  }) as ChatCreate;

  completions.create = metered;
  markWrapped(completions);
  return client;
}

type MessagesCreate = Anthropic["messages"]["create"];

/** Meter `messages.create`. Anthropic reports input/output tokens in `usage`. */
export function meterAnthropicClient(client: Anthropic): Anthropic {
  const messages = client.messages;
  if (alreadyWrapped(messages)) return client;

  const original = messages.create.bind(messages) as MessagesCreate;

  const metered = ((
    params: Parameters<MessagesCreate>[0],
    requestOptions?: Parameters<MessagesCreate>[1],
  ) => {
    const model = typeof params?.model === "string" ? params.model : null;
    return meterProviderCall(
      {
        provider: "anthropic",
        model,
        operation: "anthropic.messages",
        extractUsage: extractAnthropicUsage,
      },
      () => original(params, requestOptions),
    );
  }) as MessagesCreate;

  messages.create = metered;
  markWrapped(messages);
  return client;
}
