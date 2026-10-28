"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { STYLE_OPTIONS, type RecreateDetails, type StyleDirection } from "@/lib/recreateClient";

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface RecreateDetailsInput extends RecreateDetails {
  userFeedback: string;
}

/**
 * The details a recreation is queued with, asked once when it is added: a
 * queued page starts with nobody present, so nothing is asked later.
 * Pre-filled with the run's defaults; one Confirm queues it.
 */
export function RecreateDetailsDialog({
  open,
  defaults,
  icpLabel = null,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  defaults: RecreateDetails;
  /** The audience the page is written for, when added from the A/B tab. */
  icpLabel?: string | null;
  busy?: boolean;
  error?: string | null;
  onConfirm: (details: RecreateDetailsInput) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const urlRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [businessUrl, setBusinessUrl] = useState(defaults.businessUrl);
  const [styleDirection, setStyleDirection] = useState<StyleDirection>(defaults.styleDirection);
  const [userFeedback, setUserFeedback] = useState("");

  // Fresh defaults every time it opens; focus goes back where it was on close.
  useEffect(() => {
    if (!open) return;
    setBusinessUrl(defaults.businessUrl);
    setStyleDirection(defaults.styleDirection);
    setUserFeedback("");
    const prev = document.activeElement as HTMLElement | null;
    urlRef.current?.focus();
    return () => prev?.focus?.();
    // Only on opening: later default changes must not wipe what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // While adding, every control is disabled; keep focus (and so the Tab trap) on the dialog itself.
  useEffect(() => {
    if (open && busy) formRef.current?.focus();
  }, [open, busy]);

  if (!open || typeof document === "undefined") return null;

  const canConfirm = Boolean(businessUrl.trim()) && !busy;
  const hint = STYLE_OPTIONS.find((o) => o.id === styleDirection)?.hint;

  return createPortal(
    <div
      className="confirm-overlay"
      role="presentation"
      // Kept inside: a host dialog (the ICP drawer) must not react to these.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          if (!busy) onCancel();
          return;
        }
        // Tab stays inside the dialog (it is portalled out of any host dialog's own trap).
        if (e.key !== "Tab" || !formRef.current) return;
        const items = Array.from(formRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) {
          e.preventDefault();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        const inside = active instanceof Node && formRef.current.contains(active);
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <form
        ref={formRef}
        tabIndex={-1}
        className="confirm-dialog recreate-details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy}
        onSubmit={(e) => {
          e.preventDefault();
          if (!canConfirm) return;
          onConfirm({ businessUrl: businessUrl.trim(), styleDirection, userFeedback: userFeedback.trim() });
        }}
      >
        <h3 id={titleId} className="confirm-title">
          Add to Recreate
        </h3>
        <p className="confirm-desc">
          The page is built with these details. It starts now when a slot is free, otherwise it waits its turn in
          the queue. It uses credits when it starts.
        </p>

        <div className="recreate-details-field">
          <label htmlFor={`${titleId}-url`} className="search-label">
            Your business website
          </label>
          <input
            id={`${titleId}-url`}
            ref={urlRef}
            type="text"
            inputMode="url"
            className="search-input"
            required
            value={businessUrl}
            disabled={busy}
            placeholder="https://yourbusiness.com"
            onChange={(e) => setBusinessUrl(e.target.value)}
          />
        </div>

        <div className="recreate-details-field">
          <label htmlFor={`${titleId}-style`} className="search-label">
            Look of the page
          </label>
          <select
            id={`${titleId}-style`}
            className="search-input"
            value={styleDirection}
            disabled={busy}
            onChange={(e) => setStyleDirection(e.target.value as StyleDirection)}
          >
            {STYLE_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
                {option.id === "brand" ? " (recommended)" : ""}
              </option>
            ))}
          </select>
          {hint ? <span className="muted recreate-details-hint">{hint}</span> : null}
        </div>

        {icpLabel ? (
          <p className="recreate-details-field muted">
            Written for: <strong>{icpLabel}</strong>
          </p>
        ) : null}

        <div className="recreate-details-field">
          <label htmlFor={`${titleId}-notes`} className="search-label">
            Instructions for the page <span className="muted">(optional)</span>
          </label>
          <textarea
            id={`${titleId}-notes`}
            className="search-input"
            rows={3}
            maxLength={4000}
            value={userFeedback}
            disabled={busy}
            placeholder="e.g. Lead with the free consultation, mention Melbourne, shorter FAQ answers…"
            onChange={(e) => setUserFeedback(e.target.value)}
          />
        </div>

        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}

        <div className="confirm-actions">
          <button type="button" className="chip-btn" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="chip-btn confirm-primary" disabled={!canConfirm}>
            {busy ? "Adding…" : "Confirm"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
