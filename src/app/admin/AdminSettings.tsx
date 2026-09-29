"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatCredits, subunitsToCredits } from "@/lib/accounting/units";
import { formatDateTime, providerLabel } from "@/lib/credits/display";
import { CreditAllotmentGuide } from "@/components/CreditAllotmentGuide";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import AdminConversionRules from "./AdminConversionRules";
import type { AppSettings, ConversionRuleSet, ProviderId } from "@/lib/types";

interface SettingsPayload {
  settings: AppSettings;
  conversionRuleSets: ConversionRuleSet[];
  providers: readonly ProviderId[];
  providerKeyConfigured: Record<string, boolean>;
  effectiveConversionRuleVersion?: number;
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

  const [confirmDisable, setConfirmDisable] = useState<string[] | null>(null);

  // Each form is refreshed only from its own save, so saving one never throws
  // away unsaved edits in the other.
  const applyGlobal = useCallback((payload: SettingsPayload) => {
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
  }, []);

  const load = useCallback(
    async (refresh: "all" | "global" | "rules" = "all") => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/settings", { cache: "no-store" });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load settings");
        setData(json as SettingsPayload);
        if (refresh !== "rules") applyGlobal(json as SettingsPayload);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [applyGlobal],
  );

  useEffect(() => {
    void load();
  }, [load]);

  function requestSave(e: FormEvent) {
    e.preventDefault();
    const newlyDisabled = disabledProviders.filter(
      (id) => !(data?.settings.disabledProviders ?? []).includes(id as never),
    );
    if (newlyDisabled.length) {
      setConfirmDisable(newlyDisabled);
      return;
    }
    void saveSettings();
  }

  async function saveSettings() {
    setConfirmDisable(null);
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
      await load("global");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
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

      <section className="panel glow-panel admin-panel">
        <h2>Global settings</h2>
        <CreditAllotmentGuide />
        <form onSubmit={requestSave}>
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
            Disabling a provider blocks it for every user. To limit one person,
            use the Limits tab on their account in Users.
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
            {success ? <span className="credits-pending" role="status">{success}</span> : null}
          </div>
        </form>
        {confirmDisable ? (
          <ConfirmDialog
            open
            title={`Turn off ${confirmDisable.map((id) => providerLabel(id, "admin")).join(", ")} for everyone?`}
            description="Every task that needs it will be refused for all users, including runs already queued, until you turn it back on."
            confirmLabel="Turn off and save"
            tone="danger"
            busy={saving}
            onConfirm={() => void saveSettings()}
            onCancel={() => setConfirmDisable(null)}
          />
        ) : null}
      </section>

      <section className="panel glow-panel admin-panel">
        <h2>Credit conversion rules</h2>
        <AdminConversionRules
          sets={data.conversionRuleSets}
          activeVersion={data.effectiveConversionRuleVersion ?? data.settings.activeConversionRuleVersion}
          onPublished={() => load("rules")}
        />
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
