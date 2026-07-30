import type { BrandColors } from "../types";

/**
 * Rewrite common CSS custom properties onto the brand palette.
 */
export function rewriteBrandCssVariables(
  html: string,
  colors: BrandColors,
): string {
  return html.replace(
    /(--[\w-]*(?:primary|brand|accent|main|secondary|cta|button|theme|link|color)[\w-]*)\s*:\s*([^;!}{]+)/gi,
    (full, name: string) => {
      const lower = String(name).toLowerCase();
      if (/accent|cta/.test(lower) && !/secondary/.test(lower)) {
        return `${name}: ${colors.accent}`;
      }
      if (/secondary/.test(lower)) return `${name}: ${colors.secondary}`;
      if (/text|foreground|ink|body/.test(lower)) {
        return `${name}: ${colors.text}`;
      }
      if (
        /bg|background|surface|canvas/.test(lower) &&
        !/button|btn|cta/.test(lower)
      ) {
        return `${name}: ${colors.background}`;
      }
      if (/muted|subtle|gray|grey/.test(lower)) return `${name}: ${colors.muted}`;
      return `${name}: ${colors.primary}`;
    },
  );
}

/**
 * Scoped brand chrome — CTAs / CSS vars / theme-color.
 * Avoid flattening every heading and link (preserves section art direction).
 */
export function injectBrandColorOverlay(
  html: string,
  colors: BrandColors,
): string {
  let out = rewriteBrandCssVariables(html, colors);

  const overlay = `
<style id="adrival-brand-overlay">
:root, html {
  --adrival-primary: ${colors.primary};
  --adrival-secondary: ${colors.secondary};
  --adrival-accent: ${colors.accent};
  --adrival-text: ${colors.text};
  --adrival-bg: ${colors.background};
  --adrival-muted: ${colors.muted};
  --primary: ${colors.primary};
  --primary-color: ${colors.primary};
  --brand: ${colors.primary};
  --brand-color: ${colors.primary};
  --brand-primary: ${colors.primary};
  --color-primary: ${colors.primary};
  --color-secondary: ${colors.secondary};
  --color-accent: ${colors.accent};
  --accent: ${colors.accent};
  --accent-color: ${colors.accent};
  --secondary: ${colors.secondary};
  --bs-primary: ${colors.primary};
  --bs-primary-rgb: ${hexToRgbCsv(colors.primary)};
  --bs-link-color: ${colors.primary};
}
a.btn, a.button, button.btn, .btn-primary, .button-primary,
[class*="btn-primary"], [class*="btn_primary"],
[class*="cta-primary"], [class*="CtaPrimary"],
input[type="submit"], input[type="button"],
a[class*="cta"]:not([class*="secondary"]),
button[class*="cta"]:not([class*="secondary"]) {
  background-color: ${colors.primary} !important;
  background-image: none !important;
  border-color: ${colors.primary} !important;
  color: #fff !important;
}
a.btn:hover, a.button:hover, button.btn:hover, .btn-primary:hover,
[class*="btn-primary"]:hover, [class*="cta-primary"]:hover {
  background-color: ${colors.secondary} !important;
  border-color: ${colors.secondary} !important;
  color: #fff !important;
}
.highlight, [class*="text-accent"], [class*="textAccent"] {
  color: ${colors.accent} !important;
}
#adrival-draft-banner { background: ${colors.primary} !important; }
</style>
<meta name="theme-color" content="${colors.primary}">
<meta name="adrival-brand-source" content="${(colors.source || "site").replace(/"/g, "")}">
<meta name="adrival-brand-primary" content="${colors.primary}">
<meta name="adrival-brand-secondary" content="${colors.secondary}">
<meta name="adrival-brand-accent" content="${colors.accent}">
`;

  out = out.replace(/<style id="adrival-brand-overlay">[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<style id="adrival-brand-tokens">[\s\S]*?<\/style>/gi, "");
  out = out.replace(/<meta name="adrival-brand-source"[^>]*>/gi, "");
  out = out.replace(/<meta name="adrival-brand-primary"[^>]*>/gi, "");
  out = out.replace(/<meta name="adrival-brand-secondary"[^>]*>/gi, "");
  out = out.replace(/<meta name="adrival-brand-accent"[^>]*>/gi, "");
  out = out.replace(/<meta name="theme-color"[^>]*>/gi, "");

  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, `${overlay}</head>`);
  } else {
    out = overlay + out;
  }
  return out;
}

function hexToRgbCsv(hex: string): string {
  const h = hex.replace("#", "");
  if (h.length !== 6) return "15, 122, 108";
  return `${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}`;
}
