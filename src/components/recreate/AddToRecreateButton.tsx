"use client";

import Link from "next/link";
import { useState } from "react";
import {
  RecreateRequestError,
  bridgeLookupAd,
  enqueueRecreation,
  type EnqueueBody,
  type RecreateDetails,
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
  disabled = false,
  defaults = NO_DEFAULTS,
  className = "search-btn lp-analyze-btn",
}: {
  source: RecreateSource;
  signals?: { daysRunning: number | null; activeAds: number | null };
  icp?: { icpId: string; stage: string };
  /** Versions of this page made already; above 0 adds a "View versions" link. */
  versionCount?: number;
  disabled?: boolean;
  /** The popup's starting values (see defaultDetails); the website is empty when the host has none. */
  defaults?: RecreateDetails;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [added, setAdded] = useState(0);

  async function confirm(details: RecreateDetailsInput) {
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
      if ("competitorId" in source) target = { competitorId: source.competitorId, ...extra };
      else if ("lookupAdId" in source)
        target = { competitorId: await bridgeLookupAd(source.lookupAdId, details.businessUrl), ...extra };
      else target = { jobId: source.runId, url: source.url, ...extra };
      const { queuedAhead } = await enqueueRecreation(target);
      setStatus(queuedAhead > 0 ? "Added to queue" : "Started");
      setAdded((n) => n + 1);
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof RecreateRequestError ? err.message : "The page could not be added to Recreate. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  const days = signals?.daysRunning ?? null;
  const active = signals?.activeAds ?? null;
  const versions = versionCount + added;

  return (
    <span className="recreate-add">
      <button
        type="button"
        className={className}
        disabled={disabled || busy}
        title="Pick the details, then the page is built for your brand. It uses credits when the build starts."
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
        <Link className="recreate-add-versions" href="/?mode=recreate">
          View versions
        </Link>
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
