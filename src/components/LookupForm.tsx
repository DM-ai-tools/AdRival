"use client";

import { FormEvent, useState } from "react";
import type { AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";

interface LookupFormProps {
  platform: AdPlatform;
  onStarted: (lookupId: string, queryName: string, platform: AdPlatform) => void;
  disabled?: boolean;
}

export function LookupForm({ platform, onStarted, disabled }: LookupFormProps) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, platform }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start lookup");
      onStarted(data.lookupId, data.queryName, data.platform);
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
          disabled={disabled || loading || !name.trim()}
        >
          {loading ? "Starting…" : "Fetch ads"}
        </button>
      </div>
      <p className="form-hint">
        Resolves the advertiser on {meta.source}, verifies the match when names
        collide, then pulls creatives for preview and Excel export.
      </p>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
