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
  /** Set by the API from the caller's project access — absent means unknown. */
  accessRole?: "owner" | "editor" | "viewer";
  ownerDisplayName?: string | null;
  spaceId?: string | null;
  clientName?: string | null;
};

/**
 * Newest searches and lookups, merged. `searchIds` / `lookupIds` limit the
 * list to those runs (the ones a user may see); without them every run counts.
 */
export async function listUnifiedHistory(
  limit = 150,
  options: { searchIds?: Iterable<string>; lookupIds?: Iterable<string> } = {},
): Promise<UnifiedHistoryItem[]> {
  const [searchRuns, lookupRuns] = await Promise.all([
    listHistoryRuns(limit, { ids: options.searchIds }),
    listLookupHistory(limit, { ids: options.lookupIds }),
  ]);
  const searches = searchRuns.map((run: HistoryRunSummary) => {
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
      subtitle: (() => {
        const parts: string[] = [];
        if (run.businessProfile?.businessName) {
          parts.push(run.businessProfile.businessName);
        } else if (run.businessUrl) {
          try {
            parts.push(new URL(run.businessUrl).hostname.replace(/^www\./, ""));
          } catch {
            parts.push(run.businessUrl);
          }
        }
        if (run.keywords?.length) {
          parts.push(`${run.keywords.length} keywords`);
        }
        return parts.length ? parts.join(" · ") : undefined;
      })(),
    };
  });

  const lookups = lookupRuns.map((run: LookupHistorySummary) => {
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
