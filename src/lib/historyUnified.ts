import { listHistoryRuns, listLookupHistory } from "./db";
import { PLATFORM_META, type AdPlatform, type HistoryKind } from "./platforms";
import type { HistoryRunSummary, LookupHistorySummary } from "./types";

export type UnifiedHistoryItem = {
  id: string;
  kind: HistoryKind;
  platform: AdPlatform | string;
  platformLabel: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  countLabel: string;
  subtitle?: string;
};

export function listUnifiedHistory(limit = 150): UnifiedHistoryItem[] {
  const searches = listHistoryRuns(limit).map((run: HistoryRunSummary) => {
    const platform = (run.platform || "facebook") as string;
    return {
      id: run.id,
      kind: "search" as const,
      platform,
      platformLabel:
        PLATFORM_META[platform as AdPlatform]?.short || String(platform),
      title: run.keyword,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      count: run.competitorCount,
      countLabel: "competitors",
      subtitle: run.keywords?.length
        ? `${run.keywords.length} keywords`
        : undefined,
    };
  });

  const lookups = listLookupHistory(limit).map((run: LookupHistorySummary) => {
    const platform = (run.platform || "facebook") as string;
    return {
      id: run.id,
      kind: "lookup" as const,
      platform,
      platformLabel:
        PLATFORM_META[platform as AdPlatform]?.short || String(platform),
      title: run.queryName,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      count: run.adCount,
      countLabel: "ads",
      subtitle: run.selectedPage?.name
        ? `Matched: ${run.selectedPage.name}`
        : undefined,
    };
  });

  return [...searches, ...lookups]
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
    .slice(0, limit);
}
