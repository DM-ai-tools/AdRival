"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatCredits, subunitsToCredits } from "@/lib/accounting/units";
import { formatDateTime, providerLabel } from "@/lib/credits/display";
import { CreditAllotmentGuide } from "@/components/CreditAllotmentGuide";
import type { AppSettings, ConversionRuleSet, ProviderId } from "@/lib/types";

interface SettingsPayload {
  settings: AppSettings;
  conversionRuleSets: ConversionRuleSet[];
  providers: readonly ProviderId[];
  providerKeyConfigured: Record<string, boolean>;
}

export default function AdminSettings() {
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [publicSignupEnabled, setPublicSignupEnabled] = useState(false);
  const [defaultAllowance, setDefaultAllowance] = useState("0");
  const [defaultResetCadence, setDefaultResetCadence] = useState("none");
  const [lowCreditWarning, setLowCreditWarning] = useState("0");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState("2");
  const [maxRunReservation, setMaxRunReservation] = useState("0");
  const [disabledProviders, setDisabledProviders] = useState<string[]>([]);
  const [disabledModels, setDisabledModels] = useState("");

  const [rulesJson, setRulesJson] = useState("");
  const [ceilingJson, setCeilingJson] = useState("");
  const [ruleNote, setRuleNote] = useState("");
  const [publishing, setPublishing] = useState(false);

  const applySettings = useCallback((payload: SettingsPayload) => {
    const s = payload.settings;
    setPublicSignupEnabled(s.publicSignupEnabled);
    setDefaultAllowance(String(subunitsToCredits(s.defaultAllowanceSubunits)));
    setDefaultResetCadence(s.defaultResetCadence);
    setLowCreditWarning(
      String(subunitsToCredits(s.lowCreditWarningSubunits)),
    );
    setMaxConcurrentRuns(String(s.maxConcurrentRunsPerUser));
    setMaxRunReservation(
      String(subunitsToCredits(s.maxRunReservationSubunits)),
    );
    setDisabledProviders(s.disabledProviders ?? []);
    setDisabledModels((s.disabledModels ?? []).join("\n"));

    const active =
      payload.conversionRuleSets.find(
        (r) => r.version === s.activeConversionRuleVersion,
      ) ?? payload.conversionRuleSets[0];
    if (active) {
      setRulesJson(JSON.stringify(active.rates, null, 2));
      setCeilingJson(JSON.stringify(active.perCallReservationCeiling, null, 2));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load settings");
      setData(json as SettingsPayload);
      applySettings(json as SettingsPayload);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSignupEnabled,
          defaultAllowanceCredits: defaultAllowance,
          defaultResetCadence,
          lowCreditWarningCredits: lowCreditWarning,
          maxConcurrentRunsPerUser: Number(maxConcurrentRuns),
          maxRunReservationCredits: maxRunReservation,
          disabledProviders,
          disabledModels: disabledModels
            .split("\n")
            .map((m) => m.trim())
            .filter(Boolean),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to save settings");
      setSuccess("Settings saved.");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function publishRules(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    let rates: unknown;
    let ceiling: unknown;
    try {
      rates = JSON.parse(rulesJson);
    } catch {
      setError("Conversion rates must be valid JSON.");
      return;
    }
    try {
      ceiling = JSON.parse(ceilingJson);
    } catch {
      setError("Per-call reservation ceilings must be valid JSON.");
      return;
    }

    setPublishing(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rates,
          perCallReservationCeiling: ceiling,
          note: ruleNote,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to publish rules");
      setSuccess(
        `Published conversion rules v${json.ruleSet.version}. Existing charges keep their original version.`,
      );
      setRuleNote("");
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  if (loading && !data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="muted">Loading settings…</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="panel glow-panel admin-panel">
        <p className="error-text" role="alert">
          {error ?? "Could not load settings."}
        </p>
      </section>
    );
  }

  return (
    <>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className="credits-pending">{success}</p> : null}

      <section className="panel glow-panel admin-panel">
        <h2>Global settings</h2>
        <CreditAllotmentGuide />
        <form onSubmit={(e) => void saveSettings(e)}>
          <div className="admin-settings-stack">
            <label className="admin-checkbox">
              <input
                type="checkbox"
                checked={publicSignupEnabled}
                onChange={(e) => setPublicSignupEnabled(e.target.checked)}
                disabled={saving}
              />
              <span>
                Allow public signup (new accounts are always regular users)
              </span>
            </label>

            <div className="admin-setting-row">
              <label className="admin-field">
                <span className="search-label">Default allowance for new users</span>
                <span className="admin-input-unit">
                  <input
                    className="search-input"
                    value={defaultAllowance}
                    onChange={(e) => setDefaultAllowance(e.target.value)}
                    inputMode="decimal"
                    disabled={saving}
                  />
                  <span>credits</span>
                </span>
              </label>
              <p className="form-hint">
                What a new signup starts with. 0 means they cannot run until you
                set an allowance. Administrators are not limited by credits.
              </p>
            </div>

            <div className="admin-setting-row">
              <label className="admin-field">
                <span className="search-label">Default reset schedule</span>
                <select
                  className="search-input"
                  value={defaultResetCadence}
                  onChange={(e) => setDefaultResetCadence(e.target.value)}
                  disabled={saving}
                >
                  <option value="none">Manual allocation — no automatic reset</option>
                  <option value="monthly">Monthly — unused allowance expires, history is kept</option>
                </select>
              </label>
            </div>

            <div className="admin-setting-row">
              <label className="admin-field">
                <span className="search-label">Low-credit warning</span>
                <span className="admin-input-unit">
                  <input
                    className="search-input"
                    value={lowCreditWarning}
                    onChange={(e) => setLowCreditWarning(e.target.value)}
                    inputMode="decimal"
                    disabled={saving}
                  />
                  <span>credits</span>
                </span>
              </label>
              <p className="form-hint">
                Show an in-app warning when remaining credits fall to this number
                or below. No email is sent.
              </p>
            </div>

            <div className="admin-setting-row">
              <label className="admin-field">
                <span className="search-label">Concurrent runs per user</span>
                <span className="admin-input-unit">
                  <input
                    className="search-input"
                    value={maxConcurrentRuns}
                    onChange={(e) => setMaxConcurrentRuns(e.target.value)}
                    inputMode="numeric"
                    disabled={saving}
                  />
                  <span>runs</span>
                </span>
              </label>
              <p className="form-hint">
                How many paid tasks one person may have running at the same time.
              </p>
            </div>

            <div className="admin-setting-row">
              <label className="admin-field">
                <span className="search-label">Hard cap per run</span>
                <span className="admin-input-unit">
                  <input
                    className="search-input"
                    value={maxRunReservation}
                    onChange={(e) => setMaxRunReservation(e.target.value)}
                    inputMode="decimal"
                    disabled={saving}
                  />
                  <span>credits</span>
                </span>
              </label>
              <p className="form-hint">
                A run stops before it can reserve more than this. Does not apply
                to administrators.
              </p>
            </div>
          </div>

          <h3>Provider restrictions</h3>
          <p className="muted">
            Disabling a provider blocks it for every user. Per-user provider and
            model restrictions are set on the individual account.
          </p>
          <div className="admin-provider-grid">
            {data.providers.map((id) => (
              <label key={id} className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={disabledProviders.includes(id)}
                  onChange={(e) =>
                    setDisabledProviders((prev) =>
                      e.target.checked
                        ? [...prev, id]
                        : prev.filter((p) => p !== id),
                    )
                  }
                  disabled={saving}
                />
                <span>
                  Disable {providerLabel(id, "admin")}
                  {data.providerKeyConfigured[id] ? "" : " (no key configured)"}
                </span>
              </label>
            ))}
          </div>

          <label className="admin-field">
            <span className="search-label">
              Blocked models — one per line
            </span>
            <textarea
              className="search-textarea"
              rows={3}
              value={disabledModels}
              onChange={(e) => setDisabledModels(e.target.value)}
              disabled={saving}
            />
          </label>

          <div className="admin-actions-row" style={{ marginTop: 12 }}>
            <button type="submit" className="search-btn" disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </form>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Credit conversion rules</h2>
        <p className="muted">
          Rates convert measured provider usage into application credits. Rules
          are versioned: publishing a new version never alters historical
          charges, which keep the version they were priced with. Monetary prices
          are optional — leave them out and estimated cost reads &ldquo;No price
          configured&rdquo; instead of $0.
        </p>
        <p className="muted">
          Active version: <strong>v{data.settings.activeConversionRuleVersion}</strong>
        </p>

        <form onSubmit={(e) => void publishRules(e)}>
          <label className="admin-field">
            <span className="search-label">
              Rates — provider → &ldquo;default&rdquo; or model key → rate
            </span>
            <textarea
              className="search-textarea"
              rows={16}
              value={rulesJson}
              onChange={(e) => setRulesJson(e.target.value)}
              spellCheck={false}
              disabled={publishing}
            />
          </label>
          <label className="admin-field">
            <span className="search-label">
              Per-call reservation ceiling (subunits per provider)
            </span>
            <textarea
              className="search-textarea"
              rows={9}
              value={ceilingJson}
              onChange={(e) => setCeilingJson(e.target.value)}
              spellCheck={false}
              disabled={publishing}
            />
          </label>
          <label className="admin-field">
            <span className="search-label">Note for this version</span>
            <input
              className="search-input"
              value={ruleNote}
              onChange={(e) => setRuleNote(e.target.value)}
              placeholder="Why these rates changed"
              disabled={publishing}
            />
          </label>
          <div className="admin-actions-row" style={{ marginTop: 12 }}>
            <button type="submit" className="search-btn" disabled={publishing}>
              {publishing ? "Publishing…" : "Publish new version"}
            </button>
          </div>
        </form>

        <h3>Published versions</h3>
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Created</th>
                <th>Note</th>
                <th>Providers priced</th>
              </tr>
            </thead>
            <tbody>
              {data.conversionRuleSets.map((set) => (
                <tr key={set.version}>
                  <td>
                    v{set.version}
                    {set.version === data.settings.activeConversionRuleVersion
                      ? " (active)"
                      : ""}
                  </td>
                  <td className="admin-nowrap">
                    {formatDateTime(set.createdAt)}
                  </td>
                  <td className="muted">{set.note ?? "—"}</td>
                  <td>{Object.keys(set.rates).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Provider credentials</h2>
        <p className="muted">
          Keys are read from server environment variables and are never sent to
          the browser, written to exports, or included in audit logs. This shows
          only whether each key is present.
        </p>
        <div className="table-wrap">
          <table className="comp-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Key configured</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((id) => (
                <tr key={id}>
                  <td>{providerLabel(id, "admin")}</td>
                  <td>
                    {data.providerKeyConfigured[id] ? (
                      <span className="status-pill status-completed">Yes</span>
                    ) : (
                      <span className="status-pill status-partial">No</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Current defaults summary</h2>
        <dl className="progress-stats">
          <div>
            <dt>Public signup</dt>
            <dd>{data.settings.publicSignupEnabled ? "On" : "Off"}</dd>
          </div>
          <div>
            <dt>Default allowance</dt>
            <dd>{formatCredits(data.settings.defaultAllowanceSubunits)}</dd>
          </div>
          <div>
            <dt>Low-credit warning</dt>
            <dd>{formatCredits(data.settings.lowCreditWarningSubunits)}</dd>
          </div>
          <div>
            <dt>Per-run cap</dt>
            <dd>{formatCredits(data.settings.maxRunReservationSubunits)}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatDateTime(data.settings.updatedAt)}</dd>
          </div>
        </dl>
      </section>
    </>
  );
}
