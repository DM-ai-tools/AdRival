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
/** Bumped when the Anthropic wrapper behavior changes (e.g. sampling sanitize). */
const METERED_ANTHROPIC = Symbol.for("adrival.metered.anthropic.v3");

function alreadyWrapped(target: object): boolean {
  return (target as Record<symbol, boolean>)[METERED] === true;
}

function markWrapped(target: object) {
  Object.defineProperty(target, METERED, { value: true, enumerable: false });
}

function alreadyWrappedAnthropic(target: object): boolean {
  return (target as Record<symbol, boolean>)[METERED_ANTHROPIC] === true;
}

function markWrappedAnthropic(target: object) {
  Object.defineProperty(target, METERED_ANTHROPIC, {
    value: true,
    enumerable: false,
  });
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

/**
 * Newer Claude models (Opus 4.7+ / Sonnet 5+) reject non-default sampling
 * params with HTTP 400. Strip them centrally so call sites stay compatible.
 */
function sanitizeAnthropicParams(
  params: Parameters<MessagesCreate>[0],
): Parameters<MessagesCreate>[0] {
  if (!params || typeof params !== "object") return params;
  const {
    temperature: _temperature,
    top_p: _topP,
    top_k: _topK,
    ...rest
  } = params as Parameters<MessagesCreate>[0] & {
    temperature?: number;
    top_p?: number;
    top_k?: number;
  };
  return rest as Parameters<MessagesCreate>[0];
}

/** Meter `messages.create` / `messages.stream`. Anthropic reports tokens in `usage`. */
export function meterAnthropicClient(client: Anthropic): Anthropic {
  const messages = client.messages;
  if (alreadyWrappedAnthropic(messages)) return client;

  const originalCreate = messages.create.bind(messages) as MessagesCreate;
  const originalStream = messages.stream.bind(messages);

  const meteredCreate = ((
    params: Parameters<MessagesCreate>[0],
    requestOptions?: Parameters<MessagesCreate>[1],
  ) => {
    const safeParams = sanitizeAnthropicParams(params);
    const streaming = Boolean(
      safeParams && typeof safeParams === "object" && "stream" in safeParams && (safeParams as { stream?: boolean }).stream,
    );
    // Streaming responses are billed when finalMessage() resolves (see stream wrapper).
    if (streaming) {
      return originalCreate(safeParams, requestOptions);
    }
    const model = typeof safeParams?.model === "string" ? safeParams.model : null;
    return meterProviderCall(
      {
        provider: "anthropic",
        model,
        operation: "anthropic.messages",
        extractUsage: extractAnthropicUsage,
      },
      () => originalCreate(safeParams, requestOptions),
    );
  }) as MessagesCreate;

  messages.create = meteredCreate;

  messages.stream = ((params, options) => {
    const safeParams = sanitizeAnthropicParams(
      params as Parameters<MessagesCreate>[0],
    ) as typeof params;
    const model = typeof (safeParams as { model?: string })?.model === "string"
      ? (safeParams as { model: string }).model
      : null;
    const stream = originalStream(safeParams, options);
    const originalFinal = stream.finalMessage.bind(stream);
    stream.finalMessage = (() =>
      meterProviderCall(
        {
          provider: "anthropic",
          model,
          operation: "anthropic.messages.stream",
          extractUsage: extractAnthropicUsage,
        },
        () => originalFinal(),
      )) as typeof stream.finalMessage;
    return stream;
  }) as typeof messages.stream;

  markWrappedAnthropic(messages);
  return client;
}
