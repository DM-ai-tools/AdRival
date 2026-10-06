/**
 * Browser-side probes for the competitor blueprint. They are plain JavaScript
 * strings (not functions) so bundlers cannot inject helpers that do not exist
 * inside the page.
 */

/** CSS that reveals scroll-animated content and freezes motion before measuring. */
export const REVEAL_CSS = `
*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important}
[data-aos],[data-aos].aos-animate,.aos-init,.wow,.animated,.elementor-invisible,.reveal,.fade-in,.fadeIn,[class*="fade-up"],[class*="slide-up"],[data-animate],[data-scroll]{opacity:1!important;visibility:visible!important;transform:none!important}
`;

/** Shared helpers injected at the top of both probes. */
const HELPERS = String.raw`
var W = window.innerWidth;
function cs(el){ return getComputedStyle(el); }
function box(el){ var r = el.getBoundingClientRect(); return { x: Math.round(r.x + window.scrollX), y: Math.round(r.y + window.scrollY), width: Math.round(r.width), height: Math.round(r.height) }; }
function clean(t){ return String(t || '').replace(/\s+/g, ' ').trim(); }
function inHiddenLayer(el){
  for (var n = el; n && n !== document.body; n = n.parentElement) {
    var s = cs(n);
    if (s.display === 'none' || s.visibility === 'hidden') return true;
    if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') return true;
    if (n.tagName === 'DIALOG' && !n.open) return true;
    if (s.position === 'fixed' && n.tagName !== 'HEADER') return true;
  }
  return false;
}
function visible(el){
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  return !inHiddenLayer(el);
}
function px(v){ var n = parseFloat(v); return isFinite(n) ? Math.round(n * 10) / 10 : null; }
var __rgbCache = {}; var __ctx = null;
// Any CSS colour the browser understands (rgb, hex, oklch, lab, color-mix…)
// as rgba numbers: paint it on a 1x1 canvas and read the pixel back.
function parseRgb(c){
  var key = String(c || '').trim(); if (!key || key === 'transparent' || key === 'none') return null;
  if (key in __rgbCache) return __rgbCache[key];
  var out = null;
  var m = key.match(/^rgba?\(([^)]+)\)$/);
  if (m && key.indexOf('/') < 0) { var p = m[1].split(',').map(function(x){ return parseFloat(x); }); if (p.length >= 3 && p.every(function(v){ return isFinite(v); })) out = { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  if (!out) {
    try {
      if (!__ctx) { var cv = document.createElement('canvas'); cv.width = 1; cv.height = 1; __ctx = cv.getContext('2d', { willReadFrequently: true }); }
      __ctx.clearRect(0, 0, 1, 1); __ctx.fillStyle = 'rgba(0,0,0,0)'; __ctx.fillStyle = key; __ctx.fillRect(0, 0, 1, 1);
      var d = __ctx.getImageData(0, 0, 1, 1).data;
      out = d[3] === 0 ? { r: 0, g: 0, b: 0, a: 0 } : { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    } catch (e) { out = null; }
  }
  __rgbCache[key] = out; return out;
}
/** Colours inside a gradient, as rgb()/rgba() too. */
function normImage(img){ return String(img || '').replace(/(oklch|oklab|lch|lab|hsla?|hwb|color)\([^()]*\)/gi, function(c){ return norm(c); }); }
/** The first painted colour behind an element (itself, then its parents). */
function backdropOf(el){ for (var n = el; n; n = n.parentElement) { var bg = getComputedStyle(n).backgroundColor; if (painted(bg)) return norm(bg); } return 'rgb(255, 255, 255)'; }
/** The colour as rgb()/rgba(), so the pipeline never sees oklch() or lab(). */
function norm(c){ var p = parseRgb(c); if (!p) return c; return p.a >= 0.999 ? 'rgb(' + p.r + ', ' + p.g + ', ' + p.b + ')' : 'rgba(' + p.r + ', ' + p.g + ', ' + p.b + ', ' + Math.round(p.a * 100) / 100 + ')'; }
function lum(c){ var p = parseRgb(c); if (!p) return null; function t(v){ v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * t(p.r) + 0.7152 * t(p.g) + 0.0722 * t(p.b); }
function painted(c){ var p = parseRgb(c); return !!p && p.a > 0.05; }
`;

/** Returns sections, header, footer, design shape and main-document forms. */
export const BLUEPRINT_PROBE_SCRIPT = String.raw`(function(){
${HELPERS}
var VH = window.innerHeight;
function skipTag(el){ return /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|LINK|META|SVG|IFRAME)$/.test(el.tagName); }

// ---- header / footer ----
function findHeader(){
  var cands = Array.prototype.slice.call(document.querySelectorAll('header, [role="banner"], .site-header, #header, #masthead, .masthead, [data-elementor-type="header"], .elementor-location-header, [class*="site-header"], nav'));
  for (var i = 0; i < cands.length; i++) { var b = box(cands[i]); if (visible(cands[i]) && b.y < 220 && b.width > W * 0.6 && b.height < 260) return cands[i].tagName === 'NAV' ? (cands[i].closest('header') || cands[i]) : cands[i]; }
  return null;
}
function findFooter(){
  var cands = Array.prototype.slice.call(document.querySelectorAll('footer, [role="contentinfo"], .site-footer, #footer, #colophon, [data-elementor-type="footer"], .elementor-location-footer'));
  var best = null;
  for (var i = 0; i < cands.length; i++) { if (!visible(cands[i])) continue; var b = box(cands[i]); if (b.width < W * 0.6) continue; if (!best || b.y > box(best).y) best = cands[i]; }
  return best;
}
var header = findHeader();
var footer = findFooter();
function isChrome(el){ return (header && (el === header || header.contains(el) || el.contains(header) && el.contains(header) && false)) || (footer && (el === footer || footer.contains(el))); }

// ---- section bands ----
function wide(el){ var b = box(el); return b.width >= W * 0.6 && b.height >= 40; }
function headingCount(el){ var n = 0; var hs = el.querySelectorAll('h1,h2'); for (var i = 0; i < hs.length; i++) if (visible(hs[i])) n++; return n; }
// Children as laid out: look through display:contents wrappers (Framer, some
// React builders) and ignore absolutely positioned decoration layers.
function layoutKids(el){
  var out = [];
  for (var i = 0; i < el.children.length; i++) {
    var c = el.children[i];
    if (skipTag(c)) continue;
    var s = cs(c);
    if (s.display === 'contents') { out = out.concat(layoutKids(c)); continue; }
    out.push(c);
  }
  var flow = out.filter(function(c){ var p = cs(c).position; return p !== 'absolute' && p !== 'fixed'; });
  return flow.length ? flow : out;
}
function kidsOf(el){
  var out = [];
  var list = layoutKids(el);
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (skipTag(c) || !visible(c) || !wide(c)) continue;
    if (header && (c === header || header.contains(c))) continue;
    if (footer && (c === footer || footer.contains(c))) continue;
    if (header && c.contains(header) && footer && c.contains(footer)) { out.push(c); continue; }
    out.push(c);
  }
  return out;
}
function stacked(list){ for (var i = 1; i < list.length; i++) { var a = box(list[i - 1]), b = box(list[i]); if (b.y < a.y + a.height - 12) return false; } return true; }
function split(el, depth){
  var kids = kidsOf(el);
  // Descend through wrappers that hold header/main/footer or a single child.
  var containsChrome = (header && el.contains(header)) || (footer && el.contains(footer));
  if (depth < 12 && kids.length === 1) return split(kids[0], depth + 1);
  if (depth < 12 && kids.length >= 2 && stacked(kids)) {
    var out = [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      var kb = box(k);
      var containsBoth = header && k.contains(header) || footer && k.contains(footer);
      if (containsBoth || (headingCount(k) >= 2 && kb.height > VH * 1.1 && depth < 11)) {
        var inner = split(k, depth + 1);
        // Only split when the pieces are real sections with their own headings.
        var headed = inner.filter(function(x){ return headingCount(x) >= 1; }).length;
        out = out.concat(inner.length > 1 && (containsBoth || headed >= 2) ? inner : [k]);
      } else out.push(k);
    }
    return out;
  }
  if (containsChrome && depth < 12 && kids.length >= 2) {
    var flat = [];
    for (var j = 0; j < kids.length; j++) flat = flat.concat(split(kids[j], depth + 1));
    return flat;
  }
  return [el];
}
var root = document.querySelector('main') || document.body;
var bands = split(root === document.body ? document.body : root, 0).filter(function(el){
  if (header && (el === header || header.contains(el) || el.contains(header))) return false;
  if (footer && (el === footer || footer.contains(el) || el.contains(footer))) return false;
  return true;
});
// Merge slivers (spacers, dividers) into their neighbour; drop empty ones.
var merged = [];
for (var i = 0; i < bands.length; i++) {
  var el = bands[i];
  var b = box(el);
  var text = clean(el.innerText);
  var media = el.querySelector('img,picture,video,svg,canvas,iframe');
  if (!text && !media) continue;
  if ((b.height < 90 && text.length < 60 && merged.length) ) { merged[merged.length - 1].extra.push(el); continue; }
  merged.push({ el: el, extra: [] });
}
merged = merged.slice(0, 40);

// The logo: the largest image, svg or background-image element of logo size,
// else a short line of large text (a wordmark).
function findLogo(root){
  var best = null, bestArea = 0;
  var nodes = root.querySelectorAll('img, svg, picture, a, div, span');
  for (var i = 0; i < nodes.length && i < 500; i++) {
    var n = nodes[i]; if (!visible(n)) continue;
    var b = box(n); if (b.height < 18 || b.height > 170 || b.width < 50) continue;
    var tag = n.tagName.toUpperCase();
    var isImg = tag === 'IMG' || tag === 'SVG' || tag === 'PICTURE';
    var bg = !isImg && /url\(/.test(cs(n).backgroundImage || '') && clean(n.innerText).length < 3;
    if (!isImg && !bg) continue;
    if (n.closest('a[href^="tel:"], a[href^="mailto:"]')) continue;
    var area = b.width * b.height; if (area > bestArea) { best = n; bestArea = area; }
  }
  if (best) return best;
  var texts = root.querySelectorAll('a, span, p, div, strong, h1, h2, h3, h4, h5, h6');
  for (var j = 0; j < texts.length && j < 400; j++) {
    var t = texts[j]; if (!visible(t)) continue;
    var own = leafTextOf(t); if (!own || own.split(' ').length > 5) continue;
    if (/\d{3}|@/.test(own)) continue;
    if (parseFloat(cs(t).fontSize) >= 22) return t;
  }
  return null;
}
function leafTextOf(el){
  var t = '';
  for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) t += n.textContent; }
  return clean(t);
}
function looksLikeHeaderBand(m){
  var el = m.el; var b = box(el);
  if (b.y > 12 || b.height > 190 || b.height < 30) return false;
  var h1 = el.querySelector('h1'); if (h1 && visible(h1)) return false;
  if (el.querySelector('form, input:not([type=hidden]), textarea, select')) return false;
  var words = clean(el.innerText).split(' ').filter(Boolean).length;
  if (words > 30) return false;
  var contact = !!el.querySelector('a[href^="tel:"], a[href^="mailto:"]') || /\(?\+?\d[\d\s()-]{7,}\d/.test(el.innerText || '');
  return !!findLogo(el) || contact || el.querySelectorAll('a').length >= 3;
}
if (!header && merged.length >= 2 && looksLikeHeaderBand(merged[0])) {
  header = merged[0].el;
  merged.shift();
}
if (!footer && merged.length >= 2) {
  var lastBand = merged[merged.length - 1];
  if (/©|copyright|all rights reserved/i.test(lastBand.el.innerText || '') && box(lastBand.el).height <= 520) {
    footer = lastBand.el;
    merged.pop();
  }
}

// ---- per-section content ----
var BLOCK_SEL = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,button,a,figcaption,dt,dd,label,summary,td,th,span,strong,div';
function leafText(el){
  // Text owned by this element, not by a matched descendant block.
  var t = '';
  for (var i = 0; i < el.childNodes.length; i++) { var n = el.childNodes[i]; if (n.nodeType === 3) t += n.textContent; else if (n.nodeType === 1 && /^(B|STRONG|EM|I|SPAN|A|BR|SMALL|SUP|SUB|U|MARK|CODE)$/.test(n.tagName)) t += n.tagName === 'BR' ? ' ' : n.innerText; }
  return clean(t);
}
function roleOf(el){
  var tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return tag;
  if (tag === 'p' || tag === 'figcaption' || tag === 'dd' || tag === 'td') return 'p';
  if (tag === 'li' || tag === 'dt') return 'li';
  if (tag === 'blockquote') return 'quote';
  if (tag === 'summary') return 'h4';
  if (tag === 'button') return 'button';
  if (tag === 'a') { var s = cs(el); return (painted(s.backgroundColor) || parseFloat(s.borderTopWidth) > 0) && parseFloat(s.paddingLeft) >= 8 ? 'button' : 'link'; }
  var s2 = cs(el); var fs = parseFloat(s2.fontSize);
  if (fs >= 26) return 'h3';
  if (/^\d[\d,.]*\s*(\+|%|x|k|m)?$/i.test(clean(el.innerText)) || /^[$£€]\s?\d/.test(clean(el.innerText))) return 'stat';
  return 'p';
}
function blocksOf(sectionEls){
  var out = []; var seen = {};
  sectionEls.forEach(function(sec){
    var nodes = sec.querySelectorAll(BLOCK_SEL);
    for (var i = 0; i < nodes.length && out.length < 90; i++) {
      var el = nodes[i];
      if (el.closest('form') || !visible(el)) continue;
      var tag = el.tagName;
      var text = (tag === 'DIV' || tag === 'SPAN' || tag === 'STRONG') ? leafText(el) : clean(el.innerText);
      if (!text || text.length < 2) continue;
      if ((tag === 'DIV' || tag === 'SPAN' || tag === 'STRONG') && text.length < 3) continue;
      // Skip containers whose text is already captured through a child block.
      if (tag !== 'DIV' && tag !== 'SPAN' && el.querySelector('h1,h2,h3,h4,h5,h6,p,li,blockquote') && !/^H[1-6]$/.test(tag)) continue;
      var key = text.slice(0, 120);
      if (seen[key]) continue;
      seen[key] = 1;
      var role = roleOf(el);
      if (role === 'link' && text.length > 60) role = 'p';
      out.push({ role: role, text: text.slice(0, 420) });
    }
  });
  return out;
}
function rowsOf(children){
  var rows = [];
  children.forEach(function(c){ var b = box(c); var row = null; for (var i = 0; i < rows.length; i++) if (Math.abs(rows[i].y - b.y) < 14) { row = rows[i]; break; } if (!row) { row = { y: b.y, n: 0 }; rows.push(row); } row.n++; });
  return rows;
}
function layoutOf(sec){
  // Deepest element whose visible children sit side by side.
  var best = { columns: 1, cards: 0, el: null };
  var all = [sec].concat(Array.prototype.slice.call(sec.querySelectorAll('div,ul,ol,section,article')));
  for (var i = 0; i < all.length && i < 600; i++) {
    var el = all[i];
    var kids = Array.prototype.slice.call(el.children).filter(function(c){ var b = box(c); return visible(c) && b.width > 60 && b.height > 30; });
    if (kids.length < 2) continue;
    var rows = rowsOf(kids);
    var cols = Math.max.apply(null, rows.map(function(r){ return r.n; }));
    if (cols < 2) continue;
    var widths = kids.map(function(k){ return box(k).width; });
    var similar = Math.max.apply(null, widths) - Math.min.apply(null, widths) < Math.max(40, Math.max.apply(null, widths) * 0.15);
    var cards = similar && kids.length >= 3 ? kids.length : 0;
    if (cards > best.cards || (cards === best.cards && cols > best.columns)) best = { columns: cols, cards: cards, el: el };
  }
  var cardStyle = null;
  if (best.el && best.cards) {
    var c = best.el.children[0]; var s = cs(c);
    var kids2 = Array.prototype.slice.call(best.el.children).filter(function(k){ return visible(k); });
    // Dividers: side borders on the cards, or thin rules between them.
    var divided = kids2.some(function(k){ var ks = cs(k); return parseFloat(ks.borderLeftWidth) > 0 && parseFloat(ks.borderTopWidth) === 0 || parseFloat(ks.borderRightWidth) > 0 && parseFloat(ks.borderTopWidth) === 0; })
      || kids2.some(function(k){ var kb = box(k); return kb.width <= 4 && kb.height >= 30; })
      || Array.prototype.slice.call(c.querySelectorAll('*')).some(function(n){ var nb = box(n); return nb.width <= 3 && nb.height >= 40 && painted(cs(n).backgroundColor); });
    // Icon side: an icon or small image left of the card's text, or above it.
    var icon = null; var iconCands = c.querySelectorAll('img, svg, i, [class*="icon"]');
    for (var q = 0; q < iconCands.length; q++) { var ib = box(iconCands[q]); if (visible(iconCands[q]) && ib.width >= 12 && ib.width <= 140 && ib.height >= 12 && ib.height <= 140) { icon = iconCands[q]; break; } }
    var iconSide = null;
    if (icon) {
      var ibx = box(icon); var textEl = null; var tcs = c.querySelectorAll('h1,h2,h3,h4,h5,h6,p,span,div');
      for (var r = 0; r < tcs.length; r++) { if (visible(tcs[r]) && !tcs[r].contains(icon) && !icon.contains(tcs[r]) && leafTextOf(tcs[r]).length > 2) { textEl = tcs[r]; break; } }
      if (textEl) { var tb = box(textEl); iconSide = tb.x >= ibx.x + ibx.width - 4 && tb.y < ibx.y + ibx.height ? 'left' : 'top'; }
    }
    cardStyle = { radius: px(s.borderTopLeftRadius), shadow: s.boxShadow && s.boxShadow !== 'none', border: parseFloat(s.borderTopWidth) > 0, background: painted(s.backgroundColor) ? norm(s.backgroundColor) : null, iconSide: iconSide, divided: divided };
  }
  return { columns: Math.min(best.columns, 6), cards: best.cards, card: cardStyle };
}
function mediaOf(sec){
  var sb = box(sec);
  var imgs = Array.prototype.slice.call(sec.querySelectorAll('img,picture,video,canvas')).filter(function(m){ var b = box(m); return visible(m) && b.width > 60 && b.height > 40; });
  var big = null; imgs.forEach(function(m){ var b = box(m); if (!big || b.width * b.height > big.b.width * big.b.height) big = { m: m, b: b }; });
  var bgImg = false; [sec].concat(Array.prototype.slice.call(sec.querySelectorAll('div')).slice(0, 12)).forEach(function(n){ var s = cs(n); if (s.backgroundImage && /url\(/.test(s.backgroundImage) && box(n).width > sb.width * 0.7) bgImg = true; });
  var logos = imgs.filter(function(m){ var b = box(m); return b.height < 90 && b.width < 260; }).length;
  var position = 'none';
  if (bgImg) position = 'background';
  else if (big && big.b.width > 140) {
    if (big.b.width > sb.width * 0.8) position = big.b.y > sb.y + sb.height * 0.45 ? 'below' : 'above';
    else if (big.b.x > sb.x + sb.width * 0.45) position = 'right';
    else if (big.b.x + big.b.width < sb.x + sb.width * 0.55) position = 'left';
    else position = 'above';
  }
  return { images: imgs.length, logos: logos, video: !!sec.querySelector('video,iframe[src*="youtube"],iframe[src*="vimeo"],iframe[src*="wistia"]'), position: position, largest: big ? { width: big.b.width, height: big.b.height } : null };
}
function backgroundOf(sec){
  var sb = box(sec);
  var nodes = [sec].concat(Array.prototype.slice.call(sec.querySelectorAll('div,section')).slice(0, 10));
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i]; var b = box(n); if (b.width < sb.width * 0.85 || b.height < sb.height * 0.6) continue;
    var s = cs(n);
    if (s.backgroundImage && /gradient/.test(s.backgroundImage)) return { kind: 'gradient', color: norm(s.backgroundColor), image: normImage(s.backgroundImage).slice(0, 300), base: backdropOf(n) };
    if (s.backgroundImage && /url\(/.test(s.backgroundImage)) return { kind: 'image', color: norm(s.backgroundColor), image: null };
    if (painted(s.backgroundColor)) { var L = lum(s.backgroundColor); return { kind: L !== null && L < 0.18 ? 'dark' : 'color', color: norm(s.backgroundColor), image: null }; }
  }
  // A transparent section shows whatever is behind it: the nearest painted
  // wrapper, the body or the root (many dark pages paint a wrapper, not body).
  for (var p = sec.parentElement; p; p = p.parentElement) {
    var ps = cs(p);
    if (painted(ps.backgroundColor)) {
      var L2 = lum(ps.backgroundColor);
      return { kind: L2 !== null && L2 < 0.18 ? 'dark' : 'page', color: norm(ps.backgroundColor), image: null };
    }
  }
  return { kind: 'page', color: norm(cs(document.body).backgroundColor), image: null };
}
function alignOf(sec){ var h = sec.querySelector('h1,h2,h3'); return h ? cs(h).textAlign : cs(sec).textAlign; }
function paddingOf(sec){
  var sb = box(sec); var first = null;
  var nodes = sec.querySelectorAll('h1,h2,h3,p,img,a,button');
  for (var i = 0; i < nodes.length; i++) if (visible(nodes[i])) { first = nodes[i]; break; }
  return first ? Math.max(0, box(first).y - sb.y) : null;
}
function containerOf(sec){
  var sb = box(sec); var widths = [];
  var nodes = sec.querySelectorAll('h1,h2,h3,p');
  for (var i = 0; i < nodes.length && i < 30; i++) if (visible(nodes[i])) { var p = nodes[i].parentElement; while (p && p !== sec && box(p).width < sb.width * 0.98) { if (box(p.parentElement || p).width >= sb.width * 0.98) break; p = p.parentElement; } if (p) widths.push(box(p).width); }
  widths.sort(function(a, b){ return a - b; });
  return widths.length ? widths[Math.floor(widths.length / 2)] : null;
}

var sections = merged.map(function(m, i){
  var els = [m.el].concat(m.extra);
  var b = box(m.el); var last = box(els[els.length - 1]);
  var bounds = { x: 0, y: b.y, width: W, height: Math.max(b.height, last.y + last.height - b.y) };
  var blocks = blocksOf(els);
  var heading = null; for (var j = 0; j < blocks.length; j++) if (/^h[1-3]$/.test(blocks[j].role)) { heading = blocks[j].text; break; }
  if (!heading) for (var j2 = 0; j2 < blocks.length; j2++) if (/^h[4-6]$/.test(blocks[j2].role) || (blocks[j2].role === 'p' && blocks[j2].text.length <= 80 && blocks[j2].text.split(' ').length >= 2)) { heading = blocks[j2].text; break; }
  var words = clean(els.map(function(e){ return e.innerText; }).join(' ')).split(' ').filter(Boolean).length;
  var formsIn = 0; els.forEach(function(e){ formsIn += e.querySelectorAll('form, input:not([type=hidden])').length; });
  return {
    order: i,
    bounds: bounds,
    heading: heading,
    blocks: blocks,
    wordCount: words,
    layout: layoutOf(m.el),
    media: mediaOf(m.el),
    background: backgroundOf(m.el),
    align: alignOf(m.el),
    paddingTop: paddingOf(m.el),
    containerWidth: containerOf(m.el),
    hasFormControls: formsIn > 0,
    faq: !!m.el.querySelector('details, [class*="accordion"], [class*="faq"], [aria-expanded]')
  };
});

// ---- design shape ----
function med(list){ list = list.filter(function(v){ return v !== null && isFinite(v); }).sort(function(a, b){ return a - b; }); return list.length ? list[Math.floor(list.length / 2)] : null; }
function typeOf(sel){
  var els = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(function(e){ return visible(e) && clean(e.innerText).length > 1 && !(header && header.contains(e)) && !(footer && footer.contains(e)); }).slice(0, 20);
  if (!els.length) return null;
  var s = els.map(cs);
  return {
    size: med(s.map(function(x){ return px(x.fontSize); })),
    weight: med(s.map(function(x){ return parseInt(x.fontWeight, 10); })),
    lineHeight: med(s.map(function(x, k){ var lh = parseFloat(x.lineHeight); var fs = parseFloat(x.fontSize); return isFinite(lh) && fs ? Math.round(lh / fs * 100) / 100 : null; })),
    letterSpacing: med(s.map(function(x){ var ls = parseFloat(x.letterSpacing); var fs = parseFloat(x.fontSize); return isFinite(ls) && fs ? Math.round(ls / fs * 1000) / 1000 : 0; })),
    transform: s[0].textTransform,
    family: s[0].fontFamily.split(',')[0].replace(/["']/g, '').trim()
  };
}
var buttons = Array.prototype.slice.call(document.querySelectorAll('a,button')).filter(function(e){ if (!visible(e) || e.closest('form')) return false; var s = cs(e); return painted(s.backgroundColor) && parseFloat(s.paddingLeft) >= 10 && clean(e.innerText).length > 1 && clean(e.innerText).length < 40; }).slice(0, 30);
var bs = buttons.map(cs);
var shape = {
  h1: typeOf('h1'), h2: typeOf('h2'), h3: typeOf('h3'), body: typeOf('p'),
  eyebrow: null,
  button: bs.length ? {
    radius: med(bs.map(function(x){ return px(x.borderTopLeftRadius); })),
    paddingY: med(bs.map(function(x){ return px(x.paddingTop); })),
    paddingX: med(bs.map(function(x){ return px(x.paddingLeft); })),
    weight: med(bs.map(function(x){ return parseInt(x.fontWeight, 10); })),
    size: med(bs.map(function(x){ return px(x.fontSize); })),
    transform: bs[0].textTransform,
    letterSpacing: med(bs.map(function(x){ var ls = parseFloat(x.letterSpacing); return isFinite(ls) ? ls : 0; })),
    shadow: bs.some(function(x){ return x.boxShadow && x.boxShadow !== 'none'; }),
    height: med(buttons.map(function(e){ return box(e).height; }))
  } : null,
  sectionPadding: med(sections.map(function(s){ return s.paddingTop; })),
  container: med(sections.map(function(s){ return s.containerWidth; })),
  cardRadius: med(sections.map(function(s){ return s.layout.card ? s.layout.card.radius : null; })),
  cardShadow: sections.some(function(s){ return s.layout.card && s.layout.card.shadow; }),
  cardBorder: sections.some(function(s){ return s.layout.card && s.layout.card.border; }),
  darkBands: sections.filter(function(s){ return s.background.kind === 'dark'; }).length,
  gradientBands: sections.filter(function(s){ return s.background.kind === 'gradient'; }).length,
  pageBackground: norm(cs(document.body).backgroundColor)
};
var eyebrows = Array.prototype.slice.call(document.querySelectorAll('span,p,div')).filter(function(e){ if (!visible(e)) return false; var t = leafText(e); if (!t || t.length > 40 || t.length < 3) return false; var s = cs(e); return (s.textTransform === 'uppercase' || parseFloat(s.letterSpacing) > 1) && parseFloat(s.fontSize) <= 16; }).slice(0, 10);
if (eyebrows.length >= 2) { var es = cs(eyebrows[0]); shape.eyebrow = { size: px(es.fontSize), weight: parseInt(es.fontWeight, 10), letterSpacing: px(es.letterSpacing), pill: painted(es.backgroundColor) && parseFloat(es.borderTopLeftRadius) > 8 }; }

// ---- header / footer detail ----
function linkLabels(el, max){ if (!el) return []; var out = []; var as = el.querySelectorAll('a'); for (var i = 0; i < as.length && out.length < max; i++) { var t = clean(as[i].innerText); if (t && t.length <= 30 && visible(as[i]) && out.indexOf(t) < 0) out.push(t); } return out; }
var headerInfo = null;
if (header) {
  var hb = box(header); var hs = cs(header);
  var cta = null; var ha = header.querySelectorAll('a,button');
  for (var h = 0; h < ha.length; h++) { var s = cs(ha[h]); if (visible(ha[h]) && painted(s.backgroundColor) && parseFloat(s.paddingLeft) >= 8) { cta = clean(ha[h].innerText).slice(0, 40); break; } }
  var logo = findLogo(header); var lb = logo ? box(logo) : null;
  var lc = lb ? lb.x + lb.width / 2 : null;
  var hLum = lum(backdropOf(header)) ?? 1;
  var items = [];
  var seenItem = {};
  var nodes = header.querySelectorAll('a, button, p, span, li, div, strong, h1, h2, h3, h4, h5, h6');
  for (var hi = 0; hi < nodes.length && items.length < 10; hi++) {
    var n = nodes[hi]; if (!visible(n)) continue;
    if (logo && (n === logo || logo.contains(n))) continue;
    var isLink = n.tagName === 'A' || n.tagName === 'BUTTON';
    if (!isLink && n.closest('a, button')) continue;
    var t = isLink ? clean(n.innerText) : leafTextOf(n);
    if (!t || t.length < 2 || t.length > 70 || seenItem[t]) continue;
    seenItem[t] = 1;
    var nb = box(n); var ncx = nb.x + nb.width / 2;
    var href = n.getAttribute('href') || '';
    var ns = cs(n);
    // A filled box around the link (often drawn by its wrapper) makes it a button.
    var boxed = null;
    var around = [];
    for (var up = n, d2 = 0; up && up !== header && d2 < 3; up = up.parentElement, d2++) around.push(up);
    around = around.concat(Array.prototype.slice.call(n.querySelectorAll('button, span, div')).slice(0, 6));
    for (var ai = 0; ai < around.length; ai++) {
      var us = cs(around[ai]); var ub = box(around[ai]);
      if (ub.width >= 40 && ub.width < 420 && (painted(us.backgroundColor) && norm(us.backgroundColor) !== backdropOf(header) || parseFloat(us.borderTopWidth) > 0)) { boxed = around[ai]; break; }
    }
    var asButton = !!boxed;
    var kind = /^tel:/i.test(href) || /^\(?\+?\d[\d\s()-]{6,}\d$/.test(t) ? 'phone'
      : /^mailto:/i.test(href) || /@/.test(t) ? 'email'
      : /\d.*\b(st|street|rd|road|ave|avenue|hwy|highway|lane|ln|drive|dr|blvd|parade|pde|place|pl|way)\b/i.test(t) ? 'address'
      : asButton ? 'button' : isLink ? 'link' : 'text';
    items.push({ text: t.slice(0, 70), side: ncx < W * 0.36 ? 'left' : ncx > W * 0.64 ? 'right' : 'center', kind: kind, button: asButton });
  }
  headerInfo = { bounds: hb, nav: linkLabels(header, 10).filter(function(t){ return t !== cta && !items.some(function(it){ return it.text === t && /phone|email|address/.test(it.kind); }); }), cta: cta, dark: hLum < 0.18, tinted: hLum >= 0.18 && hLum < 0.9, sticky: /sticky|fixed/.test(hs.position), logoPosition: lc === null ? 'unknown' : lc < W * 0.33 ? 'left' : lc > W * 0.67 ? 'right' : 'center', items: items, topBar: false };
}
var footerInfo = null;
if (footer) {
  var fb = box(footer); var fs2 = cs(footer);
  var cols = 0; var inner = footer; for (var d = 0; d < 6; d++) { var vk = Array.prototype.slice.call(inner.children).filter(function(c){ return visible(c) && box(c).height > 30; }); var rows2 = rowsOf(vk); var mx = rows2.length ? Math.max.apply(null, rows2.map(function(r){ return r.n; })) : 0; if (mx >= 2) { cols = mx; break; } if (vk.length === 1) inner = vk[0]; else break; }
  footerInfo = { bounds: fb, columns: cols, dark: (lum(backdropOf(footer)) ?? 1) < 0.18, links: linkLabels(footer, 24) };
}

return {
  title: document.title,
  url: location.href,
  viewport: { width: W, height: VH },
  pageHeight: document.documentElement.scrollHeight,
  sections: sections,
  shape: shape,
  header: headerInfo,
  footer: footerInfo
};
})()`;

/**
 * Forms in one document (main page or an iframe). Includes hidden steps of a
 * multi-step form; `hidden` marks forms that are entirely out of view
 * (pop-ups), which callers use only when no visible form exists.
 */
export const FORM_PROBE_SCRIPT = String.raw`(function(){
${HELPERS}
function labelFor(input, container){
  var id = input.id; var t = '';
  if (id) { try { var l = document.querySelector('label[for="' + CSS.escape(id) + '"]'); if (l) t = clean(l.innerText); } catch (e) {} }
  if (!t) { var wrap = input.closest('label'); if (wrap) { var c = wrap.cloneNode(true); var ins = c.querySelectorAll('input,select,textarea'); for (var i = 0; i < ins.length; i++) ins[i].remove(); t = clean(c.textContent); } }
  if (!t) { var by = input.getAttribute('aria-labelledby'); if (by) { var ref = document.getElementById(by.split(' ')[0]); if (ref) t = clean(ref.innerText); } }
  if (!t) t = clean(input.getAttribute('aria-label'));
  if (!t) {
    // Nearest wrapper that holds just this control and a label (React form
    // kits often break label[for] by generating mismatched ids).
    for (var up = input.parentElement, depth = 0; up && up !== container && depth < 4; up = up.parentElement, depth++) {
      if (up.querySelectorAll('input:not([type=hidden]),select,textarea').length > 1) break;
      var own = up.querySelector('label,[class*="label"]');
      if (own && !own.contains(input)) { t = clean(own.innerText); break; }
    }
  }
  if (!t) {
    var field = input.closest('[class*="field"],[class*="Field"],[class*="form-group"],[class*="gfield"],[class*="hs-form-field"],[class*="input-wrap"],[class*="form-row"],fieldset');
    if (field && field !== container) { var lab = field.querySelector('label,legend,.label,[class*="label"]'); if (lab) t = clean(lab.innerText); }
  }
  if (!t) { var prev = input.previousElementSibling; if (prev && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(prev.tagName) && clean(prev.innerText).length < 80) t = clean(prev.innerText); }
  return t.replace(/\s*\*\s*$/, '').slice(0, 90);
}
// Custom dropdown kits (Radix, Headless UI) mirror options into a hidden
// native <select>; that mirror is a real field, not a spam trap.
function selectMirror(input){ return input.tagName === 'SELECT' && input.options.length >= 2 && (input.getAttribute('aria-hidden') === 'true' || input.tabIndex === -1); }
function triggerFor(input){
  var up = input.parentElement;
  for (var d = 0; up && d < 4; up = up.parentElement, d++) { var t = up.querySelector('[role="combobox"],[aria-haspopup="listbox"]'); if (t) return t; }
  return null;
}
function honeypot(input, label){
  if (selectMirror(input)) return false;
  var hay = (input.name + ' ' + input.id + ' ' + label + ' ' + (input.className || '')).toLowerCase();
  if (/honeypot|leave (this )?(field )?(blank|empty)|hp[_-]|gotcha|_gotcha|bot[_-]?field|ak_hp|nospam|do not fill/.test(hay)) return true;
  var s = cs(input); var r = input.getBoundingClientRect();
  var tiny = r.width < 3 || r.height < 3;
  var off = parseFloat(s.left) < -500 || parseFloat(s.top) < -500 || s.clip === 'rect(0px, 0px, 0px, 0px)';
  return input.tabIndex === -1 && (tiny || off);
}
function stepContainers(root){
  // Explicit step wrappers win; fieldsets only count as steps when there are none.
  function pick(sel){
    var list = Array.prototype.slice.call(root.querySelectorAll(sel)).filter(function(el){ return el.querySelector('input,select,textarea'); });
    // Outermost step wrappers: a step never sits inside another step.
    return list.filter(function(el){ return !list.some(function(o){ return o !== el && o.contains(el); }); });
  }
  var steps = pick('[class*="step"]:not([class*="stepper"]),[data-step],.gform_page,[class*="form-page"]');
  return steps.length >= 2 ? steps : pick('fieldset');
}
function submitOf(root){
  var cands = Array.prototype.slice.call(root.querySelectorAll('button[type="submit"],input[type="submit"],button:not([type]),button[type="button"],[role="button"],a[class*="btn"],a[class*="button"]'));
  function undouble(t){ var w = t.split(' '); var h = w.length / 2; if (w.length % 2 === 0 && w.slice(0, h).join(' ') === w.slice(h).join(' ')) return w.slice(0, h).join(' '); return t; }
  var shown = cands.filter(function(b){ return visible(b); });
  if (shown.length) cands = shown;
  var labels = cands.map(function(b){ return undouble(clean(b.innerText || b.value || '')); }).filter(function(t){ return t && t.length < 50 && !/loading|please wait|sending/i.test(t); });
  var next = labels.filter(function(t){ return /^(next|continue|back|previous|prev)\b/i.test(t); });
  var finals = labels.filter(function(t){ return !/^(next|continue|back|previous|prev)\b/i.test(t); });
  return { submit: finals[finals.length - 1] || null, next: next[0] || null };
}
function provider(root){
  var hay = (root.className + ' ' + root.id + ' ' + (root.getAttribute('action') || '') + ' ' + location.host).toLowerCase();
  if (/hs-form|hbspt|hubspot/.test(hay)) return 'hubspot';
  if (/gform/.test(hay)) return 'gravity';
  if (/wpcf7/.test(hay)) return 'contact-form-7';
  if (/elementor/.test(hay)) return 'elementor';
  if (/wpforms/.test(hay)) return 'wpforms';
  if (/typeform/.test(hay)) return 'typeform';
  if (/calendly/.test(hay)) return 'calendly';
  if (/leadconnector|msgsndr|gohighlevel|highlevel/.test(hay)) return 'highlevel';
  if (/jotform/.test(hay)) return 'jotform';
  if (/w-form|webflow/.test(hay)) return 'webflow';
  if (/framer/.test(hay)) return 'framer';
  return null;
}
function fieldsOf(root){
  var controls = Array.prototype.slice.call(root.querySelectorAll('input,select,textarea,[role="combobox"],[aria-haspopup="listbox"]'));
  var fields = []; var groups = {}; var usedTriggers = [];
  // A trigger with a native mirror is described by the mirror.
  controls.forEach(function(c){ if (selectMirror(c)) { var t = triggerFor(c); if (t) usedTriggers.push(t); } });
  controls.forEach(function(input){
    if (input.tagName !== 'INPUT' && input.tagName !== 'SELECT' && input.tagName !== 'TEXTAREA') {
      if (usedTriggers.indexOf(input) >= 0 || input.closest('select')) return;
      var tl = labelFor(input, root);
      fields.push({ label: tl, name: input.getAttribute('name') || input.id || '', type: 'select', required: input.getAttribute('aria-required') === 'true', options: [], placeholder: clean(input.innerText).slice(0, 90) || null, autocomplete: null, visible: visible(input), el: input });
      return;
    }
    if (input.getAttribute('role') === 'combobox' && input.tagName === 'INPUT' && input.closest('[role="listbox"]')) return;
    var type = (input.getAttribute('type') || input.tagName).toLowerCase();
    if (/^(hidden|submit|button|image|reset|file|search)$/.test(type)) return;
    var mirrorTrigger = selectMirror(input) ? triggerFor(input) : null;
    var label = mirrorTrigger ? labelFor(mirrorTrigger, root) || labelFor(input, root) : labelFor(input, root);
    if (honeypot(input, label)) return;
    var tag = input.tagName.toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      var name = input.name || input.id || ('group' + fields.length);
      var optLabel = labelFor(input, root);
      var groupEl = input.closest('fieldset,[role="radiogroup"],[class*="field"],[class*="gfield"],[class*="hs-form-field"]');
      var groupLabel = '';
      if (groupEl) { var lg = groupEl.querySelector('legend,label:not([for]),.label,[class*="label"]'); if (lg && !lg.contains(input)) groupLabel = clean(lg.innerText).replace(/\s*\*\s*$/, ''); }
      if (!groups[name]) { groups[name] = { label: groupLabel, name: name, type: type, required: input.required, options: [], placeholder: null, autocomplete: null, visible: visible(input) }; fields.push(groups[name]); }
      if (optLabel && groups[name].options.indexOf(optLabel) < 0) groups[name].options.push(optLabel.slice(0, 80));
      return;
    }
    var options = [];
    var placeholder = input.getAttribute('placeholder') || null;
    if (tag === 'select') {
      for (var i = 0; i < input.options.length; i++) {
        var o = input.options[i]; var t = clean(o.text);
        if (!t) continue;
        if ((o.value === '' || o.disabled) && i === 0) { placeholder = t; continue; }
        options.push(t.slice(0, 80));
      }
    }
    if (mirrorTrigger && !placeholder) placeholder = clean(mirrorTrigger.innerText) || null;
    fields.push({ label: label, name: input.name || input.id || '', type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : type, required: input.required || input.getAttribute('aria-required') === 'true' || (mirrorTrigger && mirrorTrigger.getAttribute('aria-required') === 'true'), options: options, placeholder: placeholder ? clean(placeholder).slice(0, 90) : null, autocomplete: input.getAttribute('autocomplete') || null, visible: mirrorTrigger ? visible(mirrorTrigger) : visible(input), el: mirrorTrigger || input });
  });
  return fields;
}
function styleOf(root, fields){
  var input = null; for (var i = 0; i < fields.length; i++) if (fields[i].el && fields[i].visible) { input = fields[i].el; break; }
  var s = input ? cs(input) : null;
  var btns = root.querySelectorAll('button,input[type="submit"]'); var btn = null; for (var j = 0; j < btns.length; j++) if (visible(btns[j])) { btn = btns[j]; break; }
  var bsx = btn ? cs(btn) : null;
  // The panel the form sits on (card) if any.
  var panel = null; for (var n = root; n && n !== document.body; n = n.parentElement) { var ps = cs(n); if (painted(ps.backgroundColor) || (ps.boxShadow && ps.boxShadow !== 'none')) { panel = { radius: px(ps.borderTopLeftRadius), shadow: ps.boxShadow !== 'none', dark: (lum(ps.backgroundColor) || 1) < 0.18 }; break; } if (box(n).width > W * 0.9) break; }
  var boxes = fields.filter(function(f){ return f.el && f.visible; }).map(function(f){ return box(f.el); });
  var perRow = 1; boxes.forEach(function(b){ var same = boxes.filter(function(o){ return Math.abs(o.y - b.y) < 8; }).length; if (same > perRow) perRow = same; });
  var labelsAbove = fields.some(function(f){ return f.label && f.placeholder !== f.label; });
  return {
    inputRadius: s ? px(s.borderTopLeftRadius) : null,
    inputHeight: input ? box(input).height : null,
    inputBorder: s ? parseFloat(s.borderBottomWidth) > 0 && !(parseFloat(s.borderTopWidth) > 0) ? 'underline' : parseFloat(s.borderTopWidth) > 0 ? 'box' : 'none' : null,
    inputFilled: s ? painted(s.backgroundColor) && (lum(s.backgroundColor) || 1) < 0.97 : null,
    buttonRadius: bsx ? px(bsx.borderTopLeftRadius) : null,
    buttonFullWidth: btn ? box(btn).width > box(root).width * 0.8 : null,
    perRow: Math.min(perRow, 4),
    labels: labelsAbove ? 'above' : 'placeholder',
    panel: panel
  };
}
var roots = Array.prototype.slice.call(document.querySelectorAll('form'));
// Framer, Webflow and custom builders sometimes skip <form>: take the smallest
// container holding 2+ inputs that is not inside a form.
Array.prototype.slice.call(document.querySelectorAll('input:not([type=hidden]),textarea,select')).forEach(function(input){
  if (input.closest('form')) return;
  var n = input.parentElement;
  while (n && n !== document.body && n.querySelectorAll('input:not([type=hidden]),textarea,select').length < 2) n = n.parentElement;
  if (n && n !== document.body && roots.indexOf(n) < 0 && !roots.some(function(r){ return r.contains(n) || n.contains(r); })) roots.push(n);
});
var out = [];
roots.forEach(function(root, idx){
  var fields = fieldsOf(root);
  if (!fields.length) return;
  var visibleFields = fields.filter(function(f){ return f.visible; });
  var steps = stepContainers(root).map(function(stepEl){
    var title = stepEl.querySelector('legend,h2,h3,h4,h5,[class*="title"],[class*="heading"]');
    var names = fieldsOf(stepEl).map(function(f){ return f.name || f.label; });
    return { title: title ? clean(title.innerText).slice(0, 80) : null, fields: names };
  }).filter(function(s){ return s.fields.length; });
  var b = box(root);
  var section = root.closest('section') || root.parentElement;
  var heading = null; var intro = null;
  for (var n = root; n && n !== document.body && !heading; n = n.parentElement) {
    var h = n.querySelector('h1,h2,h3,h4');
    if (h && !root.contains(h) && visible(h)) { heading = clean(h.innerText).slice(0, 140); var p = n.querySelector('p'); if (p && !root.contains(p)) intro = clean(p.innerText).slice(0, 260); }
    if (box(n).height > 1400) break;
  }
  // Numbered step bars ("1 Your details · 2 Your business · 3 …"): forms that
  // render one step at a time still show every step's title here.
  var stepTitles = [];
  Array.prototype.slice.call(root.querySelectorAll('button,li,[class*="step"],[role="tab"]')).forEach(function(el){
    var t = clean(el.textContent);
    var m = t.match(/^0?(\d)\s*[.:)\-]?\s*([A-Za-z][^0-9]{2,40})$/);
    if (m && el.querySelectorAll('input,select,textarea').length === 0) {
      var title = m[2].trim();
      if (stepTitles.indexOf(title) < 0 && stepTitles.length < 8) stepTitles.push(title);
    }
  });
  var sub = submitOf(root);
  var consent = fields.filter(function(f){ return f.type === 'checkbox' && /agree|consent|privacy|terms|subscribe|opt/i.test(f.label + ' ' + f.options.join(' ')); }).length > 0;
  out.push({
    index: idx,
    hidden: visibleFields.length === 0,
    bounds: b,
    provider: provider(root),
    heading: heading,
    intro: intro,
    submitLabel: sub.submit,
    nextLabel: sub.next,
    steps: steps.length >= 2 ? steps : [],
    stepTitles: stepTitles.length >= 2 ? stepTitles : [],
    consent: consent,
    fields: fields.map(function(f){ return { label: f.label, name: f.name, type: f.type, required: !!f.required, options: f.options, placeholder: f.placeholder, autocomplete: f.autocomplete, visible: f.visible }; }),
    style: styleOf(root, fields)
  });
});
return out;
})()`;
