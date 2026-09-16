"use client";

import { useEffect, useState } from "react";
import {
  buildAllotmentGuide,
  type AllotmentGuide,
} from "@/lib/accounting/allotmentGuide";
import type { AppSettings, ConversionRuleSet } from "@/lib/types";

export function CreditAllotmentGuide() {
  const [guide, setGuide] = useState<AllotmentGuide | null>(null);

  useEffect(() => {
    void fetch("/api/admin/settings", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            settings?: AppSettings;
            conversionRuleSets?: ConversionRuleSet[];
          } | null,
        ) => {
          const settings = data?.settings;
          const rules = data?.conversionRuleSets ?? [];
          const active =
            rules.find((rule) => rule.version === settings?.activeConversionRuleVersion) ??
            rules[0];
          if (!active || !settings) return;
          setGuide(
            buildAllotmentGuide(active, settings.maxRunReservationSubunits),
          );
        },
      )
      .catch(() => setGuide(null));
  }, []);

  if (!guide) return null;

  return (
    <aside className="allotment-guide">
      <h3>How much to allot</h3>
      <p className="form-hint">
        Sample sizes from conversion rules v{guide.version}. Not this person’s
        usage — a planning guide for the allowance and the per-run cap.
      </p>
      <ul className="allotment-calls">
        {guide.calls.map((call) => (
          <li key={call.label}>
            <strong>{call.credits}</strong>
            <span>
              {call.label}
              <span className="muted">{call.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="allotment-plans">
        {guide.suggestions.map((plan) => (
          <div key={plan.name}>
            <strong>
              {plan.name} · {plan.credits} credits
            </strong>
            <p className="form-hint">{plan.fits}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}
