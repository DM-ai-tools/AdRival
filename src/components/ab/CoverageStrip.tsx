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
  onGenerate,
}: {
  coverage: StageCoverage[];
  labelledCount: number;
  profileReady: boolean;
  /** Task 8 wires this to the ICP route; until then it may be a no-op. */
  onGenerate?: (stage: StageCoverage["stage"]) => void;
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
              {c.status === "missing" ? (
                <button
                  type="button"
                  className="ghost-btn ab-chip-btn"
                  disabled={!profileReady}
                  title={profileReady ? undefined : NO_PROFILE_TIP}
                  onClick={() => onGenerate?.(c.stage)}
                >
                  Generate ICP
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
