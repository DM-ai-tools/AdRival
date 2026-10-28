"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AbPage } from "@/lib/pipeline/awareness/abPages";
import { pickDisplayedBase } from "@/lib/pipeline/awareness/icpText";
import type { IcpRecord } from "@/lib/types";
import type { StageCoverage } from "@/lib/pipeline/awareness/coverage";
import type { RunItem } from "@/lib/pipeline/awareness/runLabels";
import { AbPageCard } from "./AbPageCard";
import { RunPicker } from "./RunPicker";
import { CoverageStrip, STAGE_LABELS } from "./CoverageStrip";
import { IcpDrawer } from "./IcpDrawer";
import { inFlightKey, stageInFlight, tryAddInFlight } from "@/lib/pipeline/awareness/inFlight";
import { defaultDetails } from "@/lib/recreateClient";
import type { RecreateSource } from "@/components/recreate/AddToRecreateButton";

// Module scope on purpose: a paid request keeps its guard while the user
// switches sources or leaves the tab, and only its own finally clears it.
const icpInFlight = new Set<string>();
const labelInFlight = new Set<string>();

type Source = { kind: "search" | "lookup"; id: string };
type AbData = {
  pages: AbPage[];
  coverage: { stages: StageCoverage[]; labelledCount: number };
  profileReady: boolean;
  icps?: IcpRecord[];
  baseForStage?: Record<string, AbPage | null>;
  /** The run's client website, the "Add to Recreate" default. */
  businessUrl?: string | null;
};

const key = (s: Source) => `${s.kind}:${s.id}`;
const STAGE_FILTERS = ["unaware", "problem_aware", "solution_aware", "product_aware", "most_aware", "unclear"];
const AUDIENCE_FILTERS = ["newbie", "intermediate", "advanced", "unclear"];

export function AbTestingPanel({
  defaultSource,
  spaceId = null,
  spaceName = null,
}: {
  defaultSource: Source | null;
  /** Active client space; when set, only that space's runs are offered. */
  spaceId?: string | null;
  spaceName?: string | null;
}) {
  const [allRuns, setAllRuns] = useState<RunItem[]>([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [source, setSource] = useState<Source | null>(defaultSource);
  const [data, setData] = useState<AbData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stageFilter, setStageFilter] = useState("");
  const [audienceFilter, setAudienceFilter] = useState("");
  const [labelCount, setLabelCount] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  // Drawer for one stage's ICP. baseId is the user's "Change page" pick.
  const [drawer, setDrawer] = useState<{ stage: string; baseId: string | null } | null>(null);
  const [icpError, setIcpError] = useState<string | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Bumped on every source change and every load; a response only applies
  // while its number is still current, so a slow older request is dropped.
  const loadSeq = useRef(0);
  const sourceKey = useRef<string>(defaultSource ? key(defaultSource) : "");
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/history/unified");
        const body = await res.json();
        if (!live || !res.ok) return;
        const list: RunItem[] = (body.runs ?? []).slice();
        list.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
        setAllRuns(list);
      } catch {
        /* picker stays empty */
      } finally {
        if (live) setRunsLoaded(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Only the active client space's runs, so everything here belongs to that workspace.
  const runs = useMemo(
    () => (spaceId ? allRuns.filter((r) => r.spaceId === spaceId) : allRuns),
    [allRuns, spaceId],
  );

  // Keep the selection inside the scope: default to the newest run, drop one from another space.
  useEffect(() => {
    if (!runsLoaded) return;
    setSource((cur) => {
      if (cur && runs.some((r) => r.kind === cur.kind && r.id === cur.id)) return cur;
      return runs[0] ? { kind: runs[0].kind, id: runs[0].id } : null;
    });
  }, [runs, runsLoaded]);

  const load = useCallback(async (s: Source) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/ab-testing?kind=${s.kind}&id=${encodeURIComponent(s.id)}`);
      const body = await res.json();
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(body.error || "Could not load pages");
      setData(body);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load pages");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    sourceKey.current = source ? key(source) : "";
    setLabelCount(null);
    setData(null);
    setError(null);
    setStageFilter("");
    setAudienceFilter("");
    setDrawer(null);
    setIcpError(null);
    if (source) void load(source);
    else setLoading(false);
    return () => {
      loadSeq.current += 1; // invalidate anything still in flight for this source
    };
  }, [source, load]);

  const generatingStage = source ? stageInFlight(icpInFlight, source) : null;
  const labelBusy = source ? labelInFlight.has(inFlightKey(source, "label")) : false;

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
    const forKey = key(source);
    const busyKey = inFlightKey(source, "label");
    if (!tryAddInFlight(labelInFlight, busyKey)) return;
    bump();
    setError(null);
    try {
      // No confirm: the route only counts the pages, nothing is spent.
      const res = await fetch("/api/ab-testing/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, id: source.id }),
      });
      const body = await res.json();
      if (forKey !== sourceKey.current) return;
      if (!res.ok) throw new Error(body.error || "Could not count pages");
      setLabelCount(body.count ?? 0);
      // Bring the confirm banner into view; the list can be long.
      setTimeout(() => {
        bannerRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        bannerRef.current?.focus();
      }, 0);
    } catch (e) {
      if (forKey === sourceKey.current) setError(e instanceof Error ? e.message : "Could not count pages");
    } finally {
      labelInFlight.delete(busyKey);
      bump();
    }
  }

  async function confirmLabel() {
    if (!source) return;
    const forKey = key(source);
    const busyKey = inFlightKey(source, "label");
    if (!tryAddInFlight(labelInFlight, busyKey)) return;
    bump();
    setError(null);
    try {
      const res = await fetch("/api/ab-testing/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, id: source.id, confirm: true }),
      });
      const body = await res.json();
      if (forKey !== sourceKey.current) return;
      if (!res.ok) throw new Error(body.error || "Labelling failed");
      setLabelCount(null);
      await load(source);
      if (body.failed && forKey === sourceKey.current) {
        setError(`${body.failed} page(s) could not be labelled.`);
      }
    } catch (e) {
      if (forKey === sourceKey.current) setError(e instanceof Error ? e.message : "Labelling failed");
    } finally {
      labelInFlight.delete(busyKey);
      bump();
    }
  }

  /** What "Add to Recreate" queues for a page of this run. */
  function recreateSourceFor(page: AbPage): RecreateSource | null {
    // Dashboard pages go through the search run; the queue analyses them first if needed.
    if (page.origin === "offers") return source?.kind === "search" ? { runId: source.id, url: page.url } : null;
    if (page.source === "lookupAd") return { lookupAdId: page.id };
    return { competitorId: page.id };
  }
  const recreateDefaults = defaultDetails({ businessUrl: data?.businessUrl });

  function openDrawer(stage: string, opener: HTMLElement) {
    openerRef.current = opener;
    setIcpError(null);
    setDrawer({ stage, baseId: null });
  }

  function closeDrawer() {
    setDrawer(null);
    setIcpError(null);
    const el = openerRef.current;
    openerRef.current = null;
    // Wait for the drawer to unmount, then hand focus back to the chip.
    setTimeout(() => {
      if (el && el.isConnected) el.focus();
    }, 0);
  }

  // Spends credits. Only reached from an explicit Generate / Regenerate click; Regenerate writes a new one.
  async function generateIcp(stage: string, notes?: string) {
    if (!source) return;
    const flightKey = inFlightKey(source, stage);
    if (!tryAddInFlight(icpInFlight, flightKey)) return;
    const forKey = key(source);
    bump();
    setIcpError(null);
    // The old profile is hidden while the new one is written, so a stale one is never shown as current.
    setData((d) => (d ? { ...d, icps: (d.icps ?? []).filter((i) => i.stage !== stage) } : d));
    try {
      const res = await fetch("/api/ab-testing/icp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: source.kind, id: source.id, stage, notes: notes ?? "" }),
      });
      let body: { icp?: IcpRecord; error?: string } = {};
      try {
        body = await res.json();
      } catch {
        /* non-JSON error body */
      }
      if (forKey !== sourceKey.current) return;
      if (!res.ok || !body.icp) {
        throw new Error(body.error || "Could not generate the ICP");
      }
      const icp = body.icp;
      setData((d) =>
        d ? { ...d, icps: [...(d.icps ?? []).filter((i) => i.stage !== icp.stage), icp] } : d,
      );
    } catch (e) {
      if (forKey === sourceKey.current) {
        setIcpError(e instanceof Error ? e.message : "Could not generate the ICP");
      }
    } finally {
      icpInFlight.delete(flightKey);
      bump();
    }
  }

  const drawerIcp = drawer ? ((data?.icps ?? []).find((i) => i.stage === drawer.stage) ?? null) : null;
  const drawerBase = drawer
    ? pickDisplayedBase(data?.baseForStage?.[drawer.stage], data?.pages ?? [], drawer.baseId)
    : null;

  return (
    <section className="panel ab-panel">
      <h2>A/B testing</h2>
      {spaceId ? (
        <p className="muted">Showing runs from {spaceName || "this client space"} only.</p>
      ) : null}
      <RunPicker
        runs={runs}
        value={source}
        onSelect={(r) => setSource((cur) => (cur && key(cur) === key(r) ? cur : { kind: r.kind, id: r.id }))}
      />
      {data ? (
        <p className="muted ab-summary">
          {(() => {
            const n = data.pages.length;
            const comp = data.pages.filter((p) => p.origin === "competitor").length;
            const off = data.pages.filter((p) => p.origin === "offers").length;
            const parts = [
              comp ? `${comp} from competitors` : "",
              off ? `${off} from the offers dashboard` : "",
            ].filter(Boolean);
            return `Showing ${n} ${n === 1 ? "page" : "pages"}${parts.length ? ` · ${parts.join(" · ")}` : ""}`;
          })()}
        </p>
      ) : null}

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
            icpStages={(data.icps ?? []).map((i) => i.stage)}
            generatingStage={generatingStage}
            onGenerate={(stage, el) => {
              openDrawer(stage, el);
              void generateIcp(stage);
            }}
            onView={openDrawer}
          />

          {unlabelled > 0 ? (
            <div className="notice ab-label-banner" ref={bannerRef} tabIndex={-1}>
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
                      : `This will label all ${labelCount} unlabelled ${labelCount === 1 ? "page" : "pages"} in this run and use credits.`}
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
                      recreateSource={recreateSourceFor(p)}
                      recreateDefaults={recreateDefaults}
                      onLabel={startLabel}
                      labelAllCount={unlabelled}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      ) : null}

      {drawer && data ? (
        <IcpDrawer
          stage={drawer.stage}
          icp={drawerIcp}
          generating={generatingStage === drawer.stage}
          error={icpError}
          basePage={drawerBase}
          pages={data.pages}
          recreateSource={drawerBase ? recreateSourceFor(drawerBase) : null}
          recreateDefaults={recreateDefaults}
          onRegenerate={(notes) => void generateIcp(drawer.stage, notes)}
          onPickBase={(p) => setDrawer({ ...drawer, baseId: p.id })}
          onClose={closeDrawer}
        />
      ) : null}

      {!source && !loading ? (
        <p className="muted">
          {spaceId
            ? "No runs in this client space yet. Run a search or lookup here first, then compare its pages."
            : "Run a search or lookup first, then compare its pages here."}
        </p>
      ) : null}
    </section>
  );
}
