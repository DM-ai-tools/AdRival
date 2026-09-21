import type { CanonicalContent } from "../content/model";
import type { LayoutNode, LayoutSpec } from "./layoutSpec";
import type { DesignTokens } from "./tokens";
import type { PageLayoutEvidence } from "./layoutEvidence";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderInline(value: string): string {
  const escaped = escapeHtml(value.trim());
  return escaped.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n+/g, "<br>");
}

function css(tokens: DesignTokens, spec: LayoutSpec, evidence: PageLayoutEvidence): string {
  const rules = spec.sections.map((section) => {
    const node = section.nodes;
    const pad = Math.max(28, Math.min(node.gap ? node.gap + 36 : 56, 96));
    const measure = node.children.find((child) => child.kind === "content-group")?.width;
    return `
      [data-section-id="${section.id}"]{padding:${pad}px 0}
      [data-section-id="${section.id}"] .adr-measure{max-width:${measure ? `${Math.round(measure)}px` : "68ch"}}
    `;
  }).join("");
  const stacks = evidence.sections.some((section) => section.responsive.stacks !== false);
  return `
    .adr-page{margin:0;background:var(--page);color:var(--ink);font-family:${tokens.bodyFont || tokens.font};line-height:1.55}
    .adr-page *,.adr-page *::before,.adr-page *::after{box-sizing:border-box}
    .adr-page img{max-width:100%;height:auto}
    .adr-header,.adr-footer{background:var(--surface);color:var(--surface-ink);width:100%}
    .adr-header{position:relative}
    .adr-header .adr-bar,.adr-footer .adr-wrap{display:flex;align-items:center;gap:28px;width:min(1180px,calc(100% - 40px));margin:0 auto;padding:14px 0}
    .adr-header[data-arrangement="centered"] .adr-bar{justify-content:center;flex-wrap:wrap}
    .adr-header[data-arrangement="stacked"] .adr-bar{flex-direction:column;align-items:flex-start}
    .adr-brand{display:flex;align-items:center;min-height:40px}
    .adr-logo{height:52px;width:auto;max-width:220px;object-fit:contain;display:block}
    .adr-wordmark{font-weight:700;color:inherit;text-decoration:none}
    .adr-nav-toggle{display:none;background:transparent;color:inherit;border:1px solid var(--border);padding:8px 12px}
    .adr-nav,.adr-footer nav{display:flex;gap:18px;align-items:center;flex-wrap:wrap}
    .adr-nav{flex:1}
    .adr-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
    .adr-nav a,.adr-footer a{color:inherit;text-decoration:none}
    .adr-section a:not(.adr-btn){color:var(--primary)}
    .adr-nav a:focus,.adr-btn:focus,.adr-nav-toggle:focus{outline:2px solid var(--accent);outline-offset:3px}
    .adr-section{display:block;background:var(--page);color:var(--ink)}
    .adr-section[data-surface="surface"]{background:var(--surface);color:var(--surface-ink)}
    .adr-section[data-surface="contrast"]{background:var(--surface);color:var(--surface-ink)}
    .adr-section[data-surface="contrast"] h1,.adr-section[data-surface="contrast"] h2{color:var(--primary)}
    .adr-section[data-surface="accent"]{background:var(--primary);color:var(--primary-ink)}
    .adr-section[data-surface="accent"] h1,.adr-section[data-surface="accent"] h2{color:var(--primary-ink)}
    .adr-section[data-separator="border"]{border-top:1px solid var(--border)}
    .adr-section[data-separator="divider"]{box-shadow:inset 0 1px 0 var(--border)}
    .adr-stack,.adr-columns,.adr-repeated{width:min(var(--container,1120px),calc(100% - 32px));margin:0 auto}
    .adr-columns{display:grid;grid-template-columns:var(--cols);gap:var(--gap,32px);align-items:center}
    .adr-column{min-width:0}
    .adr-repeated{display:grid;grid-template-columns:var(--cols);gap:var(--gap,16px);align-items:stretch}
    .adr-item{min-width:0}
    .adr-item[data-bordered="true"]{border:1px solid var(--border);padding:16px;border-radius:var(--radius,0)}
    .adr-heading-group h1,.adr-column h1,.adr-stack h1,.adr-hero h1{font-family:${tokens.font};font-size:clamp(2rem,4vw,3.3rem);line-height:1.08;margin:0 0 12px;text-wrap:balance;color:var(--ink)}
    .adr-page h2,.adr-page h3{font-family:${tokens.font};color:var(--ink)}
    .adr-page h2{font-size:clamp(1.45rem,2.6vw,2.1rem);line-height:1.15;margin:0 0 12px;text-wrap:balance}
    .adr-section[data-surface="contrast"] h1,.adr-hero h1,.adr-hero .adr-display{color:#fff}
    .adr-kicker,.adr-card-icon,.adr-step-num{color:var(--primary)}
    [data-align="center"]{text-align:center}
    [data-align="end"]{text-align:end}
    .adr-page h3{font-size:1.05rem;margin:0 0 8px}
    .adr-page p{margin:0 0 12px}
    .adr-kicker{font-weight:700;font-size:1.05rem;margin:0 0 10px;letter-spacing:0;text-transform:none}
    .adr-hero h1.adr-kicker{color:var(--primary);font-size:1.15rem;max-width:none}
    .adr-cta-group,.adr-hero-copy .adr-cta-group{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
    .adr-btn{display:inline-flex;align-items:center;background:var(--primary);color:var(--primary-ink);padding:12px 20px;text-decoration:none;border:0;border-radius:999px;font-weight:700}
    .adr-btn-outline{background:transparent;color:inherit;border:1px solid currentColor}
    .adr-hero{position:relative;min-height:540px;display:flex;align-items:center;background:var(--surface) center/cover no-repeat;color:var(--surface-ink);padding:72px 0}
    .adr-hero-copy{width:min(720px,calc(100% - 48px));margin-left:max(24px,calc((100% - 1180px) / 2))}
    .adr-hero .adr-display,.adr-hero h1{font-size:clamp(2.4rem,5vw,3.8rem);line-height:1.05;max-width:16ch;font-weight:750}
    .adr-hero p{color:#fff;max-width:46ch}
    .adr-steps,.adr-cards{width:min(1120px,calc(100% - 40px));margin:8px auto 0;display:grid;grid-template-columns:var(--cols);gap:var(--gap,28px)}
    .adr-step-num{display:block;font-size:1.6rem;font-weight:750;margin-bottom:8px}
    .adr-card-icon{width:28px;height:28px;margin-bottom:12px}
    .adr-card h2,.adr-card h3,.adr-step h2{font-size:1.35rem;margin:0 0 10px}
    .adr-faq-item{border-bottom:1px solid var(--border);padding:12px 0}
    .adr-faq-item summary{cursor:pointer;font-weight:650}
    .adr-btn[data-link="unconfigured"]{background:transparent;color:inherit;border:1px solid var(--border)}
    .adr-btn:hover{filter:brightness(1.08)}
    .adr-visual{width:100%;object-fit:cover;display:block}
    .adr-media-band .adr-visual{width:100%;aspect-ratio:var(--ratio,16/9)}
    .adr-faq details{border-bottom:1px solid var(--border);padding:12px 0}
    .adr-faq summary{cursor:pointer;font-weight:650}
    .adr-footer{padding:28px 0}
    .adr-footer .adr-wrap{width:min(1120px,calc(100% - 32px));margin:0 auto;display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}
    @media (max-width:900px){
      .adr-columns,.adr-steps,.adr-cards{grid-template-columns:1fr}
      .adr-repeated{grid-template-columns:repeat(2,minmax(0,1fr))}
      .adr-actions{display:none}
    }
    @media (max-width:700px){
      .adr-nav-toggle{display:inline-flex}
      .adr-nav{display:none;position:absolute;top:100%;left:0;right:0;flex-direction:column;align-items:flex-start;background:var(--surface);color:var(--surface-ink);padding:12px 16px;z-index:2}
      .adr-nav.is-open{display:flex}
      .adr-repeated{grid-template-columns:1fr}
      ${stacks ? ".adr-columns .adr-column{order:0}" : ""}
    }
    @media (prefers-reduced-motion:reduce){
      .adr-page *,.adr-page *::before,.adr-page *::after{animation:none !important;transition:none !important}
    }
    ${rules}
  `;
}

function fieldHtml(fieldId: string, spec: LayoutSpec, headingTag: "h1" | "h2"): string {
  const section = spec.sections.find((item) => item.fields.some((field) => field.id === fieldId));
  const field = section?.fields.find((item) => item.id === fieldId);
  if (!field) return "";
  const attr = `data-field-id="${escapeHtml(field.id)}" data-role="${field.role}"`;
  if (field.role === "heading") return `<${headingTag} ${attr}>${renderInline(field.text)}</${headingTag}>`;
  if (field.role === "eyebrow") return `<p ${attr} class="adr-kicker">${renderInline(field.text)}</p>`;
  if (field.role === "paragraph" || field.role === "caption") return `<p ${attr} class="adr-measure">${renderInline(field.text)}</p>`;
  if (field.role === "list") {
    const items = field.items.length ? field.items : field.text.split(/\n+/);
    return `<ul ${attr}>${items.filter(Boolean).map((item) => `<li>${renderInline(item)}</li>`).join("")}</ul>`;
  }
  if (field.role === "cta") {
    if (!field.href) return `<button type="button" class="adr-btn" ${attr} data-link="unconfigured" disabled>${renderInline(field.text)}</button>`;
    return `<a class="adr-btn" ${attr} href="${escapeHtml(field.href)}">${renderInline(field.text)}</a>`;
  }
  if (field.role === "card") {
    return `<article ${attr} class="adr-item" data-bordered="true"><h3>${renderInline(field.text)}</h3>${field.items.map((item) => `<p>${renderInline(item)}</p>`).join("")}</article>`;
  }
  if (field.role === "faq") {
    return `<details ${attr}><summary>${renderInline(field.question || field.text)}</summary><p data-role="faq-answer">${renderInline(field.answer || "")}</p></details>`;
  }
  if (field.role === "quote") {
    return `<blockquote ${attr}><p>${renderInline(field.text)}</p>${field.items[0] ? `<cite>${renderInline(field.items[0])}</cite>` : ""}</blockquote>`;
  }
  return "";
}

function fieldsMarkup(ids: string[], spec: LayoutSpec, headingTag: "h1" | "h2"): string {
  return ids.map((id) => fieldHtml(id, spec, headingTag)).join("");
}

function visual(slotId: string, images: Map<string, string>, ratio: string): string {
  const src = images.get(slotId);
  if (!src) return "";
  return `<figure class="adr-media"><img class="adr-visual" style="aspect-ratio:${ratio}" data-adrival-gen-id="${escapeHtml(slotId)}" src="${src}" alt=""></figure>`;
}

function renderNode(node: LayoutNode, spec: LayoutSpec, headingTag: "h1" | "h2", images: Map<string, string>, ratio: string): string {
  if (node.kind === "columns") {
    const visible = node.children.filter((child) => {
      const emptyMedia = Boolean(child.assetSlotId) && !images.get(child.assetSlotId || "") && child.children.length === 0 && child.fieldIds.length === 0;
      return !emptyMedia;
    });
    const columns = visible.length === node.children.length ? node.columns : `repeat(${Math.max(visible.length, 1)},minmax(0,1fr))`;
    const children = visible.map((child) => renderNode(child, spec, headingTag, images, ratio)).join("");
    return `<div class="adr-columns" data-layout-node="${escapeHtml(node.id)}" data-display="grid" data-expected-children="${visible.length}" style="--cols:${columns};--gap:${node.gap || 32}px;--container:${node.width || 1120}px">${children}</div>`;
  }
  if (node.kind === "column") {
    const inner = node.children.length
      ? node.children.map((child) => renderNode(child, spec, headingTag, images, ratio)).join("")
      : fieldsMarkup(node.fieldIds, spec, headingTag);
    return `<div class="adr-column" data-layout-node="${escapeHtml(node.id)}">${inner}${node.assetSlotId ? visual(node.assetSlotId, images, ratio) : ""}</div>`;
  }
  if (node.kind === "repeated") {
    const children = node.children.map((child) => fieldHtml(child.fieldIds[0] || "", spec, headingTag)).join("");
    return `<div class="adr-repeated" data-layout-node="${escapeHtml(node.id)}" data-display="grid" data-expected-children="${node.expectedChildren || node.children.length}" style="--cols:${node.columns};--gap:${node.gap || 16}px;--container:${node.width || 1120}px">${children}</div>`;
  }
  if (node.kind === "hero") {
    let copy = fieldsMarkup(node.fieldIds, spec, "h2");
    let firstHeading = true;
    copy = copy.replace(/<h2 /g, () => {
      if (!firstHeading) return "<h2 ";
      firstHeading = false;
      return "<h1 class=\"adr-kicker\" ";
    });
    copy = copy.replace("</h2>", "</h1>");
    if (!copy.includes("adr-display")) copy = copy.replace("<p ", "<p class=\"adr-display\" ");
    return `<div class="adr-hero" data-layout-node="${escapeHtml(node.id)}"><div class="adr-hero-copy">${copy}</div></div>`;
  }
  if (node.kind === "steps") {
    const children = node.children.map((child, index) => `<article class="adr-step"><span class="adr-step-num">${String(index + 1).padStart(2, "0")}</span>${fieldsMarkup(child.fieldIds, spec, "h2")}</article>`).join("");
    return `<div class="adr-steps" data-layout-node="${escapeHtml(node.id)}" data-display="grid" data-expected-children="${node.expectedChildren || node.children.length}" style="--cols:${node.columns};--gap:${node.gap || 28}px">${children}</div>`;
  }
  if (node.kind === "cards") {
    const icons = [
      `<svg class="adr-card-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 9h16v11H4zm2-3h4l1 2h9v2H4z"/></svg>`,
      `<svg class="adr-card-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 6h10l1 3H6zm-1 5h12l-1 8H7z"/></svg>`,
      `<svg class="adr-card-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 7h8v3h4v9H4v-9h4zm2 0V5h4v2z"/></svg>`,
    ];
    const children = node.children.map((child, index) => `<article class="adr-card">${icons[index % icons.length]}${fieldsMarkup(child.fieldIds, spec, "h2")}</article>`).join("");
    return `<div class="adr-cards" data-layout-node="${escapeHtml(node.id)}" data-display="grid" data-expected-children="${node.expectedChildren || node.children.length}" style="--cols:${node.columns};--gap:${node.gap || 32}px">${children}</div>`;
  }
  if (node.kind === "faq" && node.children.length) {
    const items = node.children.map((child) => {
      const markup = fieldsMarkup(child.fieldIds, spec, "h2");
      const first = markup.match(/^<[^>]+>[\s\S]*?<\/[a-z0-9]+>/i)?.[0] || markup;
      const rest = markup.slice(first.length);
      return `<details class="adr-faq-item">${first ? `<summary>${first}</summary>` : ""}${rest}</details>`;
    }).join("");
    return `<div class="adr-faq" data-layout-node="${escapeHtml(node.id)}">${items}</div>`;
  }
  if (node.kind === "media") {
    return `<div class="adr-media-band" data-layout-node="${escapeHtml(node.id)}" style="--ratio:${ratio}">${node.assetSlotId ? visual(node.assetSlotId, images, ratio) : ""}</div>`;
  }
  if (node.kind === "heading-group" || node.kind === "content-group" || node.kind === "cta-group" || node.kind === "faq" || node.kind === "quote") {
    const className = node.kind === "cta-group" ? "adr-cta-group" : node.kind === "faq" ? "adr-faq" : node.kind === "heading-group" ? "adr-heading-group" : "adr-content-group";
    const align = node.align === "center" || node.align === "end" ? ` data-align="${node.align}"` : "";
    const wrap = node.width ? ` style="--container:${node.width}px"` : "";
    return `<div class="${className}${node.width ? " adr-stack" : ""}" data-layout-node="${escapeHtml(node.id)}"${align}${wrap}>${fieldsMarkup(node.fieldIds, spec, headingTag)}</div>`;
  }
  return node.children.map((child) => renderNode(child, spec, headingTag, images, ratio)).join("");
}

const RUNTIME = `<script>
(function () {
  var root = document.querySelector(".adr-page");
  if (!root || root.getAttribute("data-adr-bound") === "1") return;
  root.setAttribute("data-adr-bound", "1");
  var toggle = root.querySelector("[data-nav-toggle]");
  var nav = root.querySelector("[data-nav]");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
})();
</script>`;

export function renderConstructedPage(input: {
  snapshot: CanonicalContent;
  spec: LayoutSpec;
  evidence: PageLayoutEvidence;
  tokens: DesignTokens;
  logoUrl: string | null;
  nav: Array<{ label: string; href: string }>;
  actions?: Array<{ label: string; href: string; variant: "primary" | "outline" }>;
  footer: Array<{ label: string; href: string }>;
  images: Map<string, string>;
}): string {
  const arrangement = input.evidence.header.arrangement;
  const logo = input.logoUrl
    ? `<img class="adr-logo" data-logo-role="company" src="${escapeHtml(input.logoUrl)}" alt="${escapeHtml(input.snapshot.clientName)}">`
    : `<span class="adr-wordmark" data-logo-status="wordmark">${escapeHtml(input.snapshot.clientName)}</span>`;
  const brand = `<a class="adr-brand" href="${escapeHtml(input.snapshot.clientUrl)}">${logo}</a>`;
  const link = (item: { label: string; href: string }) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`;
  const actions = (input.actions || []).map((item) => `<a class="adr-btn${item.variant === "outline" ? " adr-btn-outline" : ""}" href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`).join("");
  let headingUsed = false;
  const sections = input.spec.sections.map((section) => {
    const tag = headingUsed ? "h2" : "h1";
    if (!headingUsed && section.fields.some((field) => field.role === "heading")) headingUsed = true;
    const ratio = aspectCss(section.aspect);
    const body = renderNode(section.nodes, input.spec, tag, input.images, ratio);
    const surface = section.nodes.surface || "page";
    const separator = section.nodes.separator || "whitespace";
    return `<section class="adr-section" data-section-id="${escapeHtml(section.id)}" data-composition="${escapeHtml(section.composition)}" data-surface="${escapeHtml(surface)}" data-separator="${escapeHtml(separator)}" data-source="${escapeHtml(section.source.slice(0, 180))}">${body}</section>`;
  }).join("");
  const fontLink = input.tokens.fontHref
    ? `<link rel="stylesheet" href="${escapeHtml(input.tokens.fontHref)}">`
    : "";
  const variables = `:root{--page:${input.tokens.page};--ink:${input.tokens.ink};--muted:${input.tokens.muted};--surface:${input.tokens.surface};--surface-ink:${input.tokens.surfaceInk};--contrast:${input.tokens.contrast};--contrast-ink:${input.tokens.contrastInk};--primary:${input.tokens.primary};--primary-ink:${input.tokens.primaryInk};--accent:${input.tokens.accent};--border:${input.tokens.border};--radius:${input.tokens.radius}}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.snapshot.meta.title || input.snapshot.clientName)}</title><meta name="description" content="${escapeHtml(input.snapshot.meta.description || "")}">${fontLink}<style>${variables}${css(input.tokens, input.spec, input.evidence)}</style></head><body class="adr-page" data-renderer="construct-2"><header class="adr-header" data-arrangement="${escapeHtml(arrangement)}"><div class="adr-bar">${brand}<button type="button" class="adr-nav-toggle" data-nav-toggle aria-expanded="false" aria-controls="adr-nav">Menu</button><nav id="adr-nav" class="adr-nav" data-nav aria-label="Primary">${input.nav.map(link).join("")}</nav>${actions ? `<div class="adr-actions">${actions}</div>` : ""}</div></header><main>${sections}</main><footer class="adr-footer" data-arrangement="${escapeHtml(input.evidence.footer.arrangement)}"><div class="adr-wrap">${brand}<nav aria-label="Footer">${input.footer.map(link).join("")}</nav></div></footer>${RUNTIME}</body></html>`;
}

function aspectCss(aspect: number | null): string {
  if (!aspect || aspect < 0.4 || aspect > 2.4) return "4 / 3";
  return `${Math.round(aspect * 100) / 100} / 1`;
}
