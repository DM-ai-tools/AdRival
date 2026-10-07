"use client";

import { useRef, useState, type ReactNode } from "react";

/** An image the user pasted or dropped, ready to send (a downscaled JPEG data URL). */
export type Screenshot = { id: string; name: string; dataUrl: string };

export const MAX_SCREENSHOTS = 6;
/** Longest side after downscaling: enough to read text in a section screenshot. */
const MAX_SIDE = 2000;

/** Downscales an image file and turns it into a JPEG data URL. */
async function toScreenshot(file: File): Promise<Screenshot> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot read the image.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "screenshot",
    dataUrl: canvas.toDataURL("image/jpeg", 0.88),
  };
}

/**
 * One feedback box for content and design. Screenshots can be pasted into it
 * (Ctrl+V), dropped on it, or picked from a file, to show the exact section.
 */
export function FeedbackComposer(props: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  screenshots: Screenshot[];
  onScreenshotsChange: (next: Screenshot[]) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  hint?: ReactNode;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { screenshots, onScreenshotsChange, disabled } = props;

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const room = MAX_SCREENSHOTS - screenshots.length;
    if (room <= 0) {
      setNote(`Up to ${MAX_SCREENSHOTS} screenshots.`);
      return;
    }
    setNote(images.length > room ? `Only the first ${room} added (up to ${MAX_SCREENSHOTS} screenshots).` : null);
    const added: Screenshot[] = [];
    for (const file of images.slice(0, room)) {
      try {
        added.push(await toScreenshot(file));
      } catch {
        setNote("One image could not be read. Try a PNG or JPEG screenshot.");
      }
    }
    if (added.length) onScreenshotsChange([...screenshots, ...added]);
  }

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        if (Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (disabled) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (files.some((f) => f.type.startsWith("image/"))) {
          e.preventDefault();
          void addFiles(files);
        }
      }}
    >
      <label htmlFor={props.id} className="recreate-feedback-label">
        {props.label}
      </label>
      <textarea
        id={props.id}
        className="recreate-feedback-input"
        rows={props.rows ?? 4}
        maxLength={4000}
        disabled={disabled}
        placeholder={props.placeholder}
        value={props.value}
        style={dragging ? { outline: "2px dashed currentColor", outlineOffset: 2 } : undefined}
        onChange={(e) => props.onChange(e.target.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.items)
            .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
            .map((item) => item.getAsFile())
            .filter((f): f is File => Boolean(f));
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
      />
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 }}>
        {screenshots.map((shot, index) => (
          <figure
            key={shot.id}
            style={{ position: "relative", margin: 0, width: 96, height: 72, borderRadius: 6, overflow: "hidden", border: "1px solid rgba(15,23,42,0.15)" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={shot.dataUrl} alt={`Screenshot ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            <button
              type="button"
              aria-label={`Remove screenshot ${index + 1}`}
              disabled={disabled}
              onClick={() => onScreenshotsChange(screenshots.filter((s) => s.id !== shot.id))}
              style={{
                position: "absolute",
                top: 2,
                right: 2,
                width: 22,
                height: 22,
                borderRadius: 11,
                border: "none",
                background: "rgba(15,23,42,0.75)",
                color: "#fff",
                cursor: "pointer",
                lineHeight: "22px",
                padding: 0,
              }}
            >
              ×
            </button>
          </figure>
        ))}
        {screenshots.length < MAX_SCREENSHOTS ? (
          <button type="button" className="ghost-btn" disabled={disabled} onClick={() => fileInput.current?.click()}>
            Add screenshot
          </button>
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(Array.from(e.target.files || []));
            e.target.value = "";
          }}
        />
      </div>
      <p className="muted recreate-feedback-hint">
        Paste a screenshot (Ctrl+V) or drop one here to show the exact section you mean.
        {props.value.trim() ? ` · ${props.value.trim().length}/4000` : ""}
        {note ? ` ${note}` : ""}
      </p>
      {props.hint}
    </div>
  );
}
