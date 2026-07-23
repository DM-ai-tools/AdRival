"use client";

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

function countryLabel(c?: string | null) {
  if (!c) return "—";
  if (c === "US") return "US";
  if (c === "AU") return "AU";
  return c;
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

interface CompetitorTableProps {
  competitors: CompetitorRecord[];
}

/** Ad creative preview — brand metrics live in the Brand review tab. */
export function CompetitorTable({ competitors }: CompetitorTableProps) {
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

  return (
    <div className="table-wrap">
      <table className="comp-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Country</th>
            <th>Services</th>
            <th>Active ads</th>
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
            {(isGoogle || isYouTube) && <th>Format</th>}
            {(isGoogle || isYouTube) && <th>Domain</th>}
            <th>Days live</th>
            {(isGoogle || isYouTube || isLinkedIn) && <th>Run window</th>}
            <th>Links</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((c) => {
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

            return (
              <tr key={c.id}>
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
                  <div className="ad-body">{(ad.body || "").slice(0, 140)}</div>
                </td>
                {(isMeta || isLinkedIn) && (
                  <td>
                    <span className="cta-badge">
                      {ad.ctaText?.trim() || "—"}
                    </span>
                  </td>
                )}
                <td className="lp-cell">
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
                    "—"
                  )}
                </td>
                {isLinkedIn && <td>{ad.format || "—"}</td>}
                {isLinkedIn && <td>{ad.impressions || "—"}</td>}
                {(isGoogle || isYouTube) && <td>{ad.format || "—"}</td>}
                {(isGoogle || isYouTube) && (
                  <td>{ad.domain || ad.visibleUrl || "—"}</td>
                )}
                <td>{formatDaysLive(ad.daysRunning)}</td>
                {(isGoogle || isYouTube || isLinkedIn) && <td>{runWindow}</td>}
                <td className="links-cell">
                  {/* Google / YouTube: only Ad (Transparency) + real YT creative + Web */}
                  {isGoogleFamily ? (
                    <>
                      <LinkCell href={adLink} label="Ad" />
                      {ytLink && <LinkCell href={ytLink} label="YT" />}
                      <LinkCell href={website} label="Web" />
                      {/* LI only when brand review verified employees/followers */}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
