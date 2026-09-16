/**
 * Strip third-party LLM / framework brand names from client-facing copy.
 * Keeps the task description (analyze, scrape, generate images, etc.).
 */
const VENDOR_REPLACEMENTS: Array<[RegExp, string]> = [
  [/OpenRouter/gi, "analysis service"],
  [/Perplexity(?:\s+Sonar)?/gi, "URL analysis"],
  [/Anthropic/gi, "content engine"],
  [/Claude(?:\s+Sonnet)?(?:\s*[\d.]+)?/gi, "content engine"],
  [/OpenAI/gi, "content engine"],
  [/ChatGPT/gi, "content engine"],
  [/GPT[\s-]?Image[\s-]?2/gi, "image generation"],
  [/\bgpt-[\w.-]+\b/gi, "model"],
  [/Runway(?:ML)?/gi, "image generation"],
  [/Firecrawl/gi, "site scrape"],
  [/Brandfetch/gi, "brand lookup"],
  [/SociaVault/gi, "ad library"],
  [/Sociavault/gi, "ad library"],
  [/Playwright/gi, "page capture"],
  [/OPENROUTER_API_KEY/gi, "analysis API key"],
  [/OPENAI_API_KEY/gi, "content API key"],
  [/ANTHROPIC_API_KEY/gi, "content API key"],
  [/FIRECRAWL_API_KEY/gi, "site scrape API key"],
  [/RUNWAYML_API_SECRET/gi, "image generation API key"],
  [/SOCIAVAULT_API_KEY/gi, "ad library API key"],
  [/BRANDFETCH_API_KEY/gi, "brand lookup API key"],
  [/https?:\/\/openrouter\.ai\/\S*/gi, "your provider dashboard"],
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
