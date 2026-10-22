import type { PageLevels } from "../../types";

export const AWARENESS_STAGES = [
  "unaware",
  "problem_aware",
  "solution_aware",
  "product_aware",
  "most_aware",
] as const;

export type StageStatus = "covered" | "partial" | "missing";

export type StageCoverage = {
  stage: (typeof AWARENESS_STAGES)[number];
  status: StageStatus;
  pageIds: string[];
};

/**
 * Which awareness stages the compared pages speak to. A stage is covered when
 * a page's overall stage is it, partial when only a section of a page is.
 * Pages without labels are ignored.
 */
export function computeCoverage(pages: Array<{ id: string; levels?: PageLevels | null }>): {
  stages: StageCoverage[];
  labelledCount: number;
} {
  const labelled = pages.filter((p): p is { id: string; levels: PageLevels } => !!p.levels);
  const stages = AWARENESS_STAGES.map((stage): StageCoverage => {
    const whole = labelled.filter((p) => p.levels.awarenessStage === stage).map((p) => p.id);
    if (whole.length) return { stage, status: "covered", pageIds: whole };
    const part = labelled
      .filter((p) => p.levels.sectionLevels.some((s) => s.awarenessStage === stage))
      .map((p) => p.id);
    if (part.length) return { stage, status: "partial", pageIds: part };
    return { stage, status: "missing", pageIds: [] };
  });
  return { stages, labelledCount: labelled.length };
}
