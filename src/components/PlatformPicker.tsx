"use client";

import type { CSSProperties } from "react";
import {
  AD_PLATFORMS,
  PLATFORM_META,
  type AdPlatform,
} from "@/lib/platforms";

interface PlatformPickerProps {
  value: AdPlatform;
  onChange: (platform: AdPlatform) => void;
}

const railStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  width: "100%",
  marginBottom: 14,
};

const baseBtn: CSSProperties = {
  display: "inline-flex",
  flexDirection: "column",
  alignItems: "flex-start",
  justifyContent: "center",
  gap: 4,
  flex: "1 1 140px",
  minWidth: 140,
  minHeight: 72,
  padding: "14px 16px",
  margin: 0,
  cursor: "pointer",
  borderRadius: 14,
  borderWidth: 2,
  borderStyle: "solid",
  borderColor: "#9aabb6",
  background: "#ffffff",
  backgroundColor: "#ffffff",
  color: "#152028",
  fontFamily: "inherit",
  textAlign: "left",
  boxShadow: "0 4px 14px rgba(21, 32, 40, 0.1)",
  opacity: 1,
  visibility: "visible",
  appearance: "none",
  WebkitAppearance: "none",
};

const activeBtn: CSSProperties = {
  ...baseBtn,
  background: "#0f7a6c",
  backgroundColor: "#0f7a6c",
  borderColor: "#0b5f54",
  color: "#ffffff",
  boxShadow: "0 8px 20px rgba(15, 122, 108, 0.3)",
};

const labelStyle = (active: boolean): CSSProperties => ({
  display: "block",
  fontWeight: 700,
  fontSize: "0.98rem",
  lineHeight: 1.2,
  color: active ? "#ffffff" : "#152028",
});

const sourceStyle = (active: boolean): CSSProperties => ({
  display: "block",
  fontSize: "0.72rem",
  lineHeight: 1.3,
  color: active ? "rgba(255,255,255,0.88)" : "#5c6b76",
});

export function PlatformPicker({ value, onChange }: PlatformPickerProps) {
  return (
    <section
      className="platform-picker"
      style={{ marginBottom: 8, position: "relative", zIndex: 6 }}
      aria-label="Choose ad platform"
    >
      <p
        style={{
          margin: "0 0 10px",
          fontSize: "0.82rem",
          fontWeight: 700,
          letterSpacing: "0.02em",
          color: "#5c6b76",
        }}
      >
        Platform
      </p>
      <div role="listbox" aria-label="Ad platforms" style={railStyle}>
        {AD_PLATFORMS.map((p) => {
          const active = value === p;
          const meta = PLATFORM_META[p];
          return (
            <button
              key={p}
              type="button"
              role="option"
              aria-selected={active}
              aria-label={meta.label}
              title={meta.label}
              data-platform={p}
              data-active={active ? "true" : "false"}
              style={active ? activeBtn : baseBtn}
              onMouseEnter={(e) => {
                if (active) return;
                e.currentTarget.style.background = "#eef6f5";
                e.currentTarget.style.backgroundColor = "#eef6f5";
                e.currentTarget.style.borderColor = "#0f7a6c";
              }}
              onMouseLeave={(e) => {
                if (active) return;
                e.currentTarget.style.background = "#ffffff";
                e.currentTarget.style.backgroundColor = "#ffffff";
                e.currentTarget.style.borderColor = "#9aabb6";
              }}
              onClick={() => onChange(p)}
            >
              <span style={labelStyle(active)}>{meta.short}</span>
              <span style={sourceStyle(active)}>{meta.source}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
