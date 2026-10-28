import type { SearchCompetitorAdRecord } from "./types";
import { adDays, isActiveAd } from "./offerInsights";

type SignalAd = Partial<
  Pick<SearchCompetitorAdRecord, "daysRunning" | "startDateString" | "endDateString" | "isActive">
>;

/**
 * Decision signals for a landing page: the longest any of its ads has run and
 * how many are active, by the same rules the offer ranking uses. Unknown is
 * null, never 0.
 */
export function pageSignals(ads: SignalAd[]): { daysRunning: number | null; activeAds: number | null } {
  if (!ads.length) return { daysRunning: null, activeAds: null };
  const days = ads.map((ad) => adDays(ad as SearchCompetitorAdRecord)).filter((d): d is number => d !== null);
  return {
    daysRunning: days.length ? Math.max(...days) : null,
    activeAds: ads.filter((ad) => isActiveAd(ad as SearchCompetitorAdRecord)).length,
  };
}

/** A signal for display: "—" when it is not known. */
export function formatSignal(n: number | null): string {
  return n === null ? "—" : String(n);
}
