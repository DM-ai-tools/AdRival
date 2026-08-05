/**
 * Lightweight interactivity runtime injected into archived recreations.
 * Restores FAQ / accordion / tabs plus common on-scroll reveal patterns
 * (AOS, WOW, fade/slide classes) when original site JS fails under srcDoc.
 */
export const INTERACTIVE_RUNTIME_SCRIPT = `
(function () {
  if (window.__adrivalInteractive) return;
  window.__adrivalInteractive = true;

  function looksLikeFaqPanel(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.hasAttribute("data-adrival-dup-removed")) return false;
    var cls = el.className && String(el.className) || "";
    var id = el.id || "";
    if (/accordion-collapse|accordion-body|faq-answer|faq-content|faq__answer|collapse/i.test(cls + " " + id)) return true;
    if (el.getAttribute("role") === "region") return true;
    if (el.tagName === "DETAILS") return false;
    return false;
  }

  function isOpen(el) {
    if (!el) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    return (
      el.classList.contains("show") ||
      el.classList.contains("open") ||
      el.classList.contains("is-open") ||
      el.classList.contains("active") ||
      el.getAttribute("aria-expanded") === "true" ||
      el.getAttribute("aria-hidden") === "false" ||
      (el.style && el.style.maxHeight && el.style.maxHeight !== "0px")
    );
  }

  function setOpen(panel, open) {
    if (!panel) return;
    panel.classList.toggle("show", open);
    panel.classList.toggle("open", open);
    panel.classList.toggle("is-open", open);
    panel.classList.toggle("active", open);
    panel.classList.toggle("collapsed", !open);
    if (open) {
      panel.removeAttribute("hidden");
      panel.setAttribute("aria-hidden", "false");
      panel.style.display = "block";
      panel.style.visibility = "visible";
      panel.style.opacity = "1";
      panel.style.height = "auto";
      panel.style.maxHeight = Math.max(panel.scrollHeight, 48) + "px";
      panel.style.overflow = "hidden";
      // Allow natural height after transition
      setTimeout(function () {
        if (isOpen(panel)) {
          panel.style.maxHeight = "none";
          panel.style.overflow = "visible";
        }
      }, 280);
    } else {
      panel.style.maxHeight = panel.scrollHeight + "px";
      panel.offsetHeight; // reflow
      panel.style.maxHeight = "0px";
      panel.style.overflow = "hidden";
      panel.setAttribute("aria-hidden", "true");
      panel.classList.add("collapsed");
    }
  }

  function findPanel(trigger) {
    var controls = trigger.getAttribute("aria-controls");
    if (controls) {
      var byId = document.getElementById(controls);
      if (byId) return byId;
    }
    var href = trigger.getAttribute("href") || trigger.getAttribute("data-bs-target") || trigger.getAttribute("data-target");
    if (href && href.charAt(0) === "#") {
      try {
        var byHref = document.querySelector(href);
        if (byHref) return byHref;
      } catch (err) {}
    }
    var item = trigger.closest(
      ".accordion-item, .faq-item, .accordion-section, [class*='accordion-item'], [class*='faq-item'], [class*='FaqItem'], li, article"
    );
    if (item) {
      var selectors = [
        ".accordion-collapse",
        ".accordion-body",
        ".collapse",
        ".faq-answer",
        ".faq-content",
        "[class*='faq-answer']",
        "[class*='FaqAnswer']",
        "[class*='accordion-collapse']",
        "[role='region']"
      ];
      for (var i = 0; i < selectors.length; i++) {
        var body = item.querySelector(selectors[i]);
        if (body && body !== trigger && !trigger.contains(body) && !body.contains(trigger)) {
          return body;
        }
      }
      // Fallback: first non-trigger block sibling inside item
      var kids = item.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k] !== trigger && !trigger.contains(kids[k]) && !kids[k].contains(trigger) && looksLikeFaqPanel(kids[k])) {
          return kids[k];
        }
      }
    }
    var sib = trigger.nextElementSibling;
    while (sib) {
      if (looksLikeFaqPanel(sib) || /accordion|collapse|faq-answer|faq__answer|panel/i.test(sib.className || "")) {
        return sib;
      }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function closeSiblings(trigger, panel) {
    var root = trigger.closest(".accordion, .faq, [data-accordion], [class*='Accordion'], [class*='faq'], [class*='Faq']") || document;
    var openPanels = root.querySelectorAll(".accordion-collapse.show, .collapse.show, .faq-answer.show, .is-open, .open, [aria-hidden='false']");
    openPanels.forEach(function (p) {
      if (p === panel || !looksLikeFaqPanel(p)) return;
      setOpen(p, false);
      var id = p.id;
      if (id) {
        root.querySelectorAll('[aria-controls="' + id + '"], [href="#' + id + '"], [data-bs-target="#' + id + '"]').forEach(function (t) {
          t.setAttribute("aria-expanded", "false");
          t.classList.add("collapsed");
        });
      }
    });
  }

  function isFaqTrigger(el) {
    if (!el || !el.closest) return null;
    if (el.closest("summary")) return null;
    return el.closest(
      '[aria-expanded], [data-bs-toggle="collapse"], [data-toggle="collapse"], [data-toggle="accordion"], .accordion-button, .accordion-header, .accordion-header button, .faq-question, .faq-header, .faq-title, [class*="faq-question"], [class*="faq-title"], [class*="FaqQuestion"], [class*="accordion-button"], [class*="accordion-header"]'
    );
  }

  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // Native <details>/<summary> already interactive
      if (t.closest("summary")) return;

      var trigger = isFaqTrigger(t);
      if (!trigger) return;
      if (trigger.tagName === "A" && trigger.getAttribute("href") && trigger.getAttribute("href").charAt(0) !== "#") {
        return;
      }

      var panel = findPanel(trigger);
      if (!panel) return;

      e.preventDefault();
      e.stopPropagation();
      var expanded = trigger.getAttribute("aria-expanded");
      var willOpen = expanded == null ? !isOpen(panel) : expanded !== "true";
      if (willOpen) closeSiblings(trigger, panel);
      trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
      trigger.classList.toggle("collapsed", !willOpen);
      trigger.classList.toggle("active", willOpen);
      trigger.classList.toggle("open", willOpen);
      setOpen(panel, willOpen);
    },
    true
  );

  // Only collapse clear FAQ answer panels — never blanket .collapse (too broad)
  document.querySelectorAll(
    ".accordion-collapse:not(.show), .faq-answer:not(.show), [class*='faq-answer']:not(.show), [class*='FaqAnswer']:not(.show)"
  ).forEach(function (panel) {
    if (!looksLikeFaqPanel(panel)) return;
    if (isOpen(panel)) return;
    if (panel.getAttribute("aria-hidden") === "false") return;
    panel.style.maxHeight = "0px";
    panel.style.overflow = "hidden";
    panel.setAttribute("aria-hidden", "true");
  });

  // Ensure details/summary work even if page CSS hid them
  document.querySelectorAll("details > summary").forEach(function (sum) {
    sum.style.cursor = "pointer";
  });

  document.addEventListener("click", function (e) {
    var tab = e.target && e.target.closest && e.target.closest('[role="tab"]');
    if (!tab) return;
    var list = tab.closest('[role="tablist"]');
    if (!list) return;
    e.preventDefault();
    list.querySelectorAll('[role="tab"]').forEach(function (t) {
      t.setAttribute("aria-selected", "false");
      t.setAttribute("tabindex", "-1");
    });
    tab.setAttribute("aria-selected", "true");
    tab.setAttribute("tabindex", "0");
    var panelId = tab.getAttribute("aria-controls");
    var root = list.parentElement || document;
    root.querySelectorAll('[role="tabpanel"]').forEach(function (p) {
      var show = panelId && p.id === panelId;
      p.hidden = !show;
      p.setAttribute("aria-hidden", show ? "false" : "true");
    });
  });

  /* —— On-scroll / reveal sections (AOS, WOW, fade/slide utilities) —— */
  function revealEl(el) {
    if (!el || el.getAttribute("data-adrival-revealed") === "1") return;
    el.setAttribute("data-adrival-revealed", "1");
    el.classList.add(
      "aos-animate",
      "animated",
      "in-view",
      "is-visible",
      "is-inview",
      "revealed",
      "active",
      "show",
      "visible"
    );
    if (/wow/i.test(el.className || "")) el.classList.add("animated");
    if (/animate__/i.test(el.className || "")) {
      /* keep animate.css classes; ensure visible */
    }
    var style = el.style;
    style.opacity = "1";
    style.visibility = "visible";
    style.transform = "none";
    style.translate = "none";
    if (getComputedStyle(el).display === "none") {
      /* don't force-display intentionally hidden UI */
    }
    el.removeAttribute("data-aos-delay");
  }

  function collectRevealCandidates() {
    var sel = [
      "[data-aos]",
      "[data-scroll]",
      "[data-animate]",
      ".aos-init",
      ".wow",
      ".reveal",
      ".reveals",
      "[class*='reveal-']",
      "[class*='fade-up']",
      "[class*='fade-in']",
      "[class*='fadeUp']",
      "[class*='fadeIn']",
      "[class*='slide-up']",
      "[class*='slide-in']",
      "[class*='slideUp']",
      "[class*='animate__']",
      "[class*='ScrollReveal']",
      "[class*='scroll-reveal']",
      "section[style*='opacity: 0']",
      "section[style*='opacity:0']",
      "div[style*='opacity: 0']",
      "div[style*='opacity:0']",
      "[class*='hero'] ~ section",
      "main > section",
      "main > div > section"
    ].join(",");
    var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    // Also pick sections that are visually hidden via computed style
    document.querySelectorAll("main section, main .section, [class*='Section'], [data-section]").forEach(function (el) {
      try {
        var cs = getComputedStyle(el);
        var op = parseFloat(cs.opacity);
        if ((op === 0 || cs.visibility === "hidden") && el.offsetParent !== null) {
          nodes.push(el);
        }
      } catch (e) {}
    });
    var seen = new Set();
    return nodes.filter(function (el) {
      if (!el || seen.has(el)) return false;
      if (el.closest("header, nav, footer, script, style, noscript")) return false;
      seen.add(el);
      return true;
    });
  }

  function setupScrollReveals() {
    var candidates = collectRevealCandidates();
    if (!candidates.length) return;

    function inView(el) {
      var r = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      return r.top < vh * 0.92 && r.bottom > vh * -0.05;
    }

    function tick() {
      candidates.forEach(function (el) {
        if (el.getAttribute("data-adrival-revealed") === "1") return;
        if (inView(el)) revealEl(el);
      });
    }

    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (entry) {
            if (entry.isIntersecting || entry.intersectionRatio > 0) {
              revealEl(entry.target);
              io.unobserve(entry.target);
            }
          });
        },
        { root: null, rootMargin: "0px 0px -8% 0px", threshold: [0, 0.08, 0.2] }
      );
      candidates.forEach(function (el) {
        if (inView(el)) revealEl(el);
        else io.observe(el);
      });
    } else {
      tick();
      window.addEventListener("scroll", tick, { passive: true });
      window.addEventListener("resize", tick);
    }

    // Above-the-fold + safety: never leave page permanently blank
    tick();
    setTimeout(tick, 400);
    setTimeout(function () {
      candidates.forEach(function (el) {
        if (el.getAttribute("data-adrival-revealed") === "1") return;
        if (inView(el)) revealEl(el);
      });
    }, 1600);
    // Last resort after 4s for anything still invisible in viewport
    setTimeout(function () {
      candidates.forEach(function (el) {
        if (el.getAttribute("data-adrival-revealed") === "1") return;
        try {
          var cs = getComputedStyle(el);
          if (parseFloat(cs.opacity) === 0 && inView(el)) revealEl(el);
        } catch (e) {}
      });
    }, 4000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupScrollReveals);
  } else {
    setupScrollReveals();
  }
})();
`.trim();

const INTERACTIVE_RUNTIME_STYLE = `
<style data-adrival-interactive-css="1">
  [data-adrival-revealed="1"],
  [data-aos].aos-animate,
  .aos-animate,
  .in-view,
  .is-visible,
  .is-inview,
  .revealed {
    opacity: 1 !important;
    visibility: visible !important;
    transform: none !important;
    translate: none !important;
  }
  /* Soft transition when our runtime reveals nodes */
  [data-aos],
  .aos-init,
  .wow,
  [class*="fade-up"],
  [class*="fade-in"],
  [class*="slide-up"],
  [class*="reveal"] {
    transition: opacity 0.55s ease, transform 0.55s ease;
  }
  /* FAQ / accordion panels controlled by AdRival runtime */
  .accordion-collapse,
  .faq-answer,
  [class*="faq-answer"],
  [class*="FaqAnswer"] {
    transition: max-height 0.28s ease, opacity 0.2s ease;
  }
  .accordion-collapse.show,
  .faq-answer.show,
  .faq-answer.open,
  .faq-answer.is-open,
  [class*="faq-answer"].show,
  [class*="faq-answer"].open,
  [class*="faq-answer"].is-open {
    display: block !important;
    visibility: visible !important;
    opacity: 1 !important;
    height: auto !important;
  }
  [data-adrival-dup-removed="1"] {
    display: none !important;
  }
  details > summary {
    cursor: pointer;
  }
</style>
`.trim();

export function injectInteractiveRuntime(html: string): string {
  const script = `<script data-adrival-interactive="1">${INTERACTIVE_RUNTIME_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>`;
  const style = INTERACTIVE_RUNTIME_STYLE;
  let out = html;
  if (!/data-adrival-interactive-css=/i.test(out)) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${style}</head>`);
    } else {
      out = style + out;
    }
  }
  if (/data-adrival-interactive=/i.test(out)) return out;
  if (/<\/body>/i.test(out)) {
    return out.replace(/<\/body>/i, `${script}</body>`);
  }
  return `${out}\n${script}`;
}
