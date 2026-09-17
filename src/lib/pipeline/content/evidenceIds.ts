import { createHash } from "node:crypto";
import type { ContentPack, EvidenceFact, ValidationIssue } from "./model";
export { looksLikeSlogan } from "./slogan";

/** Server-owned id for one fact inside one workspace evidence collection. */
export function persistentEvidenceId(input: {
  ownerUserId: string;
  spaceId: string | null;
  category: string;
  value: string;
  sourceUrl: string;
}): string {
  const digest = createHash("sha1")
    .update([
      input.ownerUserId,
      input.spaceId || "",
      input.category,
      input.value.trim().toLowerCase(),
      input.sourceUrl,
    ].join("\0"))
    .digest("hex")
    .slice(0, 12);
  return `ev-${digest}`;
}

/**
 * Replace batch-local ids such as ev-5. Identical value+source keeps one id.
 * A second distinct record that hashes the same gets a stable suffix, not a reused ev-n.
 */
export function assignCollectionIds(
  facts: EvidenceFact[],
  scope: { ownerUserId: string; spaceId: string | null },
): EvidenceFact[] {
  const used = new Map<string, number>();
  return facts.map((fact) => {
    const base = persistentEvidenceId({
      ownerUserId: scope.ownerUserId,
      spaceId: scope.spaceId,
      category: fact.category,
      value: fact.value,
      sourceUrl: fact.sourceUrl,
    });
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return { ...fact, id: count === 1 ? base : `${base}-${count}` };
  });
}

export function duplicateEvidenceIds(facts: Array<{ id: string }>): string[] {
  const counts = new Map<string, number>();
  for (const fact of facts) counts.set(fact.id, (counts.get(fact.id) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

/**
 * Existing packs may contain colliding ev-n ids from separate extractors.
 * Reassign every record in a colliding group. Do not keep ev-n on one of them
 * and guess that old section references meant that record.
 */
export function repairCollidingEvidence(
  facts: EvidenceFact[],
  scope: { ownerUserId: string; spaceId: string | null },
): { facts: EvidenceFact[]; ambiguousIds: string[] } {
  const collisions = new Set(duplicateEvidenceIds(facts));
  if (!collisions.size) return { facts, ambiguousIds: [] };
  const ambiguousIds = [...collisions];
  const repaired = facts.map((fact) =>
    collisions.has(fact.id)
      ? {
          ...fact,
          id: persistentEvidenceId({
            ownerUserId: scope.ownerUserId,
            spaceId: scope.spaceId,
            category: fact.category,
            value: `${fact.value}\0${fact.excerpt}`,
            sourceUrl: fact.sourceUrl,
          }),
        }
      : fact,
  );
  return { facts: assignCollectionIds(repaired, scope), ambiguousIds };
}

/** Persist a unique id for every record. Old shared ids are not guessed onto one record. */
export function repairPackEvidence(pack: ContentPack): ContentPack | null {
  const collisions = duplicateEvidenceIds(pack.evidence.facts);
  if (!collisions.length) return null;
  const repaired = repairCollidingEvidence(pack.evidence.facts, {
    ownerUserId: pack.evidence.ownerUserId,
    spaceId: pack.evidence.spaceId,
  });
  const ambiguous = new Set(repaired.ambiguousIds);
  const sections = pack.canonical.sections.map((section) => {
    const hit = section.evidenceIds.filter((id) => ambiguous.has(id));
    if (!hit.length) return section;
    const issue: ValidationIssue = {
      id: `ambiguous-evidence:${section.id}`,
      severity: "critical",
      sectionId: section.id,
      field: "evidence",
      message: `Evidence ${hit.join(", ")} was shared by different records and was not guessed.`,
      remedy: "Reconfirm which source fact this claim uses.",
    };
    return {
      ...section,
      evidenceIds: section.evidenceIds.filter((id) => !ambiguous.has(id)),
      issues: [...section.issues.filter((item) => item.id !== issue.id), issue],
    };
  });
  return {
    ...pack,
    evidence: { ...pack.evidence, facts: repaired.facts },
    canonical: { ...pack.canonical, sections },
  };
}
