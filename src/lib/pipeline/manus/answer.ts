import {
  getOpenAICompatClient,
  OPENROUTER_FAST_MODEL,
  resolveOpenAICompatModel,
} from "../../openrouter/openaiCompat";
import { isCreditError } from "../../accounting/errors";

/** Sent when the model cannot be reached (for example after a restart, with no billing context). */
export const DEFAULT_ANSWER =
  "Please decide yourself by following brief.md: keep the competitor's sections, layout and design language, use only the client's own brand, words, images, links and contact details, never invent facts, and do not deploy or publish anything. Deliver the self-contained index.html when you are done.";

/**
 * Answers a question the design agent asks during a run, on the user's
 * behalf, with the fast OpenAI model and the job's context.
 */
export async function answerAgentQuestion(input: {
  question: string;
  options: string[];
  multiple: boolean;
  context: string;
  /** Earlier questions and answers in this run. */
  history: Array<{ question: string; answer: string }>;
}): Promise<{ answer: string; byModel: boolean }> {
  try {
    const client = getOpenAICompatClient();
    const completion = await client.chat.completions.create({
      model: resolveOpenAICompatModel(OPENROUTER_FAST_MODEL),
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `You answer questions from an autonomous web agent that is rebuilding a landing page. You speak for the user of a landing page recreation tool, who is not available. The agent cannot proceed until you answer.

THE JOB
${input.context}

HOW TO ANSWER
- Answer decisively in at most 120 words. Never ask a question back and never say you are unsure.
- Pick what keeps the page most faithful to the competitor's structure and design while using only the client's brand, content and real details.
- When the agent offers options, choose the best one${input.multiple ? " (or several)" : ""} and name it exactly as written, then add one short reason or instruction if useful.
- Facts you do not have (phone numbers, prices, testimonials, awards, addresses): tell the agent to use only what the client's own website shows, and otherwise leave it out or use the call-to-action button instead. Never make facts up.
- Never approve deploying, publishing, hosting, sending emails or messages, buying anything, connecting accounts or sharing credentials. Tell the agent to skip that and deliver the HTML file instead.
- If the agent asks whether to continue, say yes and to finish the page and the visual check.
- Plain text only.`,
        },
        {
          role: "user",
          content: `${input.history.length ? `Earlier in this run:\n${input.history.map((h) => `Q: ${h.question}\nA: ${h.answer}`).join("\n\n")}\n\n` : ""}The agent asks:
${input.question}${input.options.length ? `\n\nOptions (${input.multiple ? "choose one or more" : "choose one"}):\n${input.options.map((o) => `- ${o}`).join("\n")}` : ""}`,
        },
      ],
    });
    const answer = completion.choices[0]?.message?.content?.trim();
    if (answer) return { answer, byModel: true };
  } catch (err) {
    // Out of app credits: the agent still needs an answer, so it gets the default one.
    console.warn(
      `[manus] question answer failed${isCreditError(err) ? " (no credits)" : ""}; sending the default answer`,
      (err as Error).message,
    );
  }
  const pick = input.options.length ? `Choose: ${input.options[0]}. ` : "";
  return { answer: `${pick}${DEFAULT_ANSWER}`, byModel: false };
}
