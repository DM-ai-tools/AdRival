/** Ordered recreation stages. Weights sum to 100 for the overall bar. */

export const UNIFIED_PIPELINE_VERSION = "unified-1";

export type UnifiedStageId =
  | "preparing"
  | "analyzing_competitor"
  | "analyzing_client"
  | "preparing_brief"
  | "creating_page"
  | "generating_images"
  | "checking"
  | "ready";

export type UnifiedStageStatus = "pending" | "active" | "done" | "skipped" | "blocked" | "indeterminate";

export type UnifiedStage = {
  id: UnifiedStageId;
  label: string;
  status: UnifiedStageStatus;
  detail?: string | null;
  weight: number;
};

export const STAGE_DEFS: Array<{ id: UnifiedStageId; label: string; weight: number }> = [
  { id: "preparing", label: "Preparing project", weight: 5 },
  { id: "analyzing_competitor", label: "Analysing competitor page", weight: 18 },
  { id: "analyzing_client", label: "Analysing your website and branding", weight: 14 },
  { id: "preparing_brief", label: "Preparing page brief", weight: 8 },
  { id: "creating_page", label: "Creating content and design", weight: 28 },
  { id: "generating_images", label: "Generating images", weight: 14 },
  { id: "checking", label: "Checking and packaging page", weight: 8 },
  { id: "ready", label: "Ready", weight: 5 },
];

export function initialStages(): UnifiedStage[] {
  return STAGE_DEFS.map((stage) => ({
    ...stage,
    status: "pending" as const,
    detail: null,
  }));
}

export function pctFromStages(stages: UnifiedStage[]): number {
  let done = 0;
  let total = 0;
  for (const stage of stages) {
    total += stage.weight;
    if (stage.status === "done" || stage.status === "skipped") done += stage.weight;
    else if (stage.status === "active" || stage.status === "indeterminate") done += stage.weight * 0.35;
  }
  if (!total) return 0;
  return Math.max(0, Math.min(99, Math.round((done / total) * 100)));
}

export function markStage(
  stages: UnifiedStage[],
  id: UnifiedStageId,
  status: UnifiedStageStatus,
  detail?: string | null,
): UnifiedStage[] {
  return stages.map((stage) => {
    if (stage.id === id) return { ...stage, status, detail: detail ?? stage.detail };
    if (status === "active" || status === "indeterminate") {
      const order = STAGE_DEFS.findIndex((item) => item.id === id);
      const self = STAGE_DEFS.findIndex((item) => item.id === stage.id);
      if (self >= 0 && self < order && stage.status === "pending") {
        return { ...stage, status: "done" };
      }
    }
    return stage;
  });
}
