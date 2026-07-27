"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";
import {
  defaultGeoForPlatform,
  geosForPlatform,
} from "@/lib/geo";
import type { BusinessProfile } from "@/lib/types";

interface SearchFormProps {
  platform: AdPlatform;
  onStarted: (
    jobId: string,
    keywords: string[],
    platform: AdPlatform,
  ) => void;
  disabled?: boolean;
}

export function SearchForm({ platform, onStarted, disabled }: SearchFormProps) {
  const [businessUrl, setBusinessUrl] = useState("");
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [keywordsText, setKeywordsText] = useState("");
  const [geo, setGeo] = useState(defaultGeoForPlatform(platform));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const geoOptions = useMemo(() => geosForPlatform(platform), [platform]);

  useEffect(() => {
    const opts = geosForPlatform(platform);
    setGeo((prev) =>
      opts.some((o) => o.code === prev)
        ? prev
        : defaultGeoForPlatform(platform),
    );
  }, [platform]);

  async function analyzeUrl() {
    setError(null);
    setAnalyzing(true);
    try {
      const res = await fetch("/api/business/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: businessUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to analyze URL");
      const next = data.profile as BusinessProfile;
      setProfile(next);
      setKeywordsText(
        (next.competitorKeywords || []).join("\n") || keywordsText,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: keywordsText,
          platform,
          geo,
          businessUrl: businessUrl.trim() || null,
          businessProfile: profile,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start search");
      onStarted(data.jobId, data.keywords ?? [data.keyword], data.platform);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const meta = PLATFORM_META[platform];

  return (
    <form onSubmit={handleSubmit} className="search-form">
      <label htmlFor="businessUrl" className="search-label">
        Business website URL
      </label>
      <div className="search-row url-analyze-row">
        <input
          id="businessUrl"
          type="url"
          value={businessUrl}
          onChange={(e) => setBusinessUrl(e.target.value)}
          placeholder="https://www.example.com"
          className="search-input"
          disabled={disabled || loading || analyzing}
        />
        <button
          type="button"
          className="ghost-btn"
          disabled={disabled || loading || analyzing || !businessUrl.trim()}
          onClick={() => void analyzeUrl()}
        >
          {analyzing ? "Analyzing…" : "Analyze with Perplexity"}
        </button>
      </div>
      <p className="form-hint">
        OpenRouter → Perplexity Sonar researches the site and detects industry so
        competitor search matches that vertical (any industry, not just agencies).
      </p>

      {profile && (
        <div className="business-profile-card">
          <h3>{profile.businessName}</h3>
          <p className="muted">
            {profile.industry}
            {profile.subIndustry ? ` · ${profile.subIndustry}` : ""}
          </p>
          <p>{profile.description}</p>
          {profile.offerings?.length > 0 && (
            <div className="tags">
              {profile.offerings.slice(0, 8).map((o) => (
                <span key={o} className="tag">
                  {o}
                </span>
              ))}
            </div>
          )}
          <p className="form-hint">{profile.positioningSummary}</p>
          {profile.brandColors && (
            <div className="recreate-palette" aria-label="Brand colors from your site">
              {(
                [
                  ["Primary", profile.brandColors.primary],
                  ["Secondary", profile.brandColors.secondary],
                  ["Accent", profile.brandColors.accent],
                ] as const
              ).map(([label, hex]) => (
                <span key={label} className="recreate-swatch">
                  <i style={{ background: hex }} />
                  {label} {hex}
                </span>
              ))}
              {profile.brandAssets?.logoUrl ? (
                <span className="form-hint">Logo captured</span>
              ) : (
                <span className="form-hint">Logo pending / CDN fallback on recreate</span>
              )}
            </div>
          )}
        </div>
      )}

      <fieldset className="geo-fieldset">
        <legend className="search-label">
          Location / geography — {meta.short}
        </legend>
        <div className="geo-radio-grid" role="radiogroup">
          {geoOptions.map((opt) => (
            <label key={opt.code} className="geo-radio">
              <input
                type="radio"
                name={`geo-${platform}`}
                value={opt.code}
                checked={geo === opt.code}
                onChange={() => setGeo(opt.code)}
                disabled={disabled || loading}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor="keywords" className="search-label">
        Keywords — {meta.label}
      </label>
      <textarea
        id="keywords"
        value={keywordsText}
        onChange={(e) => setKeywordsText(e.target.value)}
        placeholder={
          "One per line or comma-separated\ne.g. dental implants\ninvisalign near me"
        }
        className="search-textarea"
        disabled={disabled || loading}
        required
        rows={4}
      />
      <p className="form-hint">
        Source: {meta.source}. Keywords auto-fill after URL analysis — edit
        freely before searching.
      </p>
      <div className="search-row">
        <button
          type="submit"
          className="search-btn"
          disabled={disabled || loading || !keywordsText.trim()}
        >
          {loading
            ? "Starting…"
            : `Find ${meta.short} competitors${profile ? ` in ${profile.industry}` : ""}`}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
