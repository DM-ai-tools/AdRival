"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type {
  LookupAdRecord,
  LookupJob,
  LookupPageCandidate,
} from "@/lib/types";
import { formatDaysLive, type AdPlatform } from "@/lib/platforms";
import { PageAnalysisPanel } from "@/components/PageAnalysisPanel";
import {
  LookupOffersDashboard,
  LookupOffersTeaser,
} from "@/components/LookupOffersReportPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface LookupResultsProps {
  job: LookupJob;
  ads: LookupAdRecord[];
  onFetchCandidate?: (candidate: LookupPageCandidate) => void;
  fetchingCandidateId?: string | null;
  onAdUpdated?: (ad: LookupAdRecord) => void;
  onJobUpdated?: (job: LookupJob, ads?: LookupAdRecord[]) => void;
  /** Reload lookup job + ads after leaving the offers dashboard */
  onReload?: () => void | Promise<void>;
  onStop?: () => void;
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

function hasAnalyzableUrl(ad: LookupAdRecord): boolean {
  const urls = [ad.landingPageUrl, ad.youtubeUrl, ad.advertiserPageUrl];
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

function AdCard({
  ad,
  platform,
  job,
  onAdUpdated,
  onJobUpdated,
}: {
  ad: LookupAdRecord;
  platform: AdPlatform;
  job: LookupJob;
  onAdUpdated?: (ad: LookupAdRecord) => void;
  onJobUpdated?: (job: LookupJob) => void;
}) {
  const router = useRouter();
  const [openRaw, setOpenRaw] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [bridging, setBridging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmExisting, setConfirmExisting] = useState<{
    competitorId: string;
    status: string;
    sourceAnalyzedUrl: string;
    pageName: string;
  } | null>(null);
  const snap = (ad.raw.snapshot ?? ad.raw) as Record<string, unknown>;
  const isMeta = platform === "facebook" || platform === "instagram";
  const isLinkedIn = platform === "linkedin";
  const isGoogle = platform === "google" || platform === "youtube";
  const canAnalyze = hasAnalyzableUrl(ad);
  const analysis = ad.pageAnalysis;
  const canRecreate = analysis?.status === "completed";
  const hasBrandUrl = Boolean(
    (job.businessUrl || job.businessProfile?.url || "").trim(),
  );

  async function runAnalysis(force = false) {
    setError(null);
    setAnalyzing(true);
    // Optimistic pending so the panel shows progress immediately
    const pendingUrl =
      ad.pageAnalysis?.analyzedUrl ||
      ad.landingPageUrl ||
      ad.youtubeUrl ||
      ad.advertiserPageUrl ||
      "";
    onAdUpdated?.({
      ...ad,
      pageAnalysis: {
        ...(ad.pageAnalysis || {}),
        status: "pending",
        analyzedUrl: pendingUrl,
        analyzedAt: new Date().toISOString(),
        error: null,
      },
    });

    const ac = new AbortController();
    // Long-running scrape + LLM; keep above server maxDuration
    const timeout = window.setTimeout(() => ac.abort(), 170_000);

    // Poll this ad while the POST is in flight so UI unsticks if the
    // response is dropped but the store already has a terminal status.
    const pollTimer = window.setInterval(async () => {
      try {
        const res = await fetch(
          `/api/lookup/status?lookupId=${encodeURIComponent(ad.lookupId)}`,
        );
        if (!res.ok) return;
        const data = await res.json();
        const fresh = (data.ads as LookupAdRecord[] | undefined)?.find(
          (a) => a.id === ad.id,
        );
        if (!fresh?.pageAnalysis) return;
        if (
          fresh.pageAnalysis.status === "completed" ||
          fresh.pageAnalysis.status === "failed"
        ) {
          onAdUpdated?.(fresh);
          if (fresh.pageAnalysis.status === "failed") {
            setError(fresh.pageAnalysis.error || "Analysis failed");
          }
          setAnalyzing(false);
          ac.abort();
        } else if (fresh.pageAnalysis.status === "pending") {
          onAdUpdated?.(fresh);
        }
      } catch {
        /* ignore poll errors */
      }
    }, 2500);

    try {
      const res = await fetch("/api/lookup/analyze-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adId: ad.id, force }),
        signal: ac.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Analysis failed");
      if (data.ad) onAdUpdated?.(data.ad as LookupAdRecord);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError((err as Error).message);
      }
      // AbortError: poll may already have applied completed/failed — no extra noise
    } finally {
      window.clearTimeout(timeout);
      window.clearInterval(pollTimer);
      setAnalyzing(false);
    }
  }

  async function startRecreation(confirmRedesign = false) {
    setError(null);
    if (!hasBrandUrl) {
      setError(
        "Add your brand website above (Your brand website) before Content / Design.",
      );
      return;
    }
    setBridging(true);
    try {
      const res = await fetch("/api/lookup/recreate-bridge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          adId: ad.id,
          businessUrl: job.businessUrl || job.businessProfile?.url,
          confirmRedesign,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not open recreation");

      if (data.lookupJob) onJobUpdated?.(data.lookupJob as LookupJob);
      if (data.ad) onAdUpdated?.(data.ad as LookupAdRecord);

      if (data.needsConfirm && data.existing) {
        setConfirmExisting({
          competitorId: String(data.existing.competitorId),
          status: String(data.existing.status),
          sourceAnalyzedUrl: String(data.existing.sourceAnalyzedUrl || ""),
          pageName: String(data.existing.pageName || "this page"),
        });
        setConfirmOpen(true);
        return;
      }

      if (data.recreatePath) {
        router.push(String(data.recreatePath));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBridging(false);
    }
  }

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

      <div className="lookup-ad-actions">
        <button
          type="button"
          className="search-btn lookup-analyze-btn"
          disabled={!canAnalyze || analyzing || bridging}
          title={
            canAnalyze
              ? "Fetch landing page and extract offer + page architecture"
              : "No landing page URL on this ad"
          }
          onClick={() => void runAnalysis(Boolean(analysis?.status === "completed"))}
        >
          {analyzing
            ? "Analyzing page…"
            : analysis?.status === "completed"
              ? "Refresh offer & page details"
              : "Get offer & page details"}
        </button>
        {canRecreate ? (
          <>
            <button
              type="button"
              className="search-btn lp-recreate-link"
              disabled={bridging}
              title={
                hasBrandUrl
                  ? "Generate brand content draft for this landing page"
                  : "Set your brand website first"
              }
              onClick={() => void startRecreation(false)}
            >
              {bridging
                ? "Opening…"
                : ad.recreationCompetitorId
                  ? "Content & design again"
                  : "Content & design"}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="ghost-btn raw-toggle"
          onClick={() => setOpenRaw((v) => !v)}
        >
          {openRaw ? "Hide raw JSON" : "Show full SociaVault JSON"}
        </button>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {bridging ? (
        <div
          className="recreate-status panel recreate-progress-panel"
          aria-live="polite"
        >
          <div className="offers-analysis-progress-head">
            <span className="offers-analysis-progress-label">
              Content creation
            </span>
            <span className="offers-analysis-progress-count">…</span>
          </div>
          <div className="progress-bar-track offers-analysis-bar">
            <div
              className="progress-bar-fill progress-bar-offers"
              style={{ width: "18%" }}
            />
          </div>
          <p className="muted recreate-progress-msg">
            Opening content &amp; design for this landing page…
          </p>
        </div>
      ) : null}

      {analysis && <PageAnalysisPanel analysis={analysis} />}

      {openRaw && (
        <pre className="lookup-raw-json">{JSON.stringify(ad.raw, null, 2)}</pre>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Landing page already recreated"
        description={
          confirmExisting
            ? `A ${confirmExisting.status.replace(/_/g, " ")} recreation already exists for this landing page${
                confirmExisting.sourceAnalyzedUrl
                  ? ` (${confirmExisting.sourceAnalyzedUrl})`
                  : ""
              }. Confirm only if you want to redesign it again for your brand.`
            : "This landing page was already recreated. Confirm to redesign."
        }
        confirmLabel="Redesign anyway"
        cancelLabel="Open existing"
        busy={bridging}
        tone="danger"
        onDismiss={() => setConfirmOpen(false)}
        onCancel={() => {
          setConfirmOpen(false);
          if (confirmExisting?.competitorId) {
            router.push(
              `/recreate/${encodeURIComponent(confirmExisting.competitorId)}`,
            );
          }
        }}
        onConfirm={() => {
          setConfirmOpen(false);
          void startRecreation(true);
        }}
      />
    </article>
  );
}

export function LookupResults({
  job,
  ads,
  onFetchCandidate,
  fetchingCandidateId,
  onAdUpdated,
  onJobUpdated,
  onReload,
  onStop,
}: LookupResultsProps) {
  const page = job.selectedPage;
  const running = job.status === "running";
  const analyzingOffers = job.progress.stage === "analyzing_offers";
  const platform = (job.platform || "facebook") as AdPlatform;
  const [regeneratingReport, setRegeneratingReport] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [showOffersDash, setShowOffersDash] = useState(false);
  const [brandUrlDraft, setBrandUrlDraft] = useState(
    job.businessUrl || job.businessProfile?.url || "",
  );
  const [savingBrandUrl, setSavingBrandUrl] = useState(false);
  const [brandUrlError, setBrandUrlError] = useState<string | null>(null);

  useEffect(() => {
    setBrandUrlDraft(job.businessUrl || job.businessProfile?.url || "");
  }, [job.businessUrl, job.businessProfile?.url]);
  const isLinkedIn = platform === "linkedin";
  const liFollowers =
    page?.raw?.linkedinFollowers != null
      ? Number(page.raw.linkedinFollowers)
      : null;
  const liEmployees =
    page?.raw?.linkedinEmployees != null
      ? Number(page.raw.linkedinEmployees)
      : null;
  const ytSubs =
    page?.raw?.youtubeSubscribers != null
      ? Number(page.raw.youtubeSubscribers)
      : null;

  const others = job.candidates.filter((c) => c.pageId !== page?.pageId);

  async function stopLookup() {
    setStopping(true);
    try {
      await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lookupId: job.id }),
      });
      onStop?.();
    } finally {
      setStopping(false);
    }
  }

  async function regenerateOffersReport(force = true) {
    setReportError(null);
    setRegeneratingReport(true);
    try {
      const res = await fetch("/api/lookup/offers-report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lookupId: job.id, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Offers report failed");
      if (data.job) {
        onJobUpdated?.(
          data.job as LookupJob,
          Array.isArray(data.ads) ? (data.ads as LookupAdRecord[]) : undefined,
        );
      }
    } catch (err) {
      setReportError((err as Error).message);
    } finally {
      setRegeneratingReport(false);
    }
  }

  async function handleBackFromOffers() {
    setShowOffersDash(false);
    await onReload?.();
  }

  async function saveBrandWebsite() {
    const url = brandUrlDraft.trim();
    if (!url) {
      setBrandUrlError("Enter your brand website URL");
      return;
    }
    setBrandUrlError(null);
    setSavingBrandUrl(true);
    try {
      const res = await fetch("/api/lookup/brand", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lookupId: job.id, businessUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save brand website");
      if (data.job) onJobUpdated?.(data.job as LookupJob);
      setBrandUrlDraft(
        data.job?.businessUrl || data.job?.businessProfile?.url || url,
      );
    } catch (err) {
      setBrandUrlError((err as Error).message);
    } finally {
      setSavingBrandUrl(false);
    }
  }

  const showOffersTeaser =
    ads.length > 0 ||
    Boolean(job.offersReport) ||
    analyzingOffers ||
    regeneratingReport;

  if (showOffersDash && job.offersReport?.status === "completed") {
    return (
      <LookupOffersDashboard
        job={job}
        report={job.offersReport}
        regenerating={regeneratingReport}
        onBack={() => {
          void handleBackFromOffers();
          if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "smooth" });
          }
        }}
        onRegenerate={
          ads.length > 0 && !analyzingOffers
            ? () => void regenerateOffersReport(true)
            : undefined
        }
      />
    );
  }

  return (
    <div className="lookup-results">
      <section className="progress-panel">
        <div className="progress-head">
          <h2>
            Lookup: {job.queryName}{" "}
            <span className="muted-inline">({platform})</span>
          </h2>
          <div className="progress-head-actions">
            {running || analyzingOffers ? (
              <button
                type="button"
                className="danger-btn"
                disabled={stopping}
                onClick={() => void stopLookup()}
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            ) : null}
            <span className={`status-pill status-${job.status}`}>{job.status}</span>
          </div>
        </div>
        <div className="lookup-brand-bar">
          <label htmlFor="lookup-results-brand-url" className="search-label">
            Your brand website{" "}
            <span className="muted">(required for Content &amp; Design)</span>
          </label>
          <div className="search-row">
            <input
              id="lookup-results-brand-url"
              type="url"
              className="search-input"
              value={brandUrlDraft}
              onChange={(e) => setBrandUrlDraft(e.target.value)}
              placeholder="https://yourbrand.com"
              disabled={savingBrandUrl || running}
            />
            <button
              type="button"
              className="ghost-btn"
              disabled={savingBrandUrl || running || !brandUrlDraft.trim()}
              onClick={() => void saveBrandWebsite()}
            >
              {savingBrandUrl ? "Saving…" : "Save brand"}
            </button>
          </div>
          {brandUrlError ? (
            <p className="error-text" role="alert">
              {brandUrlError}
            </p>
          ) : (
            <p className="muted form-hint">
              After analyzing a competitor landing page, use{" "}
              <strong>Content &amp; design</strong> on an ad. If that URL was
              already recreated, you&apos;ll be asked to confirm a redesign.
            </p>
          )}
        </div>
        {analyzingOffers || regeneratingReport ? (
          <div className="offers-analysis-progress" aria-live="polite">
            <div className="offers-analysis-progress-head">
              <span className="offers-analysis-progress-label">
                Offers analysis
                {job.progress.offersCurrentName
                  ? ` · ${job.progress.offersCurrentName}`
                  : ""}
              </span>
              <span className="offers-analysis-progress-count">
                {job.progress.offersTotal
                  ? `${job.progress.offersDone ?? 0}/${job.progress.offersTotal}`
                  : `${Math.max(job.progress.offersPct ?? 8, 4)}%`}
              </span>
            </div>
            <div className="progress-bar-track offers-analysis-bar">
              <div
                className="progress-bar-fill progress-bar-offers"
                style={{
                  width: `${Math.min(
                    100,
                    Math.max(job.progress.offersPct ?? 8, 4),
                  )}%`,
                }}
              />
            </div>
          </div>
        ) : null}
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
            <Field
              label={isLinkedIn ? "LI followers" : "Likes"}
              value={fmt(isLinkedIn ? liFollowers ?? page.likes : page.likes)}
            />
            {!isLinkedIn && (
              <Field label="Instagram" value={page.igUsername} />
            )}
            {!isLinkedIn && (
              <Field label="IG followers" value={fmt(page.igFollowers)} />
            )}
            {isLinkedIn && (
              <Field label="LI employees" value={fmt(liEmployees)} />
            )}
            {ytSubs != null && (
              <Field label="YT subscribers" value={fmt(ytSubs)} />
            )}
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

          {others.length > 0 && (
            <div className="lookup-candidates">
              <h3>Other name matches considered</h3>
              <ul className="lookup-candidate-list">
                {others.map((c) => {
                  const busy =
                    fetchingCandidateId === c.pageId ||
                    (running && fetchingCandidateId != null);
                  return (
                    <li key={c.pageId} className="lookup-candidate-row">
                      <div className="lookup-candidate-meta">
                        <strong>{c.name}</strong>
                        <span className="muted">
                          {" "}
                          · {c.pageId}
                          {c.category ? ` · ${c.category}` : ""}
                          {c.likes != null ? ` · ${fmt(c.likes)} likes` : ""}
                        </span>
                      </div>
                      {onFetchCandidate && (
                        <button
                          type="button"
                          className="ghost-btn lookup-fetch-btn"
                          disabled={busy || running}
                          onClick={() => onFetchCandidate(c)}
                        >
                          {fetchingCandidateId === c.pageId
                            ? "Starting…"
                            : "Fetch ads"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      )}

      {showOffersTeaser ? (
        <>
          {reportError ? (
            <p className="error-text panel" role="alert">
              {reportError}
            </p>
          ) : null}
          <LookupOffersTeaser
            report={job.offersReport}
            running={analyzingOffers || regeneratingReport}
            generating={regeneratingReport}
            progress={job.progress}
            onOpen={() => {
              setShowOffersDash(true);
              if (typeof window !== "undefined") {
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
            onGenerate={
              ads.length > 0 && !analyzingOffers
                ? () => void regenerateOffersReport(true)
                : undefined
            }
          />
        </>
      ) : null}

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
              <AdCard
                key={ad.id}
                ad={ad}
                platform={platform}
                job={job}
                onAdUpdated={onAdUpdated}
                onJobUpdated={(next) => onJobUpdated?.(next)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
