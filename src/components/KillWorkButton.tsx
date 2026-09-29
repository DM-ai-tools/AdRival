"use client";

import { useEffect, useState } from "react";

export function KillWorkButton({
  active = false,
  jobId,
  lookupId,
  onStopped,
}: {
  active?: boolean;
  jobId?: string | null;
  lookupId?: string | null;
  onStopped?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!result) return;
    const t = setTimeout(() => setResult(null), 6000);
    return () => clearTimeout(t);
  }, [result]);

  async function stopAll() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          all: true,
          jobId: jobId || undefined,
          lookupId: lookupId || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Work could not be stopped. Try again.");
      }
      const data = (await res.json().catch(() => ({}))) as {
        searchJobIds?: string[];
        lookupIds?: string[];
      };
      const count = (data.searchJobIds?.length ?? 0) + (data.lookupIds?.length ?? 0);
      setResult({
        tone: "ok",
        text: count ? `Stopped ${count} running task${count === 1 ? "" : "s"}.` : "Nothing was running.",
      });
      onStopped?.();
    } catch (err) {
      setResult({ tone: "error", text: (err as Error).message });
      onStopped?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="kill-work">
      <button
        type="button"
        className={`danger-btn kill-work-btn ${active ? "kill-work-live" : ""}`}
        onClick={() => void stopAll()}
        disabled={busy}
        title="Stop every search, lookup, brand review and offers report you have running"
      >
        {busy ? "Stopping…" : "Stop all my work"}
      </button>
      {result ? (
        <span
          className={result.tone === "error" ? "kill-work-note error-text" : "kill-work-note"}
          role={result.tone === "error" ? "alert" : "status"}
        >
          {result.text}
        </span>
      ) : null}
    </span>
  );
}
