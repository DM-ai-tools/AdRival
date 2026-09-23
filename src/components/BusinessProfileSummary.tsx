"use client";

import type {
  BusinessCategory,
  BusinessProfile,
  SearchGeoMode,
  SearchJob,
} from "@/lib/types";

function deliveryLabel(
  profile: BusinessProfile,
): string | null {
  const d = profile.serviceDelivery;
  if (!d || d === "n_a") return null;
  if (d === "onsite") return "Service delivery: on-site / local customers";
  if (d === "offsite") return "Service delivery: remote / online";
  if (d === "mixed") return "Service delivery: mixed (local + remote)";
  return null;
}

function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/**
 * Read-only view of the website URL analysis saved on a search run
 * (about, services/offerings, locations, brand).
 */
export function BusinessProfileSummary({
  profile,
  businessUrl,
  selectedCategory,
  keyword,
  keywords,
  geoMode,
  targetLocations,
}: {
  profile?: BusinessProfile | null;
  businessUrl?: string | null;
  selectedCategory?: BusinessCategory | null;
  keyword?: string | null;
  keywords?: string[] | null;
  geoMode?: SearchGeoMode | null;
  targetLocations?: SearchJob["targetLocations"];
}) {
  const url =
    businessUrl ||
    profile?.url ||
    null;

  if (!profile && !url) {
    return (
      <section className="panel">
        <p className="empty-hint">
          No website URL was analyzed for this run. Analyze a business URL before
          starting a search to capture company details, services, and positioning.
        </p>
      </section>
    );
  }

  if (!profile) {
    return (
      <section className="panel business-profile-summary">
        <div className="results-head">
          <h2>Your website</h2>
        </div>
        <p className="muted">
          URL saved:{" "}
          <a href={url!} target="_blank" rel="noreferrer">
            {shortUrl(url!)}
          </a>
        </p>
        <p className="empty-hint">
          Company analysis was not stored on this run (URL-only or older run).
        </p>
      </section>
    );
  }

  const offerings = (profile.offerings || []).filter(Boolean);
  const categories = (profile.categories || []).filter(Boolean);
  const locations = profile.locations || [];
  const delivery = deliveryLabel(profile);
  const kwList =
    (keywords && keywords.length > 0
      ? keywords
      : keyword
        ? [keyword]
        : []) || [];

  return (
    <section className="panel business-profile-summary">
      <div className="results-head">
        <h2>Your website analysis</h2>
        {url ? (
          <a
            className="muted-inline"
            href={url.startsWith("http") ? url : `https://${url}`}
            target="_blank"
            rel="noreferrer"
          >
            {shortUrl(url)}
          </a>
        ) : null}
      </div>

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
        {profile.description ? <p>{profile.description}</p> : null}

        {delivery ? <p className="form-hint">{delivery}</p> : null}

        {profile.targetAudience ? (
          <div className="business-profile-block">
            <p className="search-label">Target audience</p>
            <p>{profile.targetAudience}</p>
          </div>
        ) : null}

        {profile.positioningSummary ? (
          <div className="business-profile-block">
            <p className="search-label">Positioning</p>
            <p className="form-hint" style={{ margin: 0 }}>
              {profile.positioningSummary}
            </p>
          </div>
        ) : null}

        {offerings.length > 0 ? (
          <div className="business-profile-block">
            <p className="search-label">Services & offerings</p>
            <div className="tags" aria-label="Offerings">
              {offerings.map((o) => (
                <span key={o} className="tag">
                  {o}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {categories.length > 0 ? (
          <div className="business-profile-block">
            <p className="search-label">
              {profile.businessModel === "ecommerce"
                ? "Product categories"
                : "Service categories"}
            </p>
            <div className="tags" aria-label="Categories">
              {categories.map((cat) => (
                <span
                  key={cat.id}
                  className={
                    selectedCategory?.id === cat.id
                      ? "tag tag-selected"
                      : "tag"
                  }
                >
                  {cat.label}
                  {selectedCategory?.id === cat.id ? " (selected)" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : selectedCategory ? (
          <div className="business-profile-block">
            <p className="search-label">Selected category</p>
            <div className="tags">
              <span className="tag tag-selected">{selectedCategory.label}</span>
            </div>
          </div>
        ) : null}

        {locations.length > 0 ? (
          <div className="business-profile-block">
            <p className="search-label">Locations</p>
            <div className="tags" aria-label="Business locations">
              {locations.map((loc) => (
                <span key={loc.label} className="tag">
                  {loc.label}
                  {loc.isPrimary ? " (primary)" : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {geoMode ? (
          <div className="business-profile-block">
            <p className="search-label">Search geography</p>
            <p className="form-hint" style={{ margin: 0 }}>
              Mode: {geoMode.replace(/_/g, " ")}
              {targetLocations && targetLocations.length > 0
                ? ` · targets: ${targetLocations
                    .map((l) => l.label || l.city || l.suburb)
                    .filter(Boolean)
                    .join(", ")}`
                : ""}
              {profile.primaryMarketCountry
                ? ` · market: ${profile.primaryMarketCountry}`
                : ""}
            </p>
          </div>
        ) : null}

        {kwList.length > 0 ? (
          <div className="business-profile-block">
            <p className="search-label">Keywords used</p>
            <div className="tags">
              {kwList.map((k) => (
                <span key={k} className="tag">
                  {k}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {profile.competitorKeywords && profile.competitorKeywords.length > 0 ? (
          <div className="business-profile-block">
            <p className="search-label">Suggested competitor keywords</p>
            <div className="tags">
              {profile.competitorKeywords.slice(0, 16).map((k) => (
                <span key={k} className="tag">
                  {k}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {profile.brandColors ? (
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
        ) : null}

        {profile.analyzedAt ? (
          <p className="form-hint" style={{ marginTop: 12 }}>
            Analyzed {new Date(profile.analyzedAt).toLocaleString()}
          </p>
        ) : null}
      </div>
    </section>
  );
}
