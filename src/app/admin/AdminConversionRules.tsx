"use client";

import { useEffect, useMemo, useState } from "react";
import { CREDIT_SCALE } from "@/lib/accounting/units";
import { formatDateTime, providerLabel } from "@/lib/credits/display";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { ConversionRuleSet, ProviderRate } from "@/lib/types";
import { InlineNotice, adminFetch, type Notice } from "./adminUi";

/** Rate fields edited in the table, in credits. Other fields are kept as they are. */
const FIELDS: Array<{ key: keyof ProviderRate; label: string }> = [
  { key: "perRequest", label: "Per request" },
  { key: "perThousandInputTokens", label: "Per 1k input tokens" },
  { key: "perThousandOutputTokens", label: "Per 1k output tokens" },
  { key: "perImage", label: "Per image" },
];

type Row = {
  provider: string;
  model: string;
  values: Record<string, string>;
  /** Fields not shown in the table (prices in USD, fallback estimates). */
  rest: Partial<ProviderRate>;
};

function toCredits(subunits: number | undefined): string {
  if (subunits === undefined || subunits === null) return "";
  return String(Number((subunits / CREDIT_SCALE).toFixed(6)));
}

function toSubunits(credits: string): number | undefined {
  const t = credits.trim();
  if (!t) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * CREDIT_SCALE) : NaN;
}

function rowsFrom(set: ConversionRuleSet): Row[] {
  const rows: Row[] = [];
  for (const [provider, models] of Object.entries(set.rates)) {
    for (const [model, rate] of Object.entries(models)) {
      const values: Record<string, string> = {};
      const rest: Partial<ProviderRate> = { ...rate };
      for (const f of FIELDS) {
        values[f.key] = toCredits(rate[f.key] as number | undefined);
        delete rest[f.key];
      }
      rows.push({ provider, model, values, rest });
    }
  }
  return rows.sort((a, b) => a.provider.localeCompare(b.provider) || (a.model === "default" ? -1 : b.model === "default" ? 1 : a.model.localeCompare(b.model)));
}

function buildRates(rows: Row[]): { rates: ConversionRuleSet["rates"]; problems: string[] } {
  const rates: ConversionRuleSet["rates"] = {};
  const problems: string[] = [];
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) {
      problems.push(`${providerLabel(row.provider, "admin")}: a model rate has no name.`);
      continue;
    }
    const rate: ProviderRate = { ...row.rest };
    for (const f of FIELDS) {
      const v = toSubunits(row.values[f.key] ?? "");
      if (v === undefined) continue;
      if (!Number.isFinite(v) || v < 0) {
        problems.push(`${providerLabel(row.provider, "admin")} / ${model}: ${f.label} must be 0 or more.`);
        continue;
      }
      (rate as Record<string, number>)[f.key] = v;
    }
    rates[row.provider] = { ...(rates[row.provider] ?? {}), [model]: rate };
  }
  return { rates, problems };
}

/** Human list of what changed between two rule sets. */
function describeChanges(
  before: ConversionRuleSet,
  rates: ConversionRuleSet["rates"],
  ceilings: Record<string, number>,
): string[] {
  const out: string[] = [];
  const providers = new Set([...Object.keys(before.rates), ...Object.keys(rates)]);
  for (const p of providers) {
    const name = providerLabel(p, "admin");
    const oldModels = before.rates[p] ?? {};
    const newModels = rates[p] ?? {};
    for (const m of new Set([...Object.keys(oldModels), ...Object.keys(newModels)])) {
      const a = oldModels[m];
      const b = newModels[m];
      if (!a) {
        out.push(`${name} / ${m}: new rate`);
        continue;
      }
      if (!b) {
        out.push(`${name} / ${m}: removed`);
        continue;
      }
      for (const f of FIELDS) {
        if ((a[f.key] ?? null) !== (b[f.key] ?? null)) {
          out.push(`${name} / ${m}: ${f.label} ${toCredits(a[f.key] as number) || "none"} → ${toCredits(b[f.key] as number) || "none"} credits`);
        }
      }
    }
    if ((before.perCallReservationCeiling[p] ?? null) !== (ceilings[p] ?? null)) {
      out.push(`${name}: hold per call ${toCredits(before.perCallReservationCeiling[p])} → ${toCredits(ceilings[p])} credits`);
    }
  }
  return out;
}

export default function AdminConversionRules({
  sets,
  activeVersion,
  onPublished,
}: {
  sets: ConversionRuleSet[];
  activeVersion: number;
  onPublished: () => Promise<void> | void;
}) {
  // Newest first, whatever order the server sent.
  const ordered = useMemo(() => [...sets].sort((a, b) => b.version - a.version), [sets]);
  const active = ordered.find((s) => s.version === activeVersion) ?? ordered[0];
  const [baseVersion, setBaseVersion] = useState(active?.version ?? 1);
  const base = ordered.find((s) => s.version === baseVersion) ?? active;
  const [rows, setRows] = useState<Row[]>(() => (base ? rowsFrom(base) : []));
  const [ceilings, setCeilings] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [review, setReview] = useState<{ changes: string[]; rates: ConversionRuleSet["rates"]; ceiling: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset the table only when a different version is picked or a new one is
  // published, not when the page reloads settings for another form.
  useEffect(() => {
    if (!base) return;
    setRows(rowsFrom(base));
    setCeilings(Object.fromEntries(Object.entries(base.perCallReservationCeiling).map(([p, v]) => [p, toCredits(v)])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base?.version, sets.length]);

  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))], [rows]);

  function update(index: number, patch: Partial<Row>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function startReview() {
    setNotice(null);
    const { rates, problems } = buildRates(rows);
    const ceiling: Record<string, number> = {};
    for (const [p, v] of Object.entries(ceilings)) {
      const n = toSubunits(v);
      if (n === undefined) continue;
      if (!Number.isFinite(n) || n < 0) problems.push(`${providerLabel(p, "admin")}: the hold per call must be 0 or more.`);
      else ceiling[p] = n;
    }
    if (problems.length) {
      setNotice({ tone: "error", text: problems.slice(0, 4).join(" ") });
      return;
    }
    const changes = active ? describeChanges(active, rates, ceiling) : [];
    if (!changes.length) {
      setNotice({ tone: "error", text: "Nothing has changed compared with the active rules." });
      return;
    }
    setReview({ changes, rates, ceiling });
  }

  async function publish() {
    if (!review) return;
    setBusy(true);
    try {
      const json = await adminFetch<{ ruleSet: { version: number } }>("/api/admin/settings", {
        method: "POST",
        json: { rates: review.rates, perCallReservationCeiling: review.ceiling, note },
      });
      setNotice({ tone: "ok", text: `Published v${json.ruleSet.version}. Charges already made keep the rules they were priced with.` });
      setNote("");
      setReview(null);
      await onPublished();
      setBaseVersion(json.ruleSet.version);
    } catch (err) {
      setNotice({ tone: "error", text: (err as Error).message });
      setReview(null);
    } finally {
      setBusy(false);
    }
  }

  if (!active) return <p className="empty-hint">No conversion rules yet.</p>;

  return (
    <>
      <p className="muted">
        Rates turn measured provider usage into credits. Publishing makes a new version; charges already made keep the
        version they were priced with. Active version: <strong>v{active.version}</strong>.
      </p>
      <label className="admin-field admin-inline-form">
        <span className="search-label">Start from</span>
        <select className="search-input" value={baseVersion} onChange={(e) => setBaseVersion(Number(e.target.value))}>
          {ordered.map((s) => (
            <option key={s.version} value={s.version}>
              v{s.version}
              {s.version === active.version ? " (active)" : ""} · {formatDateTime(s.createdAt)}
              {s.note ? ` · ${s.note}` : ""}
            </option>
          ))}
        </select>
      </label>
      {baseVersion !== active.version ? (
        <p className="form-hint">Editing from an older version. Publishing it makes those rates active again.</p>
      ) : null}

      {providers.map((p) => (
        <div key={p} className="admin-rates-provider">
          <div className="progress-head">
            <h4>{providerLabel(p, "admin")}</h4>
            <label className="admin-inline-form">
              <span className="search-label">Hold per call</span>
              <input
                className="search-input admin-num"
                value={ceilings[p] ?? ""}
                onChange={(e) => setCeilings((prev) => ({ ...prev, [p]: e.target.value }))}
                inputMode="decimal"
                aria-label={`${providerLabel(p, "admin")} hold per call in credits`}
              />
              <span className="muted">credits</span>
            </label>
          </div>
          <div className="table-wrap">
            <table className="comp-table">
              <thead>
                <tr>
                  <th>Model</th>
                  {FIELDS.map((f) => (
                    <th key={f.key}>{f.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) =>
                  row.provider !== p ? null : (
                    <tr key={`${p}-${i}`}>
                      <td>
                        {row.model === "default" ? (
                          <span>All other models</span>
                        ) : (
                          <input
                            className="search-input"
                            value={row.model}
                            onChange={(e) => update(i, { model: e.target.value })}
                            aria-label="Model name"
                          />
                        )}
                      </td>
                      {FIELDS.map((f) => (
                        <td key={f.key}>
                          <input
                            className="search-input admin-num"
                            value={row.values[f.key] ?? ""}
                            onChange={(e) => update(i, { values: { ...row.values, [f.key]: e.target.value } })}
                            inputMode="decimal"
                            placeholder="—"
                            aria-label={`${row.model} ${f.label}`}
                          />
                        </td>
                      ))}
                      <td>
                        {row.model !== "default" ? (
                          <button type="button" className="link-btn" onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}>
                            Remove
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            className="link-btn"
            onClick={() => setRows((prev) => [...prev, { provider: p, model: "", values: {}, rest: {} }])}
          >
            + Add a rate for one model
          </button>
        </div>
      ))}

      <label className="admin-field">
        <span className="search-label">Note for this version</span>
        <input className="search-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why these rates changed" />
      </label>
      <InlineNotice notice={notice} onDismiss={() => setNotice(null)} />
      <button type="button" className="search-btn" onClick={startReview} disabled={busy}>
        Review and publish…
      </button>

      {review ? (
        <ConfirmDialog
          open
          title={`Publish ${review.changes.length} change${review.changes.length === 1 ? "" : "s"}?`}
          description={`${review.changes.slice(0, 8).join(" · ")}${review.changes.length > 8 ? ` · and ${review.changes.length - 8} more` : ""}. New charges use these rates straight away.`}
          confirmLabel="Publish"
          tone="danger"
          busy={busy}
          onConfirm={() => void publish()}
          onCancel={() => setReview(null)}
        />
      ) : null}
    </>
  );
}
