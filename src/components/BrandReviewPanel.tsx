"use client";

import type { CompetitorRecord } from "@/lib/types";

function fmt(n?: number | null) {
  if (n == null) return "—";
  return n.toLocaleString();
}

interface BrandReviewPanelProps {
  competitors: CompetitorRecord[];
}

/**
 * Compact brand metrics view — followers + LinkedIn employees only.
 */
export function BrandReviewPanel({ competitors }: BrandReviewPanelProps) {
  if (competitors.length === 0) {
    return (
      <p className="empty-hint">
        Brand metrics appear here after competitors are accepted.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="comp-table brand-review-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Website</th>
            <th>FB followers</th>
            <th>IG followers</th>
            <th>X followers</th>
            <th>YouTube subs</th>
            <th>LI employees</th>
            <th>LI followers</th>
          </tr>
        </thead>
        <tbody>
          {competitors.map((c) => (
            <tr key={c.id}>
              <td>
                <strong>{c.pageName}</strong>
                {c.brand.category && (
                  <div className="muted">{c.brand.category}</div>
                )}
              </td>
              <td className="lp-cell">
                {c.brand.website ? (
                  <a
                    href={
                      c.brand.website.startsWith("http")
                        ? c.brand.website
                        : `https://${c.brand.website}`
                    }
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.brand.website.replace(/^https?:\/\//, "")}
                  </a>
                ) : (
                  "—"
                )}
              </td>
              <td>{fmt(c.brand.facebookFollowers)}</td>
              <td>{fmt(c.brand.instagramFollowers)}</td>
              <td>{fmt(c.brand.twitterFollowers)}</td>
              <td>{fmt(c.brand.youtubeSubscribers)}</td>
              <td>{fmt(c.brand.linkedinEmployees)}</td>
              <td>{fmt(c.brand.linkedinFollowers)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
