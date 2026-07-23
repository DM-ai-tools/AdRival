"use client";

import { FormEvent, useState } from "react";
import type { AdPlatform } from "@/lib/platforms";
import { PLATFORM_META } from "@/lib/platforms";

interface SearchFormProps {
  platform: AdPlatform;
  onStarted: (jobId: string, keywords: string[], platform: AdPlatform) => void;
  disabled?: boolean;
}

export function SearchForm({ platform, onStarted, disabled }: SearchFormProps) {
  const [keywordsText, setKeywordsText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keywords: keywordsText, platform }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start search");
      onStarted(data.jobId, data.keywords ?? [data.keyword], data.platform);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const meta = PLATFORM_META[platform];

  return (
    <form onSubmit={handleSubmit} className="search-form">
      <label htmlFor="keywords" className="search-label">
        Keywords — {meta.label}
      </label>
      <textarea
        id="keywords"
        value={keywordsText}
        onChange={(e) => setKeywordsText(e.target.value)}
        placeholder={'One per line or comma-separated\ne.g. Google Ads agency\nSEO audit agency'}
        className="search-textarea"
        disabled={disabled || loading}
        required
        rows={4}
      />
      <p className="form-hint">
        Source: {meta.source}. Enter multiple keywords to expand discovery in
        one run.
      </p>
      <div className="search-row">
        <button
          type="submit"
          className="search-btn"
          disabled={disabled || loading || !keywordsText.trim()}
        >
          {loading ? "Starting…" : `Find ${meta.short} competitors`}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}
