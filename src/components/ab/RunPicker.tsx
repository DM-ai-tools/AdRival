"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { filterRuns, formatRunDate, groupRuns, type RunItem } from "@/lib/pipeline/awareness/runLabels";

const rk = (r: { kind: string; id: string }) => `${r.kind}:${r.id}`;
const kindLabel = (k: RunItem["kind"]) => (k === "lookup" ? "Lookup" : "Search");

function ranText(r: RunItem): string {
  const { label, relative } = formatRunDate(r.createdAt);
  return label ? `Ran ${label}${relative ? ` (${relative})` : ""}` : "";
}

/** Dated, searchable replacement for the run <select>. Makes no network calls. */
export function RunPicker({
  runs,
  value,
  onSelect,
}: {
  runs: RunItem[];
  value: { kind: "search" | "lookup"; id: string } | null;
  onSelect: (run: { kind: "search" | "lookup"; id: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();

  const groups = useMemo(() => groupRuns(filterRuns(runs, query)), [runs, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.runs), [groups]);
  const selected = value ? runs.find((r) => rk(r) === rk(value)) : undefined;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, open, baseId]);

  function openPicker() {
    setQuery("");
    const order = groupRuns(runs).flatMap((g) => g.runs);
    setActive(Math.max(0, value ? order.findIndex((r) => rk(r) === rk(value)) : 0));
    setOpen(true);
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function choose(r: RunItem) {
    close(true);
    onSelect({ kind: r.kind, id: r.id });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = flat[active];
      if (r) choose(r);
    }
  }

  const listId = `${baseId}-list`;
  let index = -1;

  return (
    <div className="ab-runpicker" ref={rootRef} onKeyDown={open ? onKeyDown : undefined}>
      <span className="muted" id={`${baseId}-label`}>
        Compare pages from
      </span>
      <button
        type="button"
        ref={buttonRef}
        className="ab-runpicker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby={`${baseId}-label ${baseId}-btn`}
        onClick={() => (open ? close(false) : openPicker())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <span id={`${baseId}-btn`} className="ab-runpicker-current">
          {selected ? (
            <>
              <span className="ab-runpicker-title">
                <span className="cta-badge">{kindLabel(selected.kind)}</span> {selected.title}
              </span>
              <span className="muted ab-runpicker-sub">
                {ranText(selected)}
                {selected.count != null ? ` · ${selected.count} ${selected.countLabel ?? ""}`.trimEnd() : ""}
              </span>
            </>
          ) : value ? (
            <span className="ab-runpicker-title">Current run</span>
          ) : (
            <span className="ab-runpicker-title muted">Choose a search or lookup</span>
          )}
        </span>
        <span aria-hidden="true" className="ab-runpicker-caret">
          ▾
        </span>
      </button>

      {open ? (
        <div className="ab-runpicker-pop">
          <input
            ref={searchRef}
            type="search"
            className="search-input ab-runpicker-search"
            placeholder="Search by name, business or date"
            aria-label="Search runs"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={flat[active] ? `${baseId}-opt-${active}` : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
          <div className="ab-runpicker-scroll" id={listId} role="listbox" aria-label="Runs">
            {groups.length === 0 ? (
              <p className="muted ab-runpicker-empty">No runs match</p>
            ) : (
              groups.map((g) => (
                <div key={g.heading} role="group" aria-label={g.heading}>
                  <p className="ab-runpicker-group" aria-hidden="true">
                    {g.heading}
                  </p>
                  {g.runs.map((r) => {
                    index += 1;
                    const i = index;
                    const isSel = value ? rk(r) === rk(value) : false;
                    return (
                      <div
                        key={rk(r)}
                        id={`${baseId}-opt-${i}`}
                        role="option"
                        aria-selected={isSel}
                        className={`ab-runpicker-row${i === active ? " is-active" : ""}${isSel ? " is-selected" : ""}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(r)}
                      >
                        <span className="ab-runpicker-rowhead">
                          <strong>{r.title}</strong>
                          <span className="cta-badge">{kindLabel(r.kind)}</span>
                          {r.status ? <span className="location-badge is-unknown">{r.status}</span> : null}
                        </span>
                        <span className="muted ab-runpicker-sub">
                          {ranText(r)}
                          {r.count != null ? ` · ${r.count} ${r.countLabel ?? ""}`.trimEnd() : ""}
                        </span>
                        {r.subtitle ? <span className="muted ab-runpicker-sub">{r.subtitle}</span> : null}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
