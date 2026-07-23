"use client";

interface ExportButtonProps {
  jobId: string | null;
  disabled?: boolean;
}

export function ExportButton({ jobId, disabled }: ExportButtonProps) {
  if (!jobId) return null;

  return (
    <a
      className={`export-btn ${disabled ? "disabled" : ""}`}
      href={disabled ? undefined : `/api/export?jobId=${jobId}`}
      aria-disabled={disabled}
    >
      Download Excel
    </a>
  );
}
