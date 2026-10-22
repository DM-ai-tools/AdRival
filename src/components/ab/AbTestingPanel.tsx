"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AbPage } from "@/lib/pipeline/awareness/abPages";
import type { StageCoverage } from "@/lib/pipeline/awareness/coverage";
import { AbPageCard } from "./AbPageCard";
import { CoverageStrip, STAGE_LABELS } from "./CoverageStrip";

type Source = { kind: "search" | "lookup"; id: string };
type RunItem = {
  id: string;
  kind: "search" | "lookup";
  title: string;
  updatedAt: string;
};
type AbData = {
  pages: AbPage[];
  coverage: { stages: StageCoverage[]; labelledCount: number };
  profileReady: boolean;
};

const key = (s: Source) => `${s.kind}:${s.id}`;
const STAGE_FILTERS = ["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware", "unclear"];
const AUDIENCE_FILTERS = ["newbie", "intermediate", "advanced", "unclear"];

export function AbTestingPanel({ defaultSource }: { defaultSource: Source | null }) {
  const router = useRouter();
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [source, setSource] = useState<Source | null>(defaultSource);
  const [data, setData] = useState<AbData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState("");
  const [audienceFilter, setAudienceFilter] = useState("");
  const [labelCount, setLabelCount] = useState<number | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [recreatingId, setRecreatingId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/history/unified");
        const body = await res.json();
        if (!live || !res.ok) return;
        const list: RunItem[] = (body.runs ?? []).slice();
        list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        setRuns(list);
        setSource((cur) => cur ?? (list[0] ? { kind: list[0].kind, id: list[0].id } : null));
      } catch {
        /* picker stays empty */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async (s: Source) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ab-testing?kind=${s.kind}&id=${encodeURIComponent(s.id)}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not load pages");
      setData(body);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load pages");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLabelCount(null);
    if (source) void load(source);
    else setData(null);
  }, [source, load]);

  const unlabelled = useMemo(
    () => (data?.pages ?? []).filter((p) => p.status === "completed" && !p.levels).length,
    [data],
  );

  const shown = useMemo(
    () =>
      (data?.pages ?? []).filter(
        (p) =>
          (!stageFilter || p.levels?.awarenessStage === stageFilter) &&
          (!audienceFilter || p.levels?.audienceLevel === audienceFilter),
      ),
    [data, stageFilter, audienceFilter],
  );

  async function startLabel() {
    if (!source) return;
    setLabelBusy(true);
    setError(null);
    try {
      // No confirm: the route only counts the pages, nothing is spent.
      const res = await fetch("/api/ab-testing/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, id: source.id }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Could not count pages");
      setLabelCount(body.count ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not count pages");
    } finally {
      setLabelBusy(false);
    }
  }

  async function confirmLabel() {
    if (!source) return;
    setLabelBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ab-testing/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, id: source.id, confirm: true }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Labelling failed");
      if (body.failed) setError(`${body.failed} page(s) could not be labelled.`);
      setLabelCount(null);
      await load(source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Labelling failed");
    } finally {
      setLabelBusy(false);
    }
  }

  async function recreate(page: AbPage) {
    setRecreatingId(page.id);
    setError(null);
    try {
      let competitorId = page.id;
      if (page.source === "lookupAd") {
        const call = (extra: Record<string, unknown>) =>
          fetch("/api/lookup/recreate-bridge", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ adId: page.id, ...extra }),
          });
        let res = await call({});
        let body = await res.json();
        if (res.ok && body.needsConfirm) {
          if (!window.confirm(`${body.message}\n\nRedesign anyway?`)) return;
          res = await call({ confirmRedesign: true });
          body = await res.json();
        }
        if (!res.ok) throw new Error(body.error || "Could not start recreate");
        competitorId = body.competitorId;
      }
      router.push(`/recreate/${encodeURIComponent(competitorId)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start recreate");
    } finally {
      setRecreatingId(null);
    }
  }

  return (
    <section className="panel ab-panel">
      <h2>A/B testing</h2>
      <label className="ab-picker">
        <span className="muted">Compare pages from</span>
        <select
          className="search-input"
          value={source ? key(source) : ""}
          onChange={(e) => {
            const [kind, ...rest] = e.target.value.split(":");
            setSource(e.target.value ? { kind: kind as Source["kind"], id: rest.join(":") } : null);
          }}
        >
          {!source ? <option value="">Choose a search or lookup</option> : null}
          {source && !runs.some((r) => key(r) === key(source)) ? (
            <option value={key(source)}>Current run</option>
          ) : null}
          {runs.map((r) => (
            <option key={key(r)} value={key(r)}>
              {r.kind === "lookup" ? "Lookup" : "Search"}: {r.title}
            </option>
          ))}
        </select>
      </label>

      {error ? (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
        </div>
      ) : null}

      {loading && !data ? <p className="muted">Loading pages…</p> : null}

      {data ? (
        <>
          <CoverageStrip
            coverage={data.coverage.stages}
            labelledCount={data.coverage.labelledCount}
            profileReady={data.profileReady}
            // TODO(Task 8): wire to POST /api/ab-testing/icp.
            onGenerate={undefined}
          />

          {unlabelled > 0 ? (
            <div className="notice ab-label-banner">
              {labelCount === null ? (
                <>
                  <p>
                    {unlabelled} {unlabelled === 1 ? "page" : "pages"} not labelled
                  </p>
                  <button type="button" className="link-btn" disabled={labelBusy} onClick={startLabel}>
                    {labelBusy ? "Checking…" : "Label all"}
                  </button>
                </>
              ) : (
                <>
                  <p>
                    {labelCount === 0
                      ? "Nothing to label."
                      : `This will label ${labelCount} ${labelCount === 1 ? "page" : "pages"} and use credits.`}
                  </p>
                  <span>
                    {labelCount > 0 ? (
                      <button type="button" className="ghost-btn" disabled={labelBusy} onClick={confirmLabel}>
                        {labelBusy ? "Labelling…" : "Confirm"}
                      </button>
                    ) : null}{" "}
                    <button
                      type="button"
                      className="link-btn"
                      disabled={labelBusy}
                      onClick={() => setLabelCount(null)}
                    >
                      Cancel
                    </button>
                  </span>
                </>
              )}
            </div>
          ) : null}

          {data.pages.length === 0 ? (
            <p className="muted">
              No landing pages have been analysed for this run yet. Run a search with page analysis in{" "}
              <a href="/?mode=search">Keyword search</a>, then come back to compare them.
            </p>
          ) : (
            <>
              <div className="ab-filters">
                <label>
                  <span className="muted">Awareness stage</span>
                  <select className="search-input" value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
                    <option value="">All</option>
                    {STAGE_FILTERS.map((s) => (
                      <option key={s} value={s}>
                        {STAGE_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="muted">Audience level</span>
                  <select
                    className="search-input"
                    value={audienceFilter}
                    onChange={(e) => setAudienceFilter(e.target.value)}
                  >
                    <option value="">All</option>
                    {AUDIENCE_FILTERS.map((s) => (
                      <option key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {shown.length === 0 ? (
                <p className="muted">No pages match these filters.</p>
              ) : (
                <ul className="ab-list">
                  {shown.map((p) => (
                    <AbPageCard
                      key={`${p.source}:${p.id}`}
                      page={p}
                      onRecreate={recreate}
                      onLabel={startLabel}
                      recreating={recreatingId === p.id}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : null}

      {!source && !loading ? (
        <p className="muted">Run a search or lookup first, then compare its pages here.</p>
      ) : null}
    </section>
  );
}
