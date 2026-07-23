"use client";

import { useState, type ReactNode } from "react";
import type { LookupAdRecord, LookupJob } from "@/lib/types";
import { formatDaysLive, type AdPlatform } from "@/lib/platforms";

interface LookupResultsProps {
  job: LookupJob;
  ads: LookupAdRecord[];
}

function fmt(n?: number | null) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function Field({ label, value }: { label: string; value?: ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div className="lookup-field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function AdCard({ ad, platform }: { ad: LookupAdRecord; platform: AdPlatform }) {
  const [openRaw, setOpenRaw] = useState(false);
  const snap = (ad.raw.snapshot ?? ad.raw) as Record<string, unknown>;
  const isMeta = platform === "facebook" || platform === "instagram";
  const isLinkedIn = platform === "linkedin";
  const isGoogle = platform === "google" || platform === "youtube";

  return (
    <article className="lookup-ad-card">
      <header className="lookup-ad-head">
        <div>
          <h3>{ad.title || "(no title)"}</h3>
          <p className="muted">
            {ad.country}
            {ad.format ? ` · ${ad.format}` : ""}
            {ad.isActive ? " · Active" : " · Inactive"}
            {" · "}
            {formatDaysLive(ad.daysRunning)} days
            {ad.startDateString
              ? ` · ${new Date(ad.startDateString).toLocaleDateString()}`
              : ""}
            {ad.endDateString
              ? ` → ${new Date(ad.endDateString).toLocaleDateString()}`
              : ""}
          </p>
        </div>
        <a href={ad.adLibraryUrl} target="_blank" rel="noreferrer">
          Open in Ad Library
        </a>
      </header>

      {ad.body && <p className="lookup-ad-body">{ad.body}</p>}

      <dl className="lookup-fields">
        {(isMeta || isLinkedIn) && <Field label="CTA" value={ad.ctaText} />}
        <Field
          label={platform === "youtube" ? "YouTube / destination" : "Landing page"}
          value={
            ad.youtubeUrl || ad.landingPageUrl ? (
              <a
                href={ad.youtubeUrl || ad.landingPageUrl || undefined}
                target="_blank"
                rel="noreferrer"
              >
                {ad.youtubeUrl || ad.landingPageUrl}
              </a>
            ) : null
          }
        />
        {isLinkedIn && <Field label="Ad type" value={ad.format} />}
        {isLinkedIn && <Field label="Impressions" value={ad.impressions} />}
        {isLinkedIn && (
          <Field
            label="Advertiser page"
            value={
              ad.advertiserPageUrl ? (
                <a href={ad.advertiserPageUrl} target="_blank" rel="noreferrer">
                  {ad.advertiserPageUrl}
                </a>
              ) : null
            }
          />
        )}
        {isGoogle && <Field label="Format" value={ad.format} />}
        {isGoogle && <Field label="Domain" value={ad.domain || ad.visibleUrl} />}
        {platform === "youtube" && (
          <Field
            label="YouTube URL"
            value={
              ad.youtubeUrl ? (
                <a href={ad.youtubeUrl} target="_blank" rel="noreferrer">
                  {ad.youtubeUrl}
                </a>
              ) : null
            }
          />
        )}
        {isMeta && (
          <>
            <Field label="Ad archive ID" value={ad.adArchiveId} />
            <Field
              label="Caption"
              value={snap.caption != null ? String(snap.caption) : null}
            />
            <Field
              label="Link description"
              value={
                snap.link_description != null
                  ? String(snap.link_description)
                  : null
              }
            />
            <Field
              label="CTA type"
              value={snap.cta_type != null ? String(snap.cta_type) : null}
            />
            <Field
              label="Page profile"
              value={
                snap.page_profile_uri != null ? (
                  <a
                    href={String(snap.page_profile_uri)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {String(snap.page_profile_uri)}
                  </a>
                ) : null
              }
            />
          </>
        )}
        {(ad.imageUrl || (snap.image != null && String(snap.image))) && (
          <Field
            label="Creative image"
            value={
              <a
                href={ad.imageUrl || String(snap.image)}
                target="_blank"
                rel="noreferrer"
              >
                View image
              </a>
            }
          />
        )}
      </dl>

      <button
        type="button"
        className="ghost-btn raw-toggle"
        onClick={() => setOpenRaw((v) => !v)}
      >
        {openRaw ? "Hide raw JSON" : "Show full SociaVault JSON"}
      </button>
      {openRaw && (
        <pre className="lookup-raw-json">{JSON.stringify(ad.raw, null, 2)}</pre>
      )}
    </article>
  );
}

export function LookupResults({ job, ads }: LookupResultsProps) {
  const page = job.selectedPage;
  const running = job.status === "running";
  const platform = (job.platform || "facebook") as AdPlatform;

  return (
    <div className="lookup-results">
      <section className="progress-panel">
        <div className="progress-head">
          <h2>
            Lookup: {job.queryName}{" "}
            <span className="muted-inline">({platform})</span>
          </h2>
          <span className={`status-pill status-${job.status}`}>{job.status}</span>
        </div>
        <p className="progress-message">{job.progress.message}</p>
        <dl className="progress-stats">
          <div>
            <dt>Candidates</dt>
            <dd>{job.progress.candidatesFound}</dd>
          </div>
          <div>
            <dt>Ads</dt>
            <dd>{job.progress.adsFetched}</dd>
          </div>
          <div>
            <dt>Pages</dt>
            <dd>{job.progress.pagesScanned}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{job.progress.stage}</dd>
          </div>
        </dl>
      </section>

      {page && (
        <section className="panel lookup-match">
          <div className="lookup-match-head">
            {page.imageUri && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={page.imageUri}
                alt=""
                className="lookup-avatar"
                width={56}
                height={56}
              />
            )}
            <div>
              <h2>{page.name}</h2>
              <p className="muted">
                Page ID {page.pageId}
                {page.category ? ` · ${page.category}` : ""}
                {page.verification ? ` · ${page.verification}` : ""}
              </p>
            </div>
          </div>
          <dl className="lookup-fields">
            <Field label="Likes" value={fmt(page.likes)} />
            <Field label="Instagram" value={page.igUsername} />
            <Field label="IG followers" value={fmt(page.igFollowers)} />
            <Field label="Alias" value={page.pageAlias} />
            <Field
              label="LLM confidence"
              value={
                job.llmConfidence != null
                  ? `${Math.round(job.llmConfidence * 100)}%`
                  : null
              }
            />
            <Field label="Why this page" value={job.llmReason} />
          </dl>

          {job.candidates.length > 1 && (
            <div className="lookup-candidates">
              <h3>Other name matches considered</h3>
              <ul>
                {job.candidates
                  .filter((c) => c.pageId !== page.pageId)
                  .map((c) => (
                    <li key={c.pageId}>
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {" "}
                        · {c.pageId}
                        {c.category ? ` · ${c.category}` : ""}
                        {c.likes != null ? ` · ${fmt(c.likes)} likes` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section className="results">
        <div className="results-head">
          <h2>
            Ads{" "}
            <span className="muted-inline">
              ({ads.length}
              {running ? " so far" : ""})
            </span>
          </h2>
          <a
            className={`export-btn ${ads.length === 0 ? "disabled" : ""}`}
            href={
              ads.length === 0
                ? undefined
                : `/api/lookup/export?lookupId=${job.id}`
            }
            aria-disabled={ads.length === 0}
          >
            Download Excel
          </a>
        </div>

        {ads.length === 0 ? (
          <p className="empty-hint">
            {running
              ? "Ads will appear here as they are fetched…"
              : "No ads stored for this lookup yet."}
          </p>
        ) : (
          <div className="lookup-ad-list">
            {ads.map((ad) => (
              <AdCard key={ad.id} ad={ad} platform={platform} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
