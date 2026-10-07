"use client";

import { useRef, useState, type ReactNode } from "react";

/** An image the user added: a downscaled data URL, with an optional note for images the page must use. */
export type Screenshot = { id: string; name: string; dataUrl: string; caption?: string };

/**
 * "screenshots": pictures of the built page that show what to change (design feedback).
 * "assets": images the page must use, such as stats, product or team photos (before a build).
 */
export type ComposerKind = "screenshots" | "assets";

const LIMITS: Record<ComposerKind, { max: number; side: number }> = {
  screenshots: { max: 6, side: 2000 },
  assets: { max: 10, side: 2400 },
};
/** Stay well under the server's 10 MB per image. */
const MAX_DATA_URL_CHARS = 9_000_000;

/**
 * Downscales an image file to a data URL. Screenshots become JPEG; images
 * the page will use keep PNG (transparent product cut-outs), falling back to
 * WebP when the PNG is too large.
 */
async function toImage(file: File, kind: ComposerKind): Promise<Screenshot> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, LIMITS[kind].side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot read the image.");
  const keepAlpha = kind === "assets" && file.type === "image/png";
  if (!keepAlpha) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let dataUrl = keepAlpha ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", kind === "assets" ? 0.92 : 0.88);
  if (dataUrl.length > MAX_DATA_URL_CHARS) dataUrl = canvas.toDataURL("image/webp", 0.9);
  if (dataUrl.length > MAX_DATA_URL_CHARS) throw new Error("too large");
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || (kind === "assets" ? "image" : "screenshot"),
    dataUrl,
    caption: "",
  };
}

/**
 * One instructions box with images: pasted (Ctrl+V), dropped, or picked
 * from a file. Used for design feedback (screenshots of the parts to change)
 * and before a build (images the page must use, each with a short note).
 */
export function FeedbackComposer(props: {
  id: string;
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  screenshots: Screenshot[];
  onScreenshotsChange: (next: Screenshot[]) => void;
  kind?: ComposerKind;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
  hint?: ReactNode;
}) {
  const kind = props.kind || "screenshots";
  const { max } = LIMITS[kind];
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { screenshots, onScreenshotsChange, disabled } = props;
  const noun = kind === "assets" ? "images" : "screenshots";

  async function addFiles(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    const room = max - screenshots.length;
    if (room <= 0) {
      setNote(`Up to ${max} ${noun}.`);
      return;
    }
    setNote(images.length > room ? `Only the first ${room} added (up to ${max} ${noun}).` : null);
    const added: Screenshot[] = [];
    for (const file of images.slice(0, room)) {
      try {
        added.push(await toImage(file, kind));
      } catch {
        setNote("One image could not be added. Try a smaller PNG or JPEG.");
      }
    }
    if (added.length) onScreenshotsChange([...screenshots, ...added]);
  }

  const setCaption = (id: string, caption: string) =>
    onScreenshotsChange(screenshots.map((s) => (s.id === id ? { ...s, caption } : s)));

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
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 10, marginTop: 8 }}>
        {screenshots.map((shot, index) => (
          <div key={shot.id} style={{ width: kind === "assets" ? 150 : 96 }}>
            <figure
              style={{
                position: "relative",
                margin: 0,
                width: "100%",
                height: kind === "assets" ? 100 : 72,
                borderRadius: 6,
                overflow: "hidden",
                border: "1px solid rgba(15,23,42,0.15)",
                background: "#fff",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shot.dataUrl}
                alt={`${kind === "assets" ? "Image" : "Screenshot"} ${index + 1}`}
                style={{ width: "100%", height: "100%", objectFit: kind === "assets" ? "contain" : "cover" }}
              />
              <button
                type="button"
                aria-label={`Remove ${kind === "assets" ? "image" : "screenshot"} ${index + 1}`}
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
            {kind === "assets" ? (
              <input
                type="text"
                aria-label={`What image ${index + 1} shows`}
                maxLength={200}
                disabled={disabled}
                placeholder="What is it? e.g. 2024 results"
                value={shot.caption || ""}
                onChange={(e) => setCaption(shot.id, e.target.value)}
                style={{ width: "100%", marginTop: 4, fontSize: 12, padding: "4px 6px", boxSizing: "border-box" }}
              />
            ) : null}
          </div>
        ))}
        {screenshots.length < max ? (
          <button type="button" className="ghost-btn" disabled={disabled} onClick={() => fileInput.current?.click()}>
            {kind === "assets" ? "Add images" : "Add screenshot"}
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
        {kind === "assets"
          ? `Add images the page must use, such as stats, product photos, team or certificate images (up to ${max}; paste, drop or pick them). A short note on each helps place it in the right section.`
          : "Paste a screenshot (Ctrl+V) or drop one here to show the exact section you mean."}
        {props.value.trim() ? ` · ${props.value.trim().length}/4000` : ""}
        {note ? ` ${note}` : ""}
      </p>
      {props.hint}
    </div>
  );
}
