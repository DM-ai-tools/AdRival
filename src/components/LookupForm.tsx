"use client";

import { FormEvent, useEffect, useState } from "react";
import type { AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";
import { RunBlockedNotice } from "@/components/RunCreditLine";
import { SPACE_EVENT, readSelectedSpaceId, runnableSpaceId } from "@/components/ClientSpaceBar";
import { formatCredits } from "@/lib/accounting/units";
import { useCredits } from "@/lib/credits/useCredits";

interface LookupFormProps {
  platform: AdPlatform;
  onStarted: (lookupId: string, queryName: string, platform: AdPlatform) => void;
  disabled?: boolean;
}

export function LookupForm({ platform, onStarted, disabled }: LookupFormProps) {
  const [name, setName] = useState("");
  const [businessUrl, setBusinessUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedCode, setBlockedCode] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const credits = useCredits();

  useEffect(() => {
    const sync = (id?: string | null) => setSpaceId(id || null);
    const onChange = (event: Event) =>
      sync(runnableSpaceId((event as CustomEvent<string>).detail));
    window.addEventListener(SPACE_EVENT, onChange);
    void fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data: { user?: { id?: string } | null }) =>
        sync(readSelectedSpaceId(data.user?.id ?? null)),
      )
      .catch(() => sync(null));
    return () => window.removeEventListener(SPACE_EVENT, onChange);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBlockedCode(null);
    setLoading(true);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          platform,
          businessUrl: businessUrl.trim() || undefined,
          spaceId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 402 || res.status === 403) {
          setBlockedCode(data.code || "insufficient_credits");
          setError(data.error || "This run was blocked.");
          void credits.refresh();
          return;
        }
        throw new Error(data.error || "Failed to start lookup");
      }
      onStarted(data.lookupId, data.queryName, data.platform);
      void credits.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const meta = PLATFORM_META[platform];

  return (
    <form onSubmit={handleSubmit} className="search-form">
      <label htmlFor="competitor-name" className="search-label">
        Competitor name — {meta.label}
      </label>
      <div className="search-row">
        <input
          id="competitor-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={
            platform === "linkedin"
              ? 'e.g. "WebFX" or "HubSpot"'
              : platform === "google" || platform === "youtube"
                ? 'e.g. "Nike" or "lululemon"'
                : 'e.g. "Single Grain"'
          }
          className="search-input"
          disabled={disabled || loading}
          required
        />
        <button
          type="submit"
          className="search-btn"
          disabled={disabled || loading || !name.trim() || !spaceId}
        >
          {loading ? "Starting…" : "Fetch ads"}
        </button>
      </div>
      <label htmlFor="lookup-business-url" className="search-label" style={{ marginTop: 12 }}>
        Your brand website{" "}
        <span className="muted">(for landing page content &amp; design)</span>
      </label>
      <input
        id="lookup-business-url"
        type="url"
        value={businessUrl}
        onChange={(e) => setBusinessUrl(e.target.value)}
        placeholder="https://yourbrand.com"
        className="search-input"
        disabled={disabled || loading}
      />
      <p className="form-hint">
        Resolves the advertiser on {meta.source}, verifies the match when names
        collide, then pulls creatives. Add your website to unlock Content + Design
        recreation for their landing pages.
      </p>
      {credits.data?.credits.unlimited ? (
        <p className="form-hint run-charge-note">
          This run is not credit-limited for administrators. Provider usage is
          still recorded.
        </p>
      ) : credits.data ? (
        <p className="form-hint run-charge-note">
          This run is charged to your account —{" "}
          {formatCredits(credits.data.credits.availableSubunits)} credits
          available.
        </p>
      ) : null}
      {blockedCode ? (
        <RunBlockedNotice message={error || ""} code={blockedCode} />
      ) : error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
