/**
 * Shared English check for ad copy. Facebook already asks the library for
 * English; Google Transparency has no language filter, so the same check
 * has to reject the creative after it is fetched.
 */
const FOREIGN_WORDS =
  /\b(pour|avec|une|des|les|dans|sur|plus|votre|nous|est|sont|aux|cette|ces|par|chez|dès|des|und|der|die|das|für|mit|ein|eine|nicht|sie|wir|von|den|het|een|van|voor|niet|que|los|las|del|para|con|una|este|esta|más|por)\b/gi;

const ENGLISH_WORDS =
  /\b(the|and|for|with|your|our|you|we|from|this|that|get|free|more|best|call|book|now|services|service|agency|marketing|results|grow|help|business|customers|clients)\b/gi;

export function looksLikeEnglish(text: string): boolean {
  const sample = text.replace(/\s+/g, " ").trim();
  if (sample.length < 12) return true;

  const foreignHits = sample.match(FOREIGN_WORDS)?.length ?? 0;
  const englishHits = sample.match(ENGLISH_WORDS)?.length ?? 0;
  const accentHits = sample.match(/[àâäéèêëïîôùûüçñáíóú¿¡]/gi)?.length ?? 0;

  if (foreignHits >= 2 && foreignHits > englishHits) return false;
  if (accentHits >= 2 && foreignHits >= englishHits) return false;
  if (accentHits >= 5) return false;
  return true;
}
