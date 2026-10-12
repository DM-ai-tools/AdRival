import { sanitizeClientFacingText } from "../clientFacing";
import type { ManusEvent, ManusStatusDetail } from "./client";

/**
 * Reading a Manus task: its live feed and the confirmations a run settles by
 * itself. Shared by landing page recreation and the sponsored-ads search.
 */

export type ManusActivity = Array<{ id: string; at: number; kind: "note" | "action"; text: string }>;

/** Markdown links, images and extra spaces removed, cut to a readable length. */
export function plainText(text: string, max: number): string {
  const clean = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

type ToolUsed = {
  tool?: string;
  brief?: string;
  description?: string;
  message?: { action?: string; param?: string };
  params?: { url?: string };
};

/**
 * The agent's own narration and the actions it runs, as Manus shows them
 * ("Browsing rival.com", "Executing command"), oldest first. Commands and
 * file contents are not included.
 */
export function activityFromEvents(events: ManusEvent[]): ManusActivity {
  const out: ManusActivity = [];
  for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
    if (e.type === "assistant_message") {
      const msg = e.assistant_message;
      if (!msg?.content || msg.question_expectation) continue;
      const text = plainText(msg.content, 420);
      if (text) out.push({ id: e.id, at: e.timestamp, kind: "note", text: sanitizeClientFacingText(text) });
    } else if (e.type === "tool_used") {
      const tool = (e as ManusEvent & { tool_used?: ToolUsed }).tool_used;
      let text = tool?.brief || tool?.message?.action || tool?.description || "";
      const param = tool?.message?.param || "";
      const url = tool?.params?.url || (/^https?:\/\//.test(param) ? param : "");
      if (url && /brows|visit|navigat|open|scrap|crawl|fetch/i.test(`${text} ${tool?.tool || ""}`)) {
        try {
          text = `${text || "Browsing"} ${new URL(url).hostname.replace(/^www\./, "")}`;
        } catch {
          /* keep the brief */
        }
      }
      text = plainText(text, 140);
      if (text) out.push({ id: e.id, at: e.timestamp, kind: "action", text: sanitizeClientFacingText(text) });
    }
  }
  return out;
}

/**
 * Confirmations the run settles by itself. Anything that publishes, sends,
 * buys or connects an account is declined; the agent only needs to work in
 * its own sandbox and hand back its result.
 */
export function confirmationFor(
  type: string,
  detail: ManusStatusDetail | null,
): { input: Record<string, unknown> | null; reason: string } {
  const deploying = /deploy|publish/i.test(detail?.waiting_description || "");
  switch (type) {
    case "terminalExecute":
      return { input: { accept: true, always_allow: true }, reason: "" };
    case "webdevRunAction":
      return deploying
        ? { input: { accept: false }, reason: "Do not deploy or publish anything." }
        : { input: { accept: true, mode: "speed" }, reason: "" };
    case "apiHighCreditNotice":
      return { input: { action: "accept" }, reason: "" };
    case "mapreduceAction":
      return { input: { accept: true }, reason: "" };
    case "needConnectMyBrowser":
      return { input: { action: "skip" }, reason: "Use your own browser." };
    case "videoGenerate":
      return { input: null, reason: "The page needs no video." };
    case "deployAction":
      return { input: { accept: false }, reason: "Do not deploy or publish anything." };
    case "webdevRequestSecrets":
      return { input: { accept: false }, reason: "No secrets are available; the page needs none." };
    default: {
      const acceptable = Boolean(detail?.confirm_input_schema?.properties && "accept" in detail.confirm_input_schema.properties);
      return {
        input: acceptable ? { accept: false } : null,
        reason: "That action is not needed for this job.",
      };
    }
  }
}
