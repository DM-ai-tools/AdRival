// Pure helpers for the A/B tab's run picker: dates, grouping and search.

export type RunItem = {
  id: string;
  kind: "search" | "lookup";
  title: string;
  status?: string;
  createdAt: string;
  updatedAt?: string;
  count?: number;
  countLabel?: string;
  subtitle?: string;
  platformLabel?: string;
};

export type RunGroup = { heading: "Keyword searches" | "Competitor lookups"; runs: RunItem[] };

/** "28 Sep 2026, 2:05 pm" in the viewer's locale, plus "24 days ago". */
export function formatRunDate(
  iso: string | null | undefined,
  now: Date = new Date(),
): { label: string; relative: string } {
  if (!iso) return { label: "", relative: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: "", relative: "" };
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.max(0, Math.round((startOf(now) - startOf(d)) / 86_400_000));
  const relative = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return { label: `${date}, ${time}`.replace(/\s?([AP]M)$/, (_m, s: string) => ` ${s.toLowerCase()}`), relative };
}

const time = (r: RunItem) => {
  const t = new Date(r.createdAt).getTime();
  return Number.isNaN(t) ? 0 : t;
};

export function groupRuns(runs: RunItem[]): RunGroup[] {
  const make = (kind: RunItem["kind"], heading: RunGroup["heading"]): RunGroup => ({
    heading,
    runs: runs.filter((r) => r.kind === kind).sort((a, b) => time(b) - time(a)),
  });
  return [make("search", "Keyword searches"), make("lookup", "Competitor lookups")].filter(
    (g) => g.runs.length > 0,
  );
}

export function filterRuns(runs: RunItem[], query: string): RunItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return runs;
  return runs.filter((r) => {
    const hay = [r.title, r.subtitle ?? "", formatRunDate(r.createdAt).label].join(" ").toLowerCase();
    return hay.includes(q);
  });
}
