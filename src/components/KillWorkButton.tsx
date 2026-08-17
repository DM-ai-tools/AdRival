"use client";

import { useState } from "react";

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

  async function stopAll() {
    setBusy(true);
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
        throw new Error(data.error || "Failed to stop work");
      }
      onStopped?.();
    } catch {
      onStopped?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`danger-btn kill-work-btn ${active ? "kill-work-live" : ""}`}
      onClick={() => void stopAll()}
      disabled={busy}
      title="Stop search, lookup, brand review, and offers analysis"
    >
      {busy ? "Stopping…" : active ? "Stop all work" : "Stop work"}
    </button>
  );
}
