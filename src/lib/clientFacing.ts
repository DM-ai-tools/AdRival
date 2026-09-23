/**
 * Strip third-party LLM / framework brand names from client-facing copy.
 * Keeps the task description (analyze, scrape, generate images, etc.).
 */
const VENDOR_REPLACEMENTS: Array<[RegExp, string]> = [
  [/OpenRouter/gi, "analysis service"],
  [/Perplexity(?:\s+Sonar)?/gi, "URL analysis"],
  [/Anthropic/gi, "content engine"],
  // Model family names and API ids (e.g. claude-sonnet-5, Claude Opus 5)
  [/\bclaude(?:-[\w.]+)+\b/gi, "content engine"],
  [/Claude(?:\s+(?:Sonnet|Opus|Haiku|Fable))?(?:\s*[\d.]+)?/gi, "content engine"],
  [/\b(?:Sonnet|Opus|Haiku|Fable)(?:\s*[\d.]+)?\b/gi, "content engine"],
  [/OpenAI/gi, "content engine"],
  [/ChatGPT/gi, "content engine"],
  [/GPT[\s-]?Image[\s-]?2/gi, "image generation"],
  [/\bgpt-[\w.-]+\b/gi, "model"],
  [/Runway(?:ML)?/gi, "image generation"],
  [/Firecrawl/gi, "site capture"],
  [/Brandfetch/gi, "brand lookup"],
  [/SociaVault/gi, "ad library"],
  [/Sociavault/gi, "ad library"],
  [/Playwright/gi, "page capture"],
  [/OPENROUTER_API_KEY/gi, "analysis API key"],
  [/OPENAI_API_KEY/gi, "content API key"],
  [/ANTHROPIC_API_KEY/gi, "content API key"],
  [/FIRECRAWL_API_KEY/gi, "site capture API key"],
  [/RUNWAYML_API_SECRET/gi, "image generation API key"],
  [/SOCIAVAULT_API_KEY/gi, "ad library API key"],
  [/BRANDFETCH_API_KEY/gi, "brand lookup API key"],
  [/https?:\/\/openrouter\.ai\/\S*/gi, "your provider dashboard"],
  // "Model claude-…" style progress details
  [/\bModel\s+content engine\b/gi, "Content engine"],
  [/\bvia\s+content engine\b/gi, ""],
];

export function sanitizeClientFacingText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VENDOR_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

const NOT_CONFIGURED =
  "This task is not configured. Please contact your administrator.";

/**
 * Text shown in the main app. Vendor names and API key names are removed.
 * Admin screens should keep the original string.
 */
export function maskClientFacingText(
  input: string | null | undefined,
): string | null {
  if (input == null || input === "") return input ?? null;
  if (/API_KEY|API_SECRET/i.test(input)) return NOT_CONFIGURED;
  return sanitizeClientFacingText(input);
}

export function maskPageAnalysis<
  T extends { error?: string | null; techNotes?: string[] } | null | undefined,
>(analysis: T): T {
  if (!analysis) return analysis;
  return {
    ...analysis,
    error: maskClientFacingText(analysis.error),
    techNotes: analysis.techNotes?.map(
      (note) => maskClientFacingText(note) || note,
    ),
  };
}

/** Scrub vendor/model names from a recreated page before sending to the client. */
export function maskRecreatedPage<T extends {
  error?: string | null;
  differentiationNotes?: string | null;
  progress?: {
    message?: string | null;
    phase?: string | null;
    stages?: Array<{ detail?: string | null; label?: string }>;
  } | null;
  contentDraft?: { model?: string | null } | null;
} | null | undefined>(page: T): T {
  if (!page) return page;
  const stages = page.progress?.stages?.map((stage) => ({
    ...stage,
    detail: stage.detail != null ? maskClientFacingText(stage.detail) : stage.detail,
  }));
  return {
    ...page,
    error: maskClientFacingText(page.error),
    differentiationNotes: maskClientFacingText(page.differentiationNotes ?? null),
    progress: page.progress
      ? {
          ...page.progress,
          message: maskClientFacingText(page.progress.message ?? null) ?? page.progress.message,
          stages,
        }
      : page.progress,
    contentDraft: page.contentDraft
      ? { ...page.contentDraft, model: null }
      : page.contentDraft,
  };
}
