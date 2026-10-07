"use client";

interface ExportButtonProps {
  jobId: string | null;
  disabled?: boolean;
}

/**
 * Downloads for a search run: the full report (every section, one sheet
 * each) and the competitors list on its own.
 */
export function ExportButton({ jobId, disabled }: ExportButtonProps) {
  if (!jobId) return null;

  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 8 }}>
      <a
        className="export-btn"
        href={`/api/export/full?jobId=${encodeURIComponent(jobId)}`}
        title="Everything in this run as one Excel file: your website, the search, competitors, landing pages, the offers dashboard and recreated pages, one sheet each."
      >
        Download full report
      </a>
      <a
        className={`export-btn ${disabled ? "disabled" : ""}`}
        href={disabled ? undefined : `/api/export?jobId=${encodeURIComponent(jobId)}`}
        aria-disabled={disabled}
        title="Only the competitors list."
      >
        Competitors (Excel)
      </a>
    </span>
  );
}
