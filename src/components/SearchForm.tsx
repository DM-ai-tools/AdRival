"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";
import {
  defaultGeoForPlatform,
  geosForPlatform,
} from "@/lib/geo";
import type {
  BusinessCategory,
  BusinessProfile,
  SearchGeoMode,
} from "@/lib/types";
import { buildKeywordsForCategory } from "@/lib/pipeline/keywordSuggestions";
import { resolveIndustrySop } from "@/lib/guardrails/industrySops";

type GuardrailChoice = "enforce" | "override" | "skip";

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
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [geoMode, setGeoMode] = useState<SearchGeoMode>("company_locations");
  const [geo, setGeo] = useState(defaultGeoForPlatform(platform));
  const [guardrailChoice, setGuardrailChoice] =
    useState<GuardrailChoice>("enforce");
  const [seekCompetitors, setSeekCompetitors] = useState("");
  const [guardrailNotes, setGuardrailNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const geoOptions = useMemo(() => geosForPlatform(platform), [platform]);
  const categories = profile?.categories?.length
    ? profile.categories
    : (profile?.offerings || []).map((o, i) => ({
        id: `offer-${i}`,
        label: o,
        type: (profile?.businessModel === "ecommerce"
          ? "product"
          : "service") as BusinessCategory["type"],
      }));

  const selectedCategory =
    categories.find((c) => c.id === selectedCategoryId) || null;

  const matchedSop = useMemo(() => {
    if (!profile) return null;
    return resolveIndustrySop({
      industry: profile.industry,
      subIndustry: profile.subIndustry,
      offerings: profile.offerings,
      description: profile.description,
      selectedCategory: selectedCategory?.label || null,
    });
  }, [profile, selectedCategory?.label]);

  useEffect(() => {
    const opts = geosForPlatform(platform);
    setGeo((prev) =>
      opts.some((o) => o.code === prev)
        ? prev
        : defaultGeoForPlatform(platform),
    );
  }, [platform]);

  useEffect(() => {
    // Reset override fields when a new URL profile is loaded
    if (profile) {
      setGuardrailChoice("enforce");
      setSeekCompetitors("");
      setGuardrailNotes("");
    }
  }, [profile?.url, profile?.businessName]);

  function applyCategoryKeywords(
    nextProfile: BusinessProfile,
    category: BusinessCategory,
    mode: SearchGeoMode,
  ) {
    const built = buildKeywordsForCategory({
      category,
      profile: nextProfile,
      geoMode: mode === "keyword_location" ? "company_locations" : mode,
    });
    setKeywordsText(built.join("\n"));
  }

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

      if (next.primaryMarketCountry) {
        const opts = geosForPlatform(platform);
        if (opts.some((o) => o.code === next.primaryMarketCountry)) {
          setGeo(next.primaryMarketCountry!);
        }
      }

      const cats = next.categories?.length
        ? next.categories
        : (next.offerings || []).map((o, i) => ({
            id: `offer-${i}`,
            label: o,
            type: (next.businessModel === "ecommerce"
              ? "product"
              : "service") as BusinessCategory["type"],
          }));
      const first = cats[0] || null;
      setSelectedCategoryId(first?.id || null);
      if (first) {
        applyCategoryKeywords(next, first, geoMode);
      } else {
        setKeywordsText((next.competitorKeywords || []).join("\n"));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }

  function onSelectCategory(cat: BusinessCategory) {
    setSelectedCategoryId(cat.id);
    if (profile) applyCategoryKeywords(profile, cat, geoMode);
  }

  function onGeoModeChange(mode: SearchGeoMode) {
    setGeoMode(mode);
    if (profile && selectedCategory) {
      applyCategoryKeywords(profile, selectedCategory, mode);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (
      guardrailChoice === "override" &&
      !seekCompetitors.trim() &&
      !guardrailNotes.trim()
    ) {
      setError(
        "Describe the competitor types you want, or switch back to industry SOP enforcement.",
      );
      return;
    }
    setLoading(true);
    try {
      const skipGuardrails = guardrailChoice === "skip";
      const guardrailOverride =
        guardrailChoice === "override"
          ? {
              enabled: true,
              seekCompetitors: seekCompetitors.trim() || null,
              notes: guardrailNotes.trim() || null,
            }
          : null;
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: keywordsText,
          platform,
          geo,
          geoMode,
          selectedCategory,
          businessUrl: businessUrl.trim() || null,
          businessProfile: profile,
          skipGuardrails,
          guardrailOverride,
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
  const deliveryLabel =
    profile?.serviceDelivery === "onsite"
      ? "Customers visit their locations"
      : profile?.serviceDelivery === "offsite"
        ? "They come to the customer / mobile"
        : profile?.serviceDelivery === "mixed"
          ? "Mixed on-site & off-site"
          : profile?.serviceDelivery === "n_a"
            ? "Ecommerce / no local visit"
            : null;

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
        Detects services/products, locations, and whether the business is
        on-site or off-site so competitor keywords match the right geo.
      </p>

      {profile && (
        <div className="business-profile-card">
          <div className="industry-banner" aria-label="Detected industry">
            <span className="industry-banner-kicker">Industry</span>
            <strong className="industry-banner-title">
              {profile.industry || "Unknown"}
              {profile.subIndustry ? (
                <span className="industry-banner-sub">
                  {" "}
                  · {profile.subIndustry}
                </span>
              ) : null}
            </strong>
            {profile.businessModel ? (
              <span className="industry-banner-model">
                {profile.businessModel}
              </span>
            ) : null}
          </div>
          <h3>{profile.businessName}</h3>
          <p>{profile.description}</p>
          {matchedSop && (
            <div className="sop-chip-row">
              <span className="sop-chip">SOP: {matchedSop.label}</span>
              <span className="form-hint" style={{ margin: 0 }}>
                Blocks {matchedSop.excludeCompetitorTypes.slice(0, 3).join(", ")}
                {matchedSop.excludeCompetitorTypes.length > 3 ? "…" : ""}
              </span>
            </div>
          )}
          {deliveryLabel && <p className="form-hint">{deliveryLabel}</p>}
          {profile.locations && profile.locations.length > 0 && (
            <div className="tags" aria-label="Business locations">
              {profile.locations.slice(0, 8).map((loc) => (
                <span key={loc.label} className="tag">
                  {loc.label}
                  {loc.isPrimary ? " (primary)" : ""}
                </span>
              ))}
            </div>
          )}
          {categories.length > 0 && (
            <div className="category-picker">
              <p className="search-label">
                Select a{" "}
                {profile.businessModel === "ecommerce" ? "product" : "service"}{" "}
                category
              </p>
              <div className="tags">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className={
                      selectedCategoryId === cat.id
                        ? "tag tag-selected"
                        : "tag tag-button"
                    }
                    disabled={disabled || loading}
                    onClick={() => onSelectCategory(cat)}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <p className="form-hint">{profile.positioningSummary}</p>
          {profile.brandColors && (
            <div
              className="recreate-palette"
              aria-label="Brand colors from your site"
            >
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
            </div>
          )}
        </div>
      )}

      {profile && (
        <fieldset className="geo-fieldset guardrail-fieldset">
          <legend className="search-label">
            Competitor guardrails (before keyword research)
          </legend>
          <p className="form-hint">
            Industry SOPs filter tools, white-label platforms, courses, and
            podcasts that are not real competitors for{" "}
            <strong>{profile.industry}</strong>
            {matchedSop ? ` (${matchedSop.label})` : ""}. Override only if you
            need a specific competitor type.
          </p>
          <div className="geo-radio-grid" role="radiogroup">
            <label className="geo-radio">
              <input
                type="radio"
                name={`guardrail-${platform}`}
                checked={guardrailChoice === "enforce"}
                onChange={() => setGuardrailChoice("enforce")}
                disabled={disabled || loading}
              />
              <span>Enforce industry SOP</span>
            </label>
            <label className="geo-radio">
              <input
                type="radio"
                name={`guardrail-${platform}`}
                checked={guardrailChoice === "override"}
                onChange={() => setGuardrailChoice("override")}
                disabled={disabled || loading}
              />
              <span>Override — seek specific types</span>
            </label>
            <label className="geo-radio">
              <input
                type="radio"
                name={`guardrail-${platform}`}
                checked={guardrailChoice === "skip"}
                onChange={() => setGuardrailChoice("skip")}
                disabled={disabled || loading}
              />
              <span>Skip all guardrails</span>
            </label>
          </div>
          {guardrailChoice === "override" && (
            <div className="guardrail-override-fields">
              <label
                htmlFor={`seek-competitors-${platform}`}
                className="search-label"
              >
                Look for these competitor types
              </label>
              <input
                id={`seek-competitors-${platform}`}
                type="text"
                className="search-input"
                value={seekCompetitors}
                onChange={(e) => setSeekCompetitors(e.target.value)}
                placeholder="e.g. white-label agencies, SaaS ad tools, course creators"
                disabled={disabled || loading}
              />
              <label
                htmlFor={`guardrail-notes-${platform}`}
                className="search-label"
              >
                Extra notes (optional)
              </label>
              <textarea
                id={`guardrail-notes-${platform}`}
                className="search-textarea"
                rows={2}
                value={guardrailNotes}
                onChange={(e) => setGuardrailNotes(e.target.value)}
                placeholder="Anything the search should prefer or ignore…"
                disabled={disabled || loading}
              />
            </div>
          )}
          {guardrailChoice === "skip" && (
            <p className="form-hint">
              Offers ladders will also skip SOP filters for this run.
            </p>
          )}
        </fieldset>
      )}

      <fieldset className="geo-fieldset">
        <legend className="search-label">Competitor geography mode</legend>
        <div className="geo-radio-grid" role="radiogroup">
          <label className="geo-radio">
            <input
              type="radio"
              name={`geo-mode-${platform}`}
              checked={geoMode === "company_locations"}
              onChange={() => onGeoModeChange("company_locations")}
              disabled={disabled || loading}
            />
            <span>Company locations (city/suburb)</span>
          </label>
          <label className="geo-radio">
            <input
              type="radio"
              name={`geo-mode-${platform}`}
              checked={geoMode === "countrywide"}
              onChange={() => onGeoModeChange("countrywide")}
              disabled={disabled || loading}
            />
            <span>Country-wide</span>
          </label>
        </div>
        <p className="form-hint">
          Prefers your cities — still shows other relevant advertisers if needed.
          If a keyword already names a city/suburb, search prioritizes that
          location (mismatches are flagged, not dropped).
        </p>
      </fieldset>

      <fieldset className="geo-fieldset">
        <legend className="search-label">
          Ad Library market — {meta.short}
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
          "One per line or comma-separated\ne.g. dental implants Ballarat\ninvisalign near me"
        }
        className="search-textarea"
        disabled={disabled || loading}
        required
        rows={4}
      />
      <div className="search-row" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="ghost-btn"
          disabled={disabled || loading || !keywordsText}
          onClick={() => setKeywordsText("")}
        >
          Clear keywords
        </button>
      </div>
      <p className="form-hint">
        Auto-filled from the selected category + locations — clear or rewrite
        freely. Your list is what the search uses.
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
