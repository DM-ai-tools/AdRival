"use client";

import { Fragment, useMemo, useState } from "react";
import type { CompetitorRecord } from "@/lib/types";
import { formatDaysLive, type AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";
import {
  isFacebookUrl,
  isGoogleAdsTransparencyUrl,
  isLinkedInCompanyUrl,
  isYouTubeUrl,
  normalizeWebsiteUrl,
} from "@/lib/pipeline/linkGuards";
import { PageAnalysisPanel } from "@/components/PageAnalysisPanel";

function countryLabel(c?: string | null) {
  if (!c) return "—";
  if (c === "US") return "US";
  if (c === "AU") return "AU";
  return c;
}

function locationCell(c: CompetitorRecord) {
  const label =
    c.locationLabel ||
    [c.locationSuburb, c.locationCity].filter(Boolean).join(", ") ||
    null;
  const status = c.locationStatus || null;
  return (
    <div className="location-cell">
      <div>{label || "—"}</div>
      {status === "unknown" && (
        <span className="location-badge is-unknown">location unknown</span>
      )}
      {status === "matched" && label && (
        <span className="location-badge is-matched">matched</span>
      )}
      {status === "mismatch" && (
        <span className="location-badge is-mismatch">mismatch</span>
      )}
    </div>
  );
}

function shortUrl(url?: string | null) {
  if (!url) return "—";
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname;
    const host = u.hostname.replace(/^www\./, "");
    const full = `${host}${path}`;
    return full.length > 36 ? `${full.slice(0, 34)}…` : full;
  } catch {
    return url.length > 36 ? `${url.slice(0, 34)}…` : url;
  }
}

function LinkCell({ href, label }: { href?: string | null; label: string }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function resolvePlatform(c: CompetitorRecord): AdPlatform {
  const p = (c.platform || "facebook") as AdPlatform;
  return p;
}

function hasAnalyzableUrl(c: CompetitorRecord): boolean {
  const ad = c.sampleAd;
  const urls = [
    ad?.landingPageUrl,
    ad?.youtubeUrl,
    ad?.advertiserPageUrl,
    c.brand?.website,
    ad?.domain ? `https://${ad.domain}` : null,
  ];
  return urls.some((u) => {
    if (!u) return false;
    try {
      const parsed = new URL(u.startsWith("http") ? u : `https://${u}`);
      const hostPath = parsed.hostname + parsed.pathname;
      return !/facebook\.com\/ads\/library|adstransparency\.google|linkedin\.com\/ad-library/i.test(
        hostPath,
      );
    } catch {
      return false;
    }
  });
}

type SortKey =
  | "pageName"
  | "country"
  | "services"
  | "activeAdsCount"
  | "daysRunning"
  | "format"
  | "domain";

type SortDir = "asc" | "desc";

interface CompetitorTableProps {
  competitors: CompetitorRecord[];
  onCompetitorUpdated?: (competitor: CompetitorRecord) => void;
}

function SortTh({
  label,
  column,
  sortKey,
  sortDir,
  onSort,
}: {
  label: string;
  column: SortKey;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const active = sortKey === column;
  return (
    <th>
      <button
        type="button"
        className={`sort-th ${active ? "active" : ""}`}
        onClick={() => onSort(column)}
      >
        {label}
        <span className="sort-indicator" aria-hidden>
          {active ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}
        </span>
      </button>
    </th>
  );
}

/** Ad creative preview — brand metrics live in the Brand review tab. */
export function CompetitorTable({
  competitors,
  onCompetitorUpdated,
}: CompetitorTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("activeAdsCount");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [analyzingId, setAnalyzingId] = useState<string | null>(null);
  const [analyzeError, setAnalyzeError] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = useMemo(() => {
    const rows = [...competitors];
    const dir = sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const daysA = a.sampleAd?.daysRunning ?? -1;
      const daysB = b.sampleAd?.daysRunning ?? -1;
      switch (sortKey) {
        case "pageName":
          return a.pageName.localeCompare(b.pageName) * dir;
        case "country":
          return (
            String(a.country || "").localeCompare(String(b.country || "")) * dir
          );
        case "services":
          return (a.services.length - b.services.length) * dir;
        case "activeAdsCount":
          return (a.activeAdsCount - b.activeAdsCount) * dir;
        case "daysRunning":
          return (daysA - daysB) * dir;
        case "format":
          return (
            String(a.sampleAd?.format || "").localeCompare(
              String(b.sampleAd?.format || ""),
            ) * dir
          );
        case "domain":
          return (
            String(
              a.sampleAd?.domain || a.sampleAd?.visibleUrl || "",
            ).localeCompare(
              String(b.sampleAd?.domain || b.sampleAd?.visibleUrl || ""),
            ) * dir
          );
        default:
          return 0;
      }
    });
    return rows;
  }, [competitors, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(
        key === "pageName" ||
          key === "country" ||
          key === "format" ||
          key === "domain"
          ? "asc"
          : "desc",
      );
    }
  };

  async function runAnalysis(c: CompetitorRecord, force = false) {
    setAnalyzeError((prev) => {
      const next = { ...prev };
      delete next[c.id];
      return next;
    });
    setAnalyzingId(c.id);
    setExpandedId(c.id);
    try {
      const res = await fetch("/api/competitors/analyze-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ competitorId: c.id, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      if (data.competitor) {
        onCompetitorUpdated?.(data.competitor as CompetitorRecord);
      }
    } catch (err) {
      setAnalyzeError((prev) => ({
        ...prev,
        [c.id]: (err as Error).message,
      }));
    } finally {
      setAnalyzingId(null);
    }
  }

  if (competitors.length === 0) {
    return (
      <p className="empty-hint">
        Competitors will appear here as they are accepted.
      </p>
    );
  }

  const platform = resolvePlatform(competitors[0]);
  const isMeta = platform === "facebook" || platform === "instagram";
  const isLinkedIn = platform === "linkedin";
  const isGoogle = platform === "google";
  const isYouTube = platform === "youtube";
  const isGoogleFamily = isGoogle || isYouTube;

  let colCount = 9; // company, ad market, location, services, active, sample, landing, days, links
  if (isMeta || isLinkedIn) colCount += 1; // CTA
  if (isLinkedIn) colCount += 2; // ad type, impressions
  if (isGoogle || isYouTube) colCount += 2; // format, domain
  if (isGoogle || isYouTube || isLinkedIn) colCount += 1; // run window

  return (
    <div className="table-wrap">
      <table className="comp-table">
        <thead>
          <tr>
            <SortTh
              label="Company"
              column="pageName"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            <SortTh
              label="Ad market"
              column="country"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            <th>Location</th>
            <SortTh
              label="Services"
              column="services"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            <SortTh
              label="Active ads"
              column="activeAdsCount"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            <th>{isYouTube || isGoogle ? "Headline" : "Sample ad"}</th>
            {(isMeta || isLinkedIn) && <th>CTA</th>}
            <th>
              {isYouTube
                ? "YouTube / destination"
                : isGoogle
                  ? "Landing / destination"
                  : "Landing page"}
            </th>
            {isLinkedIn && <th>Ad type</th>}
            {isLinkedIn && <th>Impressions</th>}
            {(isGoogle || isYouTube) && (
              <SortTh
                label="Format"
                column="format"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
            )}
            {(isGoogle || isYouTube) && (
              <SortTh
                label="Domain"
                column="domain"
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
              />
            )}
            <SortTh
              label="Days live"
              column="daysRunning"
              sortKey={sortKey}
              sortDir={sortDir}
              onSort={onSort}
            />
            {(isGoogle || isYouTube || isLinkedIn) && <th>Run window</th>}
            <th>Links</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => {
            const ad = c.sampleAd;
            const runWindow =
              ad.startDate || ad.endDate
                ? `${ad.startDate ? new Date(ad.startDate).toLocaleDateString() : "?"} → ${
                    ad.endDate
                      ? new Date(ad.endDate).toLocaleDateString()
                      : "now"
                  }`
                : "—";

            const website =
              normalizeWebsiteUrl(c.brand.website) ||
              (ad.domain ? normalizeWebsiteUrl(`https://${ad.domain}`) : null);

            const adLink = isGoogleFamily
              ? isGoogleAdsTransparencyUrl(ad.adLibraryUrl)
                ? ad.adLibraryUrl
                : ad.adLibraryUrl
              : ad.adLibraryUrl;

            const ytLink = isYouTubeUrl(ad.youtubeUrl)
              ? ad.youtubeUrl
              : isYouTubeUrl(c.brand.youtubeUrl)
                ? c.brand.youtubeUrl
                : null;

            const fbLink = isFacebookUrl(c.brand.facebookUrl)
              ? c.brand.facebookUrl
              : null;

            const liLink = isLinkedInCompanyUrl(
              c.brand.linkedinUrl || ad.advertiserPageUrl,
            )
              ? c.brand.linkedinUrl || ad.advertiserPageUrl
              : null;

            const canAnalyze = hasAnalyzableUrl(c);
            const analysis = c.pageAnalysis;
            const analyzing = analyzingId === c.id;
            const showPanel =
              expandedId === c.id &&
              (Boolean(analysis) || Boolean(analyzeError[c.id]) || analyzing);

            return (
              <Fragment key={c.id}>
                <tr>
                  <td>
                    <strong>{c.pageName}</strong>
                    <div className="muted">
                      {PLATFORM_META[resolvePlatform(c)]?.short || c.platform}
                      {c.brand.category ? ` · ${c.brand.category}` : ""}
                    </div>
                  </td>
                  <td>
                    <span className="country-badge">
                      {countryLabel(c.country)}
                    </span>
                  </td>
                  <td>{locationCell(c)}</td>
                  <td>
                    <div className="tags">
                      {c.services.map((s) => (
                        <span key={s} className="tag">
                          {s}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{c.activeAdsCount}</td>
                  <td className="ad-cell">
                    <div className="ad-title">{ad.title || "(no title)"}</div>
                    <div className="ad-body">
                      {(ad.body || "").slice(0, 140)}
                    </div>
                  </td>
                  {(isMeta || isLinkedIn) && (
                    <td>
                      <span className="cta-badge">
                        {ad.ctaText?.trim() || "—"}
                      </span>
                    </td>
                  )}
                  <td className="lp-cell">
                    <div className="lp-cell-stack">
                      {isYouTube && ytLink ? (
                        <a
                          href={ytLink}
                          target="_blank"
                          rel="noreferrer"
                          title={ytLink}
                        >
                          {shortUrl(ytLink)}
                        </a>
                      ) : ad.landingPageUrl &&
                        !isGoogleAdsTransparencyUrl(ad.landingPageUrl) &&
                        !isFacebookUrl(ad.landingPageUrl) ? (
                        <a
                          href={ad.landingPageUrl}
                          target="_blank"
                          rel="noreferrer"
                          title={ad.landingPageUrl}
                        >
                          {shortUrl(ad.landingPageUrl)}
                        </a>
                      ) : (
                        <span>—</span>
                      )}
                      <button
                        type="button"
                        className="ghost-btn lp-analyze-btn"
                        disabled={!canAnalyze || analyzing}
                        title={
                          canAnalyze
                            ? "Fetch landing page and extract offer + page architecture"
                            : "No landing page URL on this competitor"
                        }
                        onClick={() => {
                          if (analysis?.status === "completed" && expandedId === c.id) {
                            setExpandedId(null);
                            return;
                          }
                          if (analysis?.status === "completed") {
                            setExpandedId(c.id);
                            return;
                          }
                          void runAnalysis(
                            c,
                            Boolean(analysis?.status === "failed"),
                          );
                        }}
                      >
                        {analyzing
                          ? "Analyzing…"
                          : analysis?.status === "completed"
                            ? expandedId === c.id
                              ? "Hide details"
                              : "Offer & page details"
                            : "Get offer & page details"}
                      </button>
                      {analysis?.status === "completed" && (
                        <button
                          type="button"
                          className="ghost-btn lp-analyze-btn"
                          disabled={analyzing}
                          onClick={() => void runAnalysis(c, true)}
                        >
                          Refresh
                        </button>
                      )}
                      {analysis?.status === "completed" && (
                        <a
                          className="search-btn lp-analyze-btn lp-recreate-link"
                          href={`/recreate/${encodeURIComponent(c.id)}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Open a new page that recreates this landing page for your business URL brand"
                        >
                          {c.recreatedPage?.status === "completed"
                            ? "View recreated page"
                            : c.recreatedPage?.status === "content_ready"
                              ? "Review content draft"
                              : "Recreate for my brand"}
                        </a>
                      )}
                    </div>
                  </td>
                  {isLinkedIn && <td>{ad.format || "—"}</td>}
                  {isLinkedIn && <td>{ad.impressions || "—"}</td>}
                  {(isGoogle || isYouTube) && <td>{ad.format || "—"}</td>}
                  {(isGoogle || isYouTube) && (
                    <td>{ad.domain || ad.visibleUrl || "—"}</td>
                  )}
                  <td>{formatDaysLive(ad.daysRunning)}</td>
                  {(isGoogle || isYouTube || isLinkedIn) && (
                    <td>{runWindow}</td>
                  )}
                  <td className="links-cell">
                    {isGoogleFamily ? (
                      <>
                        <LinkCell href={adLink} label="Ad" />
                        {ytLink && <LinkCell href={ytLink} label="YT" />}
                        <LinkCell href={website} label="Web" />
                        {(c.brand.linkedinEmployees != null ||
                          c.brand.linkedinFollowers != null) &&
                          liLink && <LinkCell href={liLink} label="LI" />}
                      </>
                    ) : (
                      <>
                        <LinkCell href={adLink} label="Ad" />
                        {fbLink && <LinkCell href={fbLink} label="FB" />}
                        {liLink && <LinkCell href={liLink} label="LI" />}
                        {ytLink && <LinkCell href={ytLink} label="YT" />}
                        {website && <LinkCell href={website} label="Web" />}
                      </>
                    )}
                  </td>
                </tr>
                {showPanel && (
                  <tr className="comp-analysis-row">
                    <td colSpan={colCount}>
                      {analyzeError[c.id] && (
                        <p className="error-text" role="alert">
                          {analyzeError[c.id]}
                        </p>
                      )}
                      {analysis && <PageAnalysisPanel analysis={analysis} />}
                      {!analysis && analyzing && (
                        <div className="page-analysis-panel">
                          <p className="muted">Analyzing landing page…</p>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
