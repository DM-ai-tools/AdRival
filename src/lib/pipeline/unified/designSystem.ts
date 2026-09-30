import type { BrandColors, BrandDesignSystem } from "../../types";
import type { BlueprintFormStyle, DesignShape } from "./blueprint";
import type { StyleDirection } from "../skills/playbook";

/**
 * One stylesheet for the whole recreated page: the competitor's measured
 * shape (type scale, spacing, corners, buttons, cards, form fields) dressed
 * in the client's colours and fonts. Every section uses these classes, so the
 * page reads as one design instead of a collage of separately styled blocks.
 */

export type DesignSystem = {
  css: string;
  /** Google Fonts stylesheet links for the chosen families. */
  fontLinks: string[];
  /** Class reference given to the model. */
  vocabulary: string;
  tokens: Record<string, string>;
  /** Heading and body families, for the DESIGN.md style file. */
  families: { heading: string; body: string };
  style: StyleDirection;
};

const clamp = (value: number | null | undefined, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = (hex || "").replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const n = Number.parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  const t = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * t(rgb.r) + 0.7152 * t(rgb.g) + 0.0722 * t(rgb.b);
}

function mix(hex: string, withHex: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(withHex);
  if (!a || !b) return hex;
  const m = (x: number, y: number) => Math.round(x * (1 - amount) + y * amount);
  return `#${[m(a.r, b.r), m(a.g, b.g), m(a.b, b.b)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** Readable text on a fill. */
function onColor(fill: string): string {
  return luminance(fill) > 0.45 ? "#0B1220" : "#FFFFFF";
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A brand colour dark enough to carry white text for dark bands. */
function darkSurface(colors: BrandColors): string {
  const candidates = [colors.secondary, colors.primary, colors.text].filter(Boolean) as string[];
  for (const c of candidates) if (luminance(c) < 0.12) return c;
  return mix(candidates[0] || "#0F172A", "#000000", 0.7);
}

function familyName(raw: string | null | undefined): string | null {
  const name = (raw || "").split(",")[0].replace(/["']/g, "").trim();
  if (!name || /^(system-ui|sans-serif|serif|inherit|initial|-apple-system|arial|helvetica|times new roman|georgia)$/i.test(name)) {
    return null;
  }
  return name;
}

function googleFontLink(family: string): string {
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, "+")}:wght@400;500;600;700;800&display=swap`;
}

function typeRule(sample: DesignShape["h1"], fallback: { size: number; weight: number; lh: number }, min: number, max: number) {
  const size = clamp(sample?.size, min, max, fallback.size);
  const weight = clamp(sample?.weight, 300, 900, fallback.weight);
  const lh = clamp(sample?.lineHeight, 0.95, 1.8, fallback.lh);
  const ls = clamp(sample?.letterSpacing, -0.06, 0.2, 0);
  const transform = sample?.transform && sample.transform !== "none" ? sample.transform : "none";
  return { size, weight, lh, ls, transform };
}

/** Fluid size: shrinks on phones, reaches the competitor's size on desktop. */
function fluid(px: number, floor: number): string {
  const min = Math.max(floor, Math.round(px * 0.62));
  if (min >= px) return `${px}px`;
  const vw = Math.round((px / 1280) * 100 * 100) / 100;
  return `clamp(${min}px, ${vw}vw, ${px}px)`;
}

const CONDENSED =
  /condensed|compressed|narrow|\banton\b|bebas|oswald|league gothic|fjalla|\bteko\b|big shoulders|pathway gothic|six caps|antonio|staatliches|sofia sans (extra )?condensed/i;

/** Surface rules for the chosen style direction (Taste Skill), on top of the brand tokens. */
function styleCss(style: StyleDirection): string {
  if (style === "minimal") {
    return `/* style: minimal */
.adr-card,.adr-form-panel{border:1px solid var(--border)}
.adr-btn{box-shadow:none}
.adr-badge{background:transparent;padding-inline:0}
.adr-icon{background:transparent;border:1px solid var(--border)}`;
  }
  if (style === "soft") {
    return `/* style: high-end soft */
.adr-card,.adr-form-panel{border:1px solid color-mix(in srgb, var(--text) 6%, transparent)}
.adr-btn{transition:transform .5s cubic-bezier(.32,.72,0,1),box-shadow .5s cubic-bezier(.32,.72,0,1)}
.adr-btn:active{transform:scale(.98)}
.adr-media{border-radius:calc(var(--radius-card) + 4px)}`;
  }
  if (style === "brutalist") {
    return `/* style: bold / brutalist */
.adr-card,.adr-form-panel,.adr-media{border:2px solid var(--text);box-shadow:none}
.adr-section--dark .adr-card{border-color:rgba(255,255,255,.7)}
h1,h2{letter-spacing:-.03em;line-height:1;font-weight:800}
.adr-btn{border:2px solid currentColor;box-shadow:none}
.adr-btn--primary{border-color:var(--btn-bg)}
.adr-section+.adr-section{border-top:2px solid color-mix(in srgb, var(--text) 85%, transparent)}`;
  }
  return "";
}

export function buildDesignSystem(input: {
  shape: DesignShape | null;
  colors: BrandColors;
  brandDesign?: BrandDesignSystem | null;
  formStyle?: BlueprintFormStyle | null;
  /** Fonts for the client's industry (UI UX Pro Max), used when the brand has none. */
  industryFonts?: { heading: string; body: string } | null;
  style?: StyleDirection | null;
}): DesignSystem {
  const style: StyleDirection = input.style || "brand";
  const shape = input.shape;
  const colors = input.colors;
  const primary = colors.primary || "#0F7A6C";
  const secondary = colors.secondary || mix(primary, "#000000", 0.4);
  const accent = colors.accent || primary;
  const background = colors.background || "#FFFFFF";
  const text = colors.text || "#0F172A";
  const dark = darkSurface(colors);
  // Primary buttons: the brand colour when it reads on the page, else the accent.
  const buttonFill = contrast(primary, background) >= 2.2 ? primary : accent;
  const textSafe = contrast(primary, background) >= 4.5 ? primary : mix(primary, "#000000", 0.45);
  // Highlight colour on dark bands: the brand colour if it reads, else a lighter
  // tint. Checked against the lighter dark-band card too, at WCAG AA (4.5:1).
  const darkCard = mix(dark, "#FFFFFF", 0.18);
  const onDarkAccent = [primary, accent, mix(primary, "#FFFFFF", 0.45), mix(primary, "#FFFFFF", 0.7)].find(
    (c) => contrast(c, dark) >= 4.5 && contrast(c, darkCard) >= 4.5,
  ) || "#FFFFFF";

  // Fonts: the client's own, else a pairing chosen for the client's industry,
  // else the competitor's family so the feel carries over.
  const brandFonts = [
    input.brandDesign?.typography?.fontFamilies?.heading,
    input.brandDesign?.typography?.fontFamilies?.primary,
    ...(input.brandDesign?.fonts || []),
  ]
    .map(familyName)
    .filter((f): f is string => Boolean(f));
  const industryHeading = familyName(input.industryFonts?.heading);
  const industryBody = familyName(input.industryFonts?.body);
  const headingFamily = brandFonts[0] || industryHeading || familyName(shape?.h1?.family || shape?.h2?.family) || "Inter";
  const bodyFamily =
    brandFonts[1] || brandFonts[0] || (brandFonts.length ? null : industryBody) || familyName(shape?.body?.family) || headingFamily;
  const families = [...new Set([headingFamily, bodyFamily])];

  const h1 = typeRule(shape?.h1 || null, { size: 56, weight: 800, lh: 1.05 }, 36, 96);
  const h2 = typeRule(shape?.h2 || null, { size: 40, weight: 700, lh: 1.12 }, 26, 64);
  // The competitor's sizes are for its own font. A condensed display face
  // (Anton, Bebas, Oswald…) fits far more letters per line than a normal one,
  // so the same size in the client's font would double the headline's lines.
  if (CONDENSED.test(shape?.h1?.family || shape?.h2?.family || "") && !CONDENSED.test(headingFamily)) {
    h1.size = Math.max(36, Math.round(h1.size * 0.68));
    h2.size = Math.max(26, Math.round(h2.size * 0.75));
  }
  const h3 = typeRule(shape?.h3 || null, { size: 22, weight: 700, lh: 1.3 }, 17, 32);
  const body = typeRule(shape?.body || null, { size: 17, weight: 400, lh: 1.6 }, 15, 20);
  // Body text in caps is almost always an eyebrow sample; never uppercase paragraphs.
  body.transform = "none";

  const sectionYBase = clamp(shape?.sectionPadding, 48, 140, 88);
  // Style directions (Taste Skill): more room for minimal and soft looks.
  const sectionY = Math.round(sectionYBase * (style === "minimal" ? 1.2 : style === "soft" ? 1.3 : 1));
  const container = clamp(shape?.container, 960, 1320, 1140);
  const btnRadiusRaw = shape?.button?.radius;
  const btnRadiusShape = btnRadiusRaw != null && btnRadiusRaw >= 40 ? 999 : clamp(btnRadiusRaw, 0, 32, 10);
  const btnRadius = style === "minimal" ? 6 : style === "soft" ? 999 : style === "brutalist" ? 0 : btnRadiusShape;
  const btnPadY = clamp(shape?.button?.paddingY, 10, 22, 14);
  const btnPadX = clamp(shape?.button?.paddingX, 18, 44, 26);
  const btnWeight = clamp(shape?.button?.weight, 500, 800, 600);
  const btnTransform = shape?.button?.transform && shape.button.transform !== "none" ? shape.button.transform : "none";
  const cardRadiusShape = clamp(shape?.cardRadius, 0, 32, 14);
  const cardRadius =
    style === "minimal" ? Math.min(cardRadiusShape, 10) : style === "soft" ? Math.max(20, Math.min(28, cardRadiusShape + 8)) : style === "brutalist" ? 0 : cardRadiusShape;
  const cardShadow = style === "minimal" || style === "brutalist" ? false : style === "soft" ? true : shape?.cardShadow ?? true;
  const cardBorder = style === "minimal" || style === "brutalist" ? true : style === "soft" ? false : shape?.cardBorder ?? !cardShadow;
  const form = input.formStyle;
  const inputRadiusShape = form?.inputRadius != null ? (form.inputRadius >= 40 ? 999 : clamp(form.inputRadius, 0, 20, 10)) : Math.min(btnRadius === 999 ? 12 : btnRadius, 14);
  const inputRadius = style === "minimal" ? 6 : style === "soft" ? 14 : style === "brutalist" ? 0 : inputRadiusShape;
  const inputHeight = clamp(form?.inputHeight, 40, 60, 48);
  const underline = form?.inputBorder === "underline";
  const filled = Boolean(form?.inputFilled);
  const useGradient = (shape?.gradientBands || 0) > 0 && style !== "minimal" && style !== "brutalist";
  const eyebrowPill = Boolean(shape?.eyebrow?.pill) && style !== "brutalist";

  const tokens: Record<string, string> = {
    "--primary": primary,
    "--secondary": secondary,
    "--accent": accent,
    "--bg": background,
    "--bg-alt": mix(background, primary, 0.05),
    "--bg-dark": dark,
    "--text": text,
    "--text-muted": mix(text, background, 0.35),
    "--text-on-dark": "#FFFFFF",
    "--text-safe": textSafe,
    "--accent-on-dark": onDarkAccent,
    "--btn-bg": buttonFill,
    "--btn-text": onColor(buttonFill),
    "--on-primary": onColor(primary),
    "--border": mix(text, background, 0.86),
    "--gradient": `linear-gradient(135deg, ${primary} 0%, ${mix(primary, accent === primary ? secondary : accent, 0.65)} 100%)`,
    "--font-heading": `"${headingFamily}", system-ui, -apple-system, "Segoe UI", sans-serif`,
    "--font-body": `"${bodyFamily}", system-ui, -apple-system, "Segoe UI", sans-serif`,
    "--h1": fluid(h1.size, 34),
    "--h2": fluid(h2.size, 26),
    "--h3": `${h3.size}px`,
    "--body": `${body.size}px`,
    "--section-y": fluid(sectionY, 48),
    "--container": `${container}px`,
    "--gutter": "20px",
    "--radius-btn": `${btnRadius}px`,
    "--radius-card": `${cardRadius}px`,
    "--radius-input": `${inputRadius}px`,
    // Shadows tinted to the brand hue, never plain black (Taste Skill 4.4).
    "--shadow-card": !cardShadow
      ? "none"
      : style === "soft"
        ? `0 24px 60px -28px ${mix(primary, "#0F172A", 0.55)}55, 0 2px 8px rgba(15, 23, 42, 0.04)`
        : `0 10px 30px ${mix(primary, "#0F172A", 0.7)}14, 0 2px 6px rgba(15, 23, 42, 0.05)`,
    "--gap": "24px",
  };

  // Dark and brand-coloured bands get their own readable tokens, so icons,
  // links, muted text and borders never keep light-background colours there
  // (the design check's most common finding). Light panels inside those bands
  // (cards, forms) switch back.
  const onPrimary = onColor(primary);
  const bandCss = `/* readable tokens on dark and brand bands */
.adr-section--dark,.adr-header--dark,.adr-footer--dark{--text-safe:var(--accent-on-dark);--text-muted:${mix("#FFFFFF", dark, 0.1)};--border:rgba(255,255,255,.16)}
.adr-section--brand,.adr-section--gradient{--text-safe:var(--on-primary);--text-muted:${mix(onPrimary, primary, 0.25)};--border:${mix(onPrimary, primary, 0.7)}}
.adr-section--dark .adr-icon,.adr-footer--dark .adr-icon{background:rgba(255,255,255,.1);color:var(--text-on-dark)}
.adr-section--brand :is(.adr-card,.adr-form-panel),.adr-section--gradient :is(.adr-card,.adr-form-panel),.adr-section--dark .adr-form-panel{--text-safe:${textSafe};--text-muted:${mix(text, background, 0.35)};--border:${mix(text, background, 0.86)}}`;

  // Quality floor from Vercel's guidelines and Impeccable: visible keyboard
  // focus, balanced headings, one-line buttons, 44px targets, reduced motion.
  const qualityCss = `/* layout rhythm */
.adr-card .adr-form-panel,.adr-form-panel .adr-form-panel{background:transparent;box-shadow:none;border:0;padding:0;margin-top:20px}
.adr-section--dark .adr-card .adr-form-panel{color:inherit;--text-safe:var(--accent-on-dark);--text-muted:${mix("#FFFFFF", dark, 0.1)};--border:rgba(255,255,255,.16)}
.adr-field-label{display:block}
.adr-grid+*,.adr-split+*,.adr-faq+*,.adr-logos+*{margin-top:clamp(24px,3vw,40px)}
.adr-center :is(.adr-container,.adr-narrow,.adr-stack,.adr-section-head)>.adr-btn{display:flex;width:fit-content;margin-inline:auto}
div.adr-center{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
/* quality floor */
:where(a,button,input,select,textarea,summary,[tabindex]):focus-visible{outline:3px solid color-mix(in srgb, var(--primary) 65%, transparent);outline-offset:3px}
h1,h2,h3{text-wrap:balance}
p,li{text-wrap:pretty}
.adr-num{font-variant-numeric:tabular-nums}
.adr-btn,.adr-header-cta{min-height:44px}
@media (min-width:641px){.adr-btn,.adr-header-cta{white-space:nowrap}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}`;

  const root = Object.entries(tokens)
    .map(([k, v]) => `  ${k}:${v};`)
    .join("\n");

  const css = `/* adr-design-system */
:root{
${root}
}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:var(--body);line-height:${body.lh};-webkit-font-smoothing:antialiased}
img,svg,video{max-width:100%;height:auto;display:block}
a{color:inherit}
h1,h2,h3,h4{font-family:var(--font-heading);margin:0 0 .5em;color:inherit}
h1{font-size:var(--h1);font-weight:${h1.weight};line-height:${h1.lh};letter-spacing:${h1.ls}em;text-transform:${h1.transform}}
h2{font-size:var(--h2);font-weight:${h2.weight};line-height:${h2.lh};letter-spacing:${h2.ls}em;text-transform:${h2.transform}}
h3{font-size:var(--h3);font-weight:${h3.weight};line-height:${h3.lh};letter-spacing:${h3.ls}em}
h4{font-size:calc(var(--body) * 1.05);font-weight:700;line-height:1.35}
p{margin:0 0 1em}
ul,ol{margin:0 0 1em;padding-left:1.2em}
.adr-container{width:min(100% - var(--gutter) * 2, var(--container));margin-inline:auto}
.adr-narrow{max-width:760px;margin-inline:auto}
.adr-section{padding-block:var(--section-y);position:relative}
.adr-section--tight{padding-block:calc(var(--section-y) * .5)}
.adr-section--alt{background:var(--bg-alt)}
.adr-section--wash{background:radial-gradient(60% 60% at 15% 10%, color-mix(in srgb, var(--primary) 10%, transparent), transparent 70%),radial-gradient(50% 50% at 90% 20%, color-mix(in srgb, var(--accent) 9%, transparent), transparent 70%),var(--bg)}
.adr-section--dark{background:var(--bg-dark);color:var(--text-on-dark)}
.adr-section--brand{background:var(--primary);color:var(--on-primary)}
.adr-section--gradient{background:${useGradient ? "var(--gradient)" : "var(--primary)"};color:var(--on-primary)}
.adr-section--dark .adr-accent,.adr-section--dark .adr-num,.adr-section--dark .adr-eyebrow,.adr-section--dark .adr-link,.adr-header--dark .adr-accent,.adr-footer--dark .adr-accent{color:var(--accent-on-dark)}
.adr-section--brand .adr-accent,.adr-section--gradient .adr-accent{color:inherit;text-decoration:underline;text-decoration-thickness:.08em;text-underline-offset:.12em}
.adr-section--dark .adr-muted,.adr-section--brand .adr-muted,.adr-section--gradient .adr-muted{color:inherit;opacity:.78}
/* Centred sections centre headings, intro lines and button rows — never card bodies or forms. */
.adr-center :is(h1,h2,h3,p,.adr-eyebrow,.adr-lead,.adr-section-head):not(:is(.adr-card,.adr-form-panel,.adr-grid,.adr-split) *){text-align:center}
.adr-center .adr-row:not(:is(.adr-card,.adr-form-panel) *){justify-content:center}
.adr-center :is(.adr-lead,.adr-narrow,.adr-section-head):not(:is(.adr-card,.adr-form-panel) *){margin-inline:auto}
.adr-text-center{text-align:center}
.adr-card--center{text-align:center}
.adr-card--center .adr-icon{margin-inline:auto}
.adr-section-head{max-width:780px;margin:0 0 clamp(28px,4vw,48px)}
.adr-center .adr-section-head,.adr-section-head.adr-center{margin-inline:auto;text-align:center}
.adr-eyebrow{display:inline-block;font-size:${clamp(shape?.eyebrow?.size, 11, 15, 13)}px;font-weight:${clamp(shape?.eyebrow?.weight, 500, 800, 600)};letter-spacing:.14em;text-transform:uppercase;color:var(--text-safe);margin-bottom:14px${eyebrowPill ? ";padding:6px 14px;border-radius:999px;background:color-mix(in srgb, var(--primary) 12%, transparent)" : ""}}
.adr-section--dark .adr-eyebrow,.adr-section--brand .adr-eyebrow,.adr-section--gradient .adr-eyebrow{color:inherit;opacity:.85}
.adr-lead{font-size:calc(var(--body) * 1.15);line-height:1.6;max-width:680px}
.adr-muted{color:var(--text-muted)}
.adr-accent{color:var(--text-safe)}
.adr-grid{display:grid;gap:var(--gap)}
.adr-grid>*{min-width:0}
/* At most N columns, and never narrower than a readable card: a 4-card grid
   inside half of a split drops to 2 columns instead of 4 slivers. */
.adr-grid--2{grid-template-columns:repeat(auto-fit,minmax(min(100%,max(260px,calc((100% - var(--gap)) / 2))),1fr))}
.adr-grid--3{grid-template-columns:repeat(auto-fit,minmax(min(100%,max(230px,calc((100% - 2 * var(--gap)) / 3))),1fr))}
.adr-grid--4{grid-template-columns:repeat(auto-fit,minmax(min(100%,max(210px,calc((100% - 3 * var(--gap)) / 4))),1fr))}
.adr-grid--5{grid-template-columns:repeat(auto-fit,minmax(min(100%,max(180px,calc((100% - 4 * var(--gap)) / 5))),1fr))}
.adr-grid--6{grid-template-columns:repeat(auto-fit,minmax(min(100%,max(160px,calc((100% - 5 * var(--gap)) / 6))),1fr))}
.adr-split{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:clamp(28px,5vw,72px);align-items:center}
.adr-split--reverse>:first-child{order:2}
.adr-stack>*+*{margin-top:16px}
.adr-row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}
.adr-card{text-align:left;background:var(--bg);color:var(--text);border-radius:var(--radius-card);padding:clamp(20px,2.4vw,32px);box-shadow:var(--shadow-card);${cardBorder ? "border:1px solid var(--border);" : ""}}
.adr-section--alt .adr-card{background:var(--bg)}
.adr-section--dark .adr-card{background:${darkCard};color:var(--text-on-dark);box-shadow:none;border:1px solid rgba(255,255,255,.12)}
.adr-card h3{margin-bottom:.4em}
/* Card headings stay inside their card: smaller than section headings, long words wrap. */
.adr-grid :is(h3,h4),.adr-card :is(h3,h4){font-size:min(var(--h3),clamp(19px,1.1vw + 12px,26px));overflow-wrap:break-word;hyphens:auto}
h1,h2{overflow-wrap:break-word}
.adr-split>*{min-width:0}
.adr-card p:last-child{margin-bottom:0}
.adr-icon{width:48px;height:48px;border-radius:12px;display:grid;place-items:center;background:color-mix(in srgb, var(--primary) 14%, transparent);color:var(--text-safe);margin-bottom:16px;font-weight:700}
.adr-num{font-family:var(--font-heading);font-weight:800;font-size:clamp(32px,4vw,52px);line-height:1;color:var(--text-safe)}
.adr-section--dark .adr-num,.adr-section--brand .adr-num,.adr-section--gradient .adr-num{color:inherit}
.adr-list-check{list-style:none;padding:0}
.adr-list-check li{position:relative;padding-left:30px;margin-bottom:10px}
.adr-list-check li::before{content:"\\2713";position:absolute;left:0;top:0;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;background:color-mix(in srgb, var(--primary) 16%, transparent);color:var(--text-safe)}
.adr-quote{font-size:calc(var(--body) * 1.1);line-height:1.6}
.adr-quote cite{display:block;margin-top:14px;font-style:normal;font-weight:600}
.adr-logos{display:flex;flex-wrap:wrap;gap:clamp(24px,4vw,56px);align-items:center;justify-content:center}
.adr-logos img{max-height:44px;width:auto;opacity:.85}
.adr-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:${btnPadY}px ${btnPadX}px;border-radius:var(--radius-btn);font-family:var(--font-body);font-weight:${btnWeight};font-size:${clamp(shape?.button?.size, 14, 19, 16)}px;letter-spacing:${btnTransform === "uppercase" ? ".06em" : "0"};text-transform:${btnTransform};text-decoration:none;border:2px solid transparent;cursor:pointer;line-height:1.2;transition:transform .15s ease,box-shadow .15s ease;${shape?.button?.shadow ? "box-shadow:0 8px 20px color-mix(in srgb, var(--btn-bg) 35%, transparent);" : ""}}
.adr-btn:hover{transform:translateY(-1px)}
.adr-btn--primary{background:${useGradient ? "var(--gradient)" : "var(--btn-bg)"};color:var(--btn-text)}
.adr-btn--secondary{background:transparent;color:var(--text-safe);border-color:currentColor}
.adr-section--dark .adr-btn--secondary,.adr-section--brand .adr-btn--secondary,.adr-section--gradient .adr-btn--secondary{color:inherit}
.adr-section--brand .adr-btn--primary,.adr-section--gradient .adr-btn--primary{background:#fff;color:var(--text)}
.adr-link{color:var(--text-safe);font-weight:600;text-decoration:none}
.adr-link:hover{text-decoration:underline}
.adr-media{border-radius:var(--radius-card);overflow:hidden;background:var(--bg-alt)}
.adr-media img{width:100%;height:100%;object-fit:cover}
/* Labels laid over a photo get a solid chip so they read on any image. */
.adr-media{position:relative}
.adr-media>:is(.adr-badge,.adr-eyebrow,span,strong,p){background:color-mix(in srgb,var(--bg) 94%,transparent);color:var(--text);box-shadow:0 4px 14px rgba(15,23,42,.12);opacity:1;padding:6px 12px;border-radius:999px}
.adr-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;font-size:13px;font-weight:600;background:color-mix(in srgb, var(--primary) 12%, transparent);color:var(--text-safe)}
.adr-faq{max-width:860px;margin-inline:auto}
.adr-faq details{border-bottom:1px solid var(--border);padding:18px 0}
.adr-faq summary{cursor:pointer;font-family:var(--font-heading);font-weight:700;font-size:calc(var(--body) * 1.08);list-style:none;display:flex;justify-content:space-between;gap:16px}
.adr-faq summary::-webkit-details-marker{display:none}
.adr-faq summary::after{content:"+";font-weight:400;font-size:1.4em;line-height:1}
.adr-faq details[open] summary::after{content:"\\2212"}
.adr-faq details p{margin:12px 0 0}
.adr-form-panel{background:var(--bg);color:var(--text);border-radius:var(--radius-card);padding:clamp(22px,3vw,40px);box-shadow:var(--shadow-card);${cardBorder ? "border:1px solid var(--border);" : ""}}
.adr-form{display:grid;gap:16px;text-align:left}
.adr-form-grid{display:grid;grid-template-columns:repeat(${form?.perRow && form.perRow >= 2 ? Math.min(form.perRow, 3) : 2},minmax(0,1fr));gap:16px}
.adr-form-grid .adr-field--wide{grid-column:1/-1}
.adr-form fieldset{border:0;margin:0;padding:0;display:grid;gap:16px}
.adr-form legend{font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--text-safe);margin-bottom:6px;padding:0}
.adr-field{display:grid;gap:6px;font-size:14px;font-weight:600}
.adr-field .adr-req{color:var(--text-safe);margin-left:2px}
.adr-form input:not([type=checkbox]):not([type=radio]),.adr-form select,.adr-form textarea{width:100%;min-height:${inputHeight}px;padding:${underline ? "10px 2px" : "12px 14px"};font:inherit;font-weight:400;font-size:15px;color:var(--text);background:${filled ? "var(--bg-alt)" : "var(--bg)"};border:${underline ? "0" : "1px solid var(--border)"};${underline ? "border-bottom:1.5px solid var(--border);" : ""}border-radius:${underline ? "0" : "var(--radius-input)"};outline:none;transition:border-color .15s ease,box-shadow .15s ease}
.adr-form textarea{min-height:120px;resize:vertical}
.adr-form input:focus,.adr-form select:focus,.adr-form textarea:focus{border-color:var(--primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent)}
.adr-form [aria-invalid=true]{border-color:#DC2626}
.adr-choice{display:flex;flex-wrap:wrap;gap:10px}
.adr-choice label{display:flex;align-items:center;gap:8px;font-weight:500;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-input);cursor:pointer}
.adr-check{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px}
.adr-form .adr-btn{width:${form?.buttonFullWidth ? "100%" : "auto"};justify-self:${form?.buttonFullWidth ? "stretch" : "start"}}
.adr-form-note{font-size:13px;color:var(--text-muted);margin:0}
.adr-form-steps{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;padding:0;list-style:none}
.adr-form-steps li{font-size:13px;font-weight:600;padding:6px 12px;border-radius:999px;background:var(--bg-alt);color:var(--text-muted)}
.adr-form-steps li[aria-current=step]{background:var(--primary);color:var(--on-primary)}
.adr-form-step[hidden]{display:none}
.adr-form-nav{display:flex;gap:12px;justify-content:space-between;align-items:center}
.adr-form-success{padding:22px;border-radius:var(--radius-card);background:color-mix(in srgb, var(--primary) 10%, var(--bg));font-weight:600}
.adr-section--dark .adr-form-panel,.adr-section--brand .adr-form-panel,.adr-section--gradient .adr-form-panel{color:var(--text)}
.adr-header{background:var(--bg);border-bottom:1px solid var(--border);position:relative;z-index:5}
.adr-header--dark{background:var(--bg-dark);color:var(--text-on-dark);border-bottom-color:rgba(255,255,255,.1)}
.adr-header-inner{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:76px;padding-block:12px}
.adr-brand{display:inline-flex;align-items:center;text-decoration:none;flex-shrink:0}
.adr-brand img,img[data-logo-role="company"]{display:block;height:auto;max-height:48px;max-width:220px;width:auto;object-fit:contain;object-position:left center}
[data-logo-role="proof"]{display:block;height:auto;max-height:40px;max-width:140px;width:auto;object-fit:contain}
.adr-nav{display:flex;align-items:center;gap:clamp(14px,2.2vw,32px);list-style:none;margin:0;padding:0;flex-wrap:wrap}
.adr-nav a{text-decoration:none;font-weight:500;font-size:15px;color:inherit;opacity:.88}
.adr-nav a:hover{opacity:1}
.adr-header-cta{display:inline-flex;align-items:center;padding:${Math.max(10, btnPadY - 3)}px ${Math.max(16, btnPadX - 6)}px;border-radius:var(--radius-btn);background:var(--btn-bg);color:var(--btn-text);text-decoration:none;font-weight:${btnWeight};white-space:nowrap}
.adr-wordmark{font-family:var(--font-heading);font-weight:800;font-size:20px}
.adr-header .adr-btn{padding:${Math.max(10, btnPadY - 3)}px ${Math.max(16, btnPadX - 6)}px}
.adr-footer{background:var(--bg-alt);color:var(--text);padding:clamp(40px,6vw,72px) 0 28px}
.adr-footer--dark{background:var(--bg-dark);color:var(--text-on-dark)}
.adr-footer-grid{display:grid;grid-template-columns:minmax(200px,1.4fr) repeat(auto-fit,minmax(150px,1fr));gap:32px;align-items:start}
.adr-footer h3{font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin:0 0 14px;opacity:.75}
.adr-footer ul{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.adr-footer a{text-decoration:none;color:inherit;opacity:.85}
.adr-footer a:hover{opacity:1;text-decoration:underline}
.adr-footer-meta{margin-top:36px;padding-top:18px;border-top:1px solid color-mix(in srgb, currentColor 14%, transparent);display:flex;flex-wrap:wrap;gap:10px 24px;font-size:14px;opacity:.8}
img[data-adrival-slot]{display:block;width:100%;height:100%;object-fit:cover}
.adr-placeholder{background:var(--gradient);min-height:280px;border-radius:var(--radius-card);position:relative;overflow:hidden}
.adr-placeholder::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 30% 30%, rgba(255,255,255,.28), transparent 55%)}
@media (max-width:960px){
  .adr-header-inner{flex-wrap:wrap}
  .adr-nav{order:3;width:100%;gap:14px}
  .adr-grid--4,.adr-grid--5,.adr-grid--6{grid-template-columns:repeat(2,minmax(0,1fr))}
  .adr-grid--3{grid-template-columns:repeat(2,minmax(0,1fr))}
  .adr-split{grid-template-columns:1fr}
  .adr-split--reverse>:first-child{order:0}
}
@media (max-width:640px){
  .adr-grid--2,.adr-grid--3,.adr-grid--4,.adr-grid--5,.adr-grid--6,.adr-form-grid{grid-template-columns:1fr}
  .adr-container{width:min(100% - 32px, var(--container))}
  .adr-btn{width:100%}
}
${bandCss}
${qualityCss}
${styleCss(style)}`;

  const vocabulary = `CLASS SYSTEM (already defined in the page stylesheet — use these; do not restyle them):
- Section wrapper: <section class="adr-section [adr-section--alt|--wash|--dark|--brand|--gradient|--tight] [adr-center]" data-section-id="…"><div class="adr-container">…</div></section>
  Pick the variant that matches the competitor band: light page → none, tinted → --alt, soft light gradient glow → --wash, dark → --dark, strong colour → --brand, strong gradient → --gradient.
  adr-center centres the section heading block only; cards and forms stay left-aligned unless you add .adr-card--center (use it when the competitor's cards are centred).
- Heading block: <div class="adr-section-head"><span class="adr-eyebrow">…</span><h2>…</h2><p class="adr-lead">…</p></div>
- Type: plain h1/h2/h3/h4/p (already sized). Helpers: .adr-lead .adr-muted .adr-accent .adr-num (big stat number) .adr-badge
- Layout: .adr-grid + .adr-grid--2/3/4/5/6 (cards/columns), .adr-split (text + media, add .adr-split--reverse to swap sides), .adr-row (inline items), .adr-stack, .adr-narrow
- Components: .adr-card, .adr-icon (small tinted square, put an emoji-free glyph or number inside), .adr-list-check (tick list), .adr-quote (+ <cite>), .adr-logos (logo strip), .adr-faq (<details><summary>Q</summary><p>A</p></details>), .adr-media (image frame), .adr-placeholder (brand-coloured panel where no image is available)
- Buttons: <a class="adr-btn adr-btn--primary" href="…">…</a>, secondary: .adr-btn--secondary, text link: .adr-link
- Forms: never write form markup — put <div data-adrival-form></div> exactly where the competitor's form sits; the form is inserted there.
LAYOUT RULES: a card grid inside one column of .adr-split uses .adr-grid--2 at most (a heading beside 4 cards → heading column + 2×2 grid). Put 3+ cards in a row only at full container width. Do not lay text, labels or badges over images; put them beside or under the image.
RULES: no <style> blocks for colours, fonts, font sizes, buttons or cards. Only if a layout cannot be expressed with the classes, add ONE small <style> scoped to [data-section-id="…"] using var(--…) tokens — never hex colours, never :root, body or html.`;

  return {
    css,
    fontLinks: families.map(googleFontLink),
    vocabulary,
    tokens,
    families: { heading: headingFamily, body: bodyFamily },
    style,
  };
}
