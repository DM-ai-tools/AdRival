import type { PageLevels } from "../types";

/**
 * Plain-words labels for a landing page's audience level and awareness stage.
 * Kept here, free of React, so the exporter can use them; the A/B testing
 * screen holds its own copy of the same words.
 */

const AUDIENCE: Record<string, string> = {
  newbie: "Newbie",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const STAGE: Record<string, string> = {
  unaware: "Unaware",
  problem_aware: "Problem aware",
  solution_aware: "Solution aware",
  product_aware: "Product aware",
  most_aware: "Most aware",
};

const FOCUS: Record<string, string> = {
  only_problem: "only problem",
  only_solution: "only solution",
};

/** Empty for a missing or unclear level. */
export function audienceLevelText(levels: PageLevels | null | undefined): string {
  return AUDIENCE[levels?.audienceLevel ?? ""] ?? "";
}

/** For example "Problem aware (only problem)"; empty for a missing or unclear stage. */
export function awarenessStageText(levels: PageLevels | null | undefined): string {
  const stage = STAGE[levels?.awarenessStage ?? ""];
  if (!stage) return "";
  const focus = FOCUS[levels?.awarenessFocus ?? ""];
  return focus ? `${stage} (${focus})` : stage;
}

/** The plain name of an awareness stage, for example "Problem aware"; empty for an unknown one. */
export function stageNameText(stage: string | null | undefined): string {
  return STAGE[stage ?? ""] ?? "";
}
