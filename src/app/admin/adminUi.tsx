"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** fetch that returns the JSON body, or throws the server's error message. */
export async function adminFetch<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    headers: json !== undefined ? { "Content-Type": "application/json", ...(rest.headers || {}) } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** The value after it has stopped changing for `ms`. */
export function useDebouncedValue<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export type Notice = { tone: "ok" | "error"; text: string } | null;

/** A result message shown where the action happened. */
export function InlineNotice({ notice, onDismiss }: { notice: Notice; onDismiss?: () => void }) {
  if (!notice) return null;
  return (
    <div
      className={`admin-inline-notice ${notice.tone === "error" ? "is-error" : "is-ok"}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <span>{notice.text}</span>
      {onDismiss ? (
        <button type="button" className="link-btn" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

/** A value with a Copy button, e.g. a one-time temporary password. */
export function CopyValue({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="admin-copy-value">
      <span className="search-label">{label}</span>
      <div className="admin-copy-row">
        <code>{value}</code>
        <button
          type="button"
          className="chip-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {hint ? <p className="form-hint">{hint}</p> : null}
    </div>
  );
}

/** Panel that slides in from the right; Escape or the backdrop closes it. */
export function Drawer({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="admin-drawer-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="admin-drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="admin-drawer-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          <button ref={closeRef} type="button" className="chip-btn" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="admin-drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/** Simple sortable column header. */
export function SortHeader<K extends string>({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: K;
  sort: { key: K; dir: "asc" | "desc" };
  onSort: (key: K) => void;
}) {
  const active = sort.key === column;
  return (
    <th aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="admin-sort-btn" onClick={() => onSort(column)}>
        {label}
        <span aria-hidden="true">{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
}

/** Previous / next paging for client-side lists. */
export function Pager({
  page,
  pageCount,
  total,
  onPage,
}: {
  page: number;
  pageCount: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="admin-pager">
      <button type="button" className="chip-btn" disabled={page <= 0} onClick={() => onPage(page - 1)}>
        ← Previous
      </button>
      <span className="muted">
        Page {page + 1} of {pageCount} · {total} total
      </span>
      <button
        type="button"
        className="chip-btn"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
