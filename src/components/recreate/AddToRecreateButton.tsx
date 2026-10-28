"use client";

import { useRef, useState } from "react";
import {
  RecreateRequestError,
  addedStatusText,
  bridgeLookupAd,
  enqueueRecreation,
  type EnqueueBody,
  type LookupBridgeResult,
  type RecreateDetails,
  versionsHref,
} from "@/lib/recreateClient";
import { formatSignal } from "@/lib/recreateSignals";
import { stageNameText } from "@/lib/export/levelLabels";
import { RecreateDetailsDialog, type RecreateDetailsInput } from "./RecreateDetailsDialog";

/**
 * The page to recreate: a competitor record, a landing page of a search's
 * offers dashboard, or a lookup ad (made recreatable first by the lookup bridge).
 */
export type RecreateSource = { competitorId: string } | { runId: string; url: string } | { lookupAdId: string };

const NO_DEFAULTS: RecreateDetails = { businessUrl: "", styleDirection: "brand" };

function plural(n: number | null, word: string): string {
  return n === 1 ? word : `${word}s`;
}

/**
 * "Add to Recreate": asks for the details, then starts or queues the build.
 * Never leaves the current page. Days running and active ads sit beside it so
 * the choice can be made on the spot ("—" when unknown).
 */
export function AddToRecreateButton({
  source,
  signals,
  icp,
  versionCount = 0,
  sourceId = null,
  disabled = false,
  defaults = NO_DEFAULTS,
  className = "search-btn lp-analyze-btn",
  disabledReason,
  onLookupBridged,
}: {
  source: RecreateSource;
  signals?: { daysRunning: number | null; activeAds: number | null };
  icp?: { icpId: string; stage: string };
  /** Versions of this page made already; above 0 adds a "View versions" link. */
  versionCount?: number;
  /** The record the versions are made from, when the host knows it (a competitor source is its own). */
  sourceId?: string | null;
  disabled?: boolean;
  /** The popup's starting values (see defaultDetails); the website is empty when the host has none. */
  defaults?: RecreateDetails;
  className?: string;
  /** Tooltip while disabled, e.g. "View-only access". */
  disabledReason?: string;
  /** A lookup ad's bridge reply (the lookup and ad as they now stand), for the host to refresh. */
  onLookupBridged?: (result: LookupBridgeResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [added, setAdded] = useState(0);
  // The source record the server (or the lookup bridge) named for the last add.
  const [addedSourceId, setAddedSourceId] = useState<string | null>(null);
  // Set synchronously, so two submits in the same frame cannot bridge or queue twice.
  const submitting = useRef(false);

  async function confirm(details: RecreateDetailsInput) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const extra = {
        businessUrl: details.businessUrl,
        styleDirection: details.styleDirection,
        ...(details.userFeedback ? { userFeedback: details.userFeedback } : {}),
        ...(icp ? { icpId: icp.icpId } : {}),
      };
      let target: EnqueueBody;
      let bridgedId: string | null = null;
      if ("competitorId" in source) target = { competitorId: source.competitorId, ...extra };
      else if ("lookupAdId" in source) {
        // The bridge keeps the lookup's own website; the job carries the one typed here.
        const bridged = await bridgeLookupAd(source.lookupAdId);
        onLookupBridged?.(bridged);
        bridgedId = bridged.competitorId;
        target = { competitorId: bridged.competitorId, ...extra };
      } else target = { jobId: source.runId, url: source.url, ...extra };
      const { job, sourceId: madeFrom } = await enqueueRecreation(target);
      setAddedSourceId(madeFrom ?? bridgedId);
      setStatus(addedStatusText(job));
      setAdded((n) => n + 1);
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof RecreateRequestError ? err.message : "The page could not be added to Recreate. Try again.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const days = signals?.daysRunning ?? null;
  const active = signals?.activeAds ?? null;
  const versions = versionCount + added;
  const versionsOf = addedSourceId ?? sourceId ?? ("competitorId" in source ? source.competitorId : null);

  return (
    <span className="recreate-add">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        title={
          disabled && disabledReason
            ? disabledReason
            : "Pick the details, then the page is built for your brand. It uses credits when the build starts."
        }
        onClick={() => {
          setError(null);
          setStatus(null);
          setOpen(true);
        }}
      >
        {busy ? "Adding…" : "Add to Recreate"}
      </button>
      <span className="muted recreate-add-signals" title="Longest-running ad on this page, and ads still active">
        {formatSignal(days)}
        {days === null ? "" : ` ${plural(days, "day")}`} running · {formatSignal(active)} active{" "}
        {plural(active, "ad")}
      </span>
      {status ? (
        <span className="recreate-add-status" role="status">
          {status}
        </span>
      ) : null}
      {versions > 0 ? (
        // A full page load: the home page reads ?mode= and ?page= when it opens,
        // so a client-side link to the same route would change only the address.
        <a className="recreate-add-versions" href={versionsHref(versionsOf)}>
          View versions
        </a>
      ) : null}
      <RecreateDetailsDialog
        open={open}
        defaults={defaults}
        icpLabel={icp ? stageNameText(icp.stage) || icp.stage : null}
        busy={busy}
        error={error}
        onConfirm={(details) => void confirm(details)}
        onCancel={() => setOpen(false)}
      />
    </span>
  );
}
