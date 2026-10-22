export const EVIDENCE_STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "our", "you", "are", "was", "this", "that",
  "from", "have", "has", "all", "can", "will", "get", "its", "not", "but", "who",
]);

export function evidenceWords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .map((w) => (w.length > 4 ? w.replace(/s$/, "") : w))
        .filter((w) => w.length >= 3 && !EVIDENCE_STOPWORDS.has(w)),
    ),
  );
}

/** Share of a phrase's words that appear in the page text (0–1). */
export function pageCoverage(phrase: string, pageWords: Set<string>): number {
  const words = evidenceWords(phrase);
  if (!words.length) return 0;
  return words.filter((w) => pageWords.has(w)).length / words.length;
}
