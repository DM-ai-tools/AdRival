/**
 * Length budgets + safe clipping for landing-page content slots.
 * Prefer complete phrases over exact char counts.
 */

export function lengthBudgetForRole(
  len: number,
  role?: string | null,
): { minLen: number; maxLen: number } {
  const n = Math.max(1, len || 1);
  const r = (role || "").toLowerCase();
  const shortUi =
    r === "cta" ||
    r === "button" ||
    r === "nav" ||
    r === "footer_link" ||
    r === "social" ||
    r === "stat";
  const headline =
    r === "h1" || r === "h2" || r === "h3" || r === "h4" || r === "eyebrow";

  if (shortUi) {
    const pad = Math.max(4, Math.round(n * 0.3));
    return {
      minLen: Math.max(1, n - pad),
      maxLen: Math.min(64, Math.max(n + pad, n + 10)),
    };
  }

  if (headline) {
    // Short competitor lines need room for a finished phrase
    const minLen = Math.max(6, Math.floor(n * 0.65));
    const maxLen = Math.max(
      n + 18,
      Math.ceil(n * 1.6),
      n <= 45 ? 64 : Math.ceil(n * 1.45),
    );
    return { minLen, maxLen: Math.min(maxLen, 120) };
  }

  // body / bullet / testimonial
  return {
    minLen: Math.max(10, Math.floor(n * 0.7)),
    maxLen: Math.min(420, Math.max(n + 28, Math.ceil(n * 1.55))),
  };
}

/** Legacy ±18% budget — prefer lengthBudgetForRole. */
export function lengthBudget(len: number): { minLen: number; maxLen: number } {
  return lengthBudgetForRole(len, "body");
}

function looksCompletePhrase(t: string): boolean {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s) return false;
  if (/[.!?…]$/.test(s)) return true;
  // Short CTAs / eyebrows can be phrase fragments without terminal punctuation
  const words = s.split(/\s+/);
  if (words.length <= 5 && !/\b(with|and|or|for|to|the|a|an|of|in|on|so|your|our|that|which|who|smarter|better|more)\s*$/i.test(s)) {
    return true;
  }
  if (
    /\b(with|and|or|for|to|the|a|an|of|in|on|so|your|our|that|which|who|smarter|better|more|less|from|into|over)\s*$/i.test(
      s,
    )
  ) {
    return false;
  }
  return words.length >= 4;
}

function stripTrailingConnectors(t: string): string {
  return t
    .replace(
      /\b(with|and|or|for|to|the|a|an|of|in|on|so|your|our|that|which|who|from|into|over|smarter|better|more|less)\s*$/i,
      "",
    )
    .replace(/[,:;–—-]\s*$/, "")
    .trim();
}

/**
 * Clip text toward maxLen without leaving mid-sentence stubs.
 * Allows a soft overshoot when the phrase is already complete.
 */
export function clipToCompletePhrase(
  text: string,
  maxLen: number,
  options?: { softMax?: number | null; role?: string | null },
): string {
  let t = (text || "").replace(/\s+/g, " ").trim();
  if (!t || !maxLen || maxLen < 4) return t;

  const role = (options?.role || "").toLowerCase();
  const softDefault =
    role === "cta" || role === "button" || role === "nav"
      ? Math.ceil(maxLen * 1.15)
      : Math.max(maxLen + 12, Math.ceil(maxLen * 1.35));
  const softMax = Math.max(maxLen, options?.softMax ?? softDefault);

  if (t.length <= maxLen) {
    // Still strip dangling connectors if the model ended early
    if (!looksCompletePhrase(t)) {
      const cleaned = stripTrailingConnectors(t);
      if (cleaned.length >= Math.min(8, maxLen)) return cleaned;
    }
    return t;
  }

  if (t.length <= softMax && looksCompletePhrase(t)) {
    return t;
  }

  const window = t.slice(0, softMax);
  const ends = [
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
    window.lastIndexOf("."),
    window.lastIndexOf("!"),
    window.lastIndexOf("?"),
  ];
  const sentenceEnd = Math.max(...ends);
  if (sentenceEnd >= Math.floor(maxLen * 0.5)) {
    return window.slice(0, sentenceEnd + 1).trim();
  }

  let cut = stripTrailingConnectors(
    t.slice(0, maxLen).replace(/\s+\S*$/, "").trim(),
  );
  if (!looksCompletePhrase(cut)) {
    const extended = stripTrailingConnectors(
      t.slice(0, softMax).replace(/\s+\S*$/, "").trim(),
    );
    if (extended.length > cut.length) cut = extended;
  }
  return cut || t.slice(0, maxLen).trim();
}
