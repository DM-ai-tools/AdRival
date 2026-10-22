"use client";

import type { StageCoverage } from "@/lib/pipeline/awareness/coverage";

export const STAGE_LABELS: Record<string, string> = {
  unaware: "Unaware",
  problem_aware: "Problem aware",
  solution_aware: "Solution aware",
  product_aware: "Product aware",
  most_aware: "Most aware",
  unclear: "Unclear",
};

export const NO_PROFILE_TIP = "Add your business website first";

export function CoverageStrip({
  coverage,
  labelledCount,
  profileReady,
  icpStages = [],
  generatingStage = null,
  onGenerate,
  onView,
}: {
  coverage: StageCoverage[];
  labelledCount: number;
  profileReady: boolean;
  /** Stages that already have a saved ICP; their chip shows "View ICP". */
  icpStages?: string[];
  generatingStage?: string | null;
  /** Spends credits; called only from an explicit click. */
  onGenerate?: (stage: StageCoverage["stage"], opener: HTMLElement) => void;
  /** Opens the saved ICP; spends nothing. */
  onView?: (stage: StageCoverage["stage"], opener: HTMLElement) => void;
}) {
  if (labelledCount <= 0) return null;
  return (
    <div className="ab-strip" aria-label="Awareness stage coverage">
      <ol className="ab-strip-chips">
        {coverage.map((c) => {
          const label = STAGE_LABELS[c.stage] ?? c.stage;
          const n = c.pageIds.length;
          const detail =
            c.status === "covered"
              ? `${n} ${n === 1 ? "page" : "pages"}`
              : c.status === "partial"
                ? "Partly covered"
                : "Missing";
          return (
            <li
              key={c.stage}
              className={`ab-chip is-${c.status}`}
              aria-label={`${label}: ${detail}`}
            >
              <span className="ab-chip-stage">{label}</span>
              <span className="ab-chip-detail">{detail}</span>
              {icpStages.includes(c.stage) ? (
                <button
                  type="button"
                  className="ghost-btn ab-chip-btn"
                  onClick={(e) => onView?.(c.stage, e.currentTarget)}
                >
                  View ICP
                </button>
              ) : c.status === "missing" ? (
                <button
                  type="button"
                  className="ghost-btn ab-chip-btn"
                  disabled={!profileReady || generatingStage !== null}
                  title={profileReady ? undefined : NO_PROFILE_TIP}
                  onClick={(e) => onGenerate?.(c.stage, e.currentTarget)}
                >
                  {generatingStage === c.stage ? "Generating…" : "Generate ICP"}
                </button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="muted ab-strip-help">Stages no competitor page speaks to are your opening.</p>
    </div>
  );
}
