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
