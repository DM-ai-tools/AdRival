import * as cheerio from "cheerio";

/**
 * Pre-stamp FAQ / accordion pairs so the injected runtime can toggle them
 * even when competitor markup uses non-Bootstrap class names.
 */
export function stampFaqInteractivity(html: string): string {
  const $ = cheerio.load(html);
  let stamped = 0;

  const faqRoots = $(
    [
      "[class*='faq']",
      "[class*='Faq']",
      "[class*='FAQ']",
      "[id*='faq']",
      "[id*='Faq']",
      ".accordion",
      "[class*='accordion']",
      "[class*='Accordion']",
      "[data-accordion]",
      ".elementor-toggle",
      ".elementor-accordion",
      ".e-n-accordion",
      "[class*='toggle']",
    ].join(", "),
  );

  faqRoots.each((_, root) => {
    const $root = $(root);
    // Avoid nested double-stamping of the same items
    if ($root.parents("[class*='faq'], .accordion, [class*='accordion']").length) {
      return;
    }

    const items = $root
      .find(
        [
          ".accordion-item",
          ".faq-item",
          "[class*='faq-item']",
          "[class*='FaqItem']",
          "[class*='accordion-item']",
          ".elementor-toggle-item",
          ".e-n-accordion-item",
          "details",
          "li",
          "article",
          "> div",
        ].join(", "),
      )
      .toArray()
      .filter((el) => {
        const $el = $(el);
        // Prefer direct-ish children that look like Q/A pairs
        const text = ($el.text() || "").replace(/\s+/g, " ").trim();
        if (text.length < 12 || text.length > 1200) return false;
        return (
          $el.find("h2, h3, h4, h5, button, summary, [class*='question'], [class*='title'], [class*='header']")
            .length > 0
        );
      });

    for (const item of items.slice(0, 40)) {
      const $item = $(item);
      if ($item.attr("data-adrival-faq-item")) continue;

      const $trigger = $item
        .find(
          "button, summary, [aria-expanded], .accordion-button, .accordion-header, [class*='question'], [class*='Question'], [class*='toggle-title'], [class*='accordion-title'], [class*='e-n-accordion-item-title'], h2, h3, h4, h5",
        )
        .first();
      if (!$trigger.length) continue;

      let $panel = $();
      const controls = $trigger.attr("aria-controls");
      if (controls) {
        $panel = $(`[id="${controls.replace(/"/g, "")}"]`).first();
      }
      if (!$panel.length) {
        const href =
          $trigger.attr("href") ||
          $trigger.attr("data-bs-target") ||
          $trigger.attr("data-target") ||
          "";
        if (href.startsWith("#") && href.length > 1) {
          $panel = $(href).first();
        }
      }
      if (!$panel.length) {
        $panel = $item
          .find(
            ".accordion-collapse, .accordion-body, .collapse, .faq-answer, [class*='faq-answer'], [class*='FaqAnswer'], [class*='accordion-panel'], [class*='toggle-content'], [role='region'], .elementor-tab-content, .e-n-accordion-item-content",
          )
          .filter((__: number, el: any) => {
            const $el = $(el);
            return !$trigger.is($el) && !$trigger.find($el).length;
          })
          .first();
      }
      if (!$panel.length) {
        // Next sibling block after the trigger
        let sib = $trigger.next();
        while (sib.length) {
          if (
            !sib.is("script, style, br") &&
            !sib.is($trigger) &&
            (sib.text() || "").trim().length > 0
          ) {
            $panel = sib;
            break;
          }
          sib = sib.next();
        }
      }
      if (!$panel.length) continue;

      const id = `adrival-faq-${stamped}`;
      $item.attr("data-adrival-faq-item", "1");
      $trigger.attr("data-adrival-faq-trigger", id);
      $trigger.attr("role", $trigger.attr("role") || "button");
      $trigger.attr("tabindex", $trigger.attr("tabindex") || "0");
      if (!$trigger.attr("aria-expanded")) {
        $trigger.attr("aria-expanded", "false");
      }
      $panel.attr("data-adrival-faq-panel", id);
      $panel.attr("aria-hidden", "true");
      // Start collapsed for click-to-expand UX
      const style = $panel.attr("style") || "";
      if (!/max-height/i.test(style)) {
        const sep = style && !/;\s*$/.test(style) ? ";" : "";
        $panel.attr(
          "style",
          `${style}${sep}max-height:0;overflow:hidden;opacity:0;`,
        );
      }
      stamped += 1;
    }
  });

  // Standalone details/summary already work — ensure cursor
  $("details > summary").attr("style", function (_: number, s: string) {
    const prev = s || "";
    return /cursor/i.test(prev) ? prev : `${prev};cursor:pointer;`.replace(/^;/, "");
  });

  return stamped ? $.html() : html;
}

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
    if (el.hasAttribute("data-adrival-faq-panel")) return true;
    var cls = el.className && String(el.className) || "";
    var id = el.id || "";
    if (/accordion-collapse|accordion-body|faq-answer|faq-content|faq__answer|collapse|toggle-content|accordion-panel/i.test(cls + " " + id)) return true;
    if (el.getAttribute("role") === "region") return true;
    if (el.tagName === "DETAILS") return false;
    return false;
  }

  function isOpen(el) {
    if (!el) return false;
    if (el.hasAttribute("hidden")) return false;
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el.style && el.style.maxHeight === "0px") return false;
    return (
      el.classList.contains("show") ||
      el.classList.contains("open") ||
      el.classList.contains("is-open") ||
      el.classList.contains("active") ||
      el.getAttribute("aria-expanded") === "true" ||
      el.getAttribute("aria-hidden") === "false" ||
      (el.style && el.style.maxHeight && el.style.maxHeight !== "0px" && el.style.maxHeight !== "0")
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
      setTimeout(function () {
        if (isOpen(panel)) {
          panel.style.maxHeight = "none";
          panel.style.overflow = "visible";
        }
      }, 280);
    } else {
      panel.style.maxHeight = panel.scrollHeight + "px";
      panel.offsetHeight;
      panel.style.maxHeight = "0px";
      panel.style.overflow = "hidden";
      panel.style.opacity = "0";
      panel.setAttribute("aria-hidden", "true");
      panel.classList.add("collapsed");
    }
  }

  function findPanel(trigger) {
    var stamped = trigger.getAttribute("data-adrival-faq-trigger");
    if (stamped) {
      var byStamp = document.querySelector('[data-adrival-faq-panel="' + stamped + '"]');
      if (byStamp) return byStamp;
    }
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
      "[data-adrival-faq-item], .accordion-item, .faq-item, .accordion-section, [class*='accordion-item'], [class*='faq-item'], [class*='FaqItem'], .elementor-toggle-item, .e-n-accordion-item, li, article"
    );
    if (item) {
      var stampedPanel = item.querySelector("[data-adrival-faq-panel]");
      if (stampedPanel) return stampedPanel;
      var selectors = [
        ".accordion-collapse",
        ".accordion-body",
        ".collapse",
        ".faq-answer",
        ".faq-content",
        "[class*='faq-answer']",
        "[class*='FaqAnswer']",
        "[class*='accordion-collapse']",
        "[class*='toggle-content']",
        ".elementor-tab-content",
        ".e-n-accordion-item-content",
        "[role='region']"
      ];
      for (var i = 0; i < selectors.length; i++) {
        var body = item.querySelector(selectors[i]);
        if (body && body !== trigger && !trigger.contains(body) && !body.contains(trigger)) {
          return body;
        }
      }
      var kids = item.children;
      for (var k = 0; k < kids.length; k++) {
        if (kids[k] !== trigger && !trigger.contains(kids[k]) && !kids[k].contains(trigger) && looksLikeFaqPanel(kids[k])) {
          return kids[k];
        }
      }
    }
    var sib = trigger.nextElementSibling;
    while (sib) {
      if (looksLikeFaqPanel(sib) || /accordion|collapse|faq-answer|faq__answer|panel|toggle-content/i.test(sib.className || "")) {
        return sib;
      }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function closeSiblings(trigger, panel) {
    var root = trigger.closest("[data-adrival-faq-item], .accordion, .faq, [data-accordion], [class*='Accordion'], [class*='faq'], [class*='Faq']") || document;
    var parent = trigger.closest("[data-adrival-faq-item]") && trigger.closest("[data-adrival-faq-item]").parentElement;
    var scope = parent || root;
    scope.querySelectorAll("[data-adrival-faq-panel], .accordion-collapse.show, .collapse.show, .faq-answer.show, .is-open, .open").forEach(function (p) {
      if (p === panel || !looksLikeFaqPanel(p)) return;
      setOpen(p, false);
      var stamp = p.getAttribute("data-adrival-faq-panel");
      if (stamp) {
        scope.querySelectorAll('[data-adrival-faq-trigger="' + stamp + '"]').forEach(function (t) {
          t.setAttribute("aria-expanded", "false");
          t.classList.add("collapsed");
          t.classList.remove("active", "open");
        });
      }
    });
  }

  function isFaqTrigger(el) {
    if (!el || !el.closest) return null;
    if (el.closest("summary")) return null;
    var stamped = el.closest("[data-adrival-faq-trigger]");
    if (stamped) return stamped;
    return el.closest(
      '[aria-expanded], [data-bs-toggle="collapse"], [data-toggle="collapse"], [data-toggle="accordion"], .accordion-button, .accordion-header, .accordion-header button, .faq-question, .faq-header, .faq-title, [class*="faq-question"], [class*="faq-title"], [class*="FaqQuestion"], [class*="accordion-button"], [class*="accordion-header"], [class*="toggle-title"], [class*="e-n-accordion-item-title"], .elementor-tab-title'
    );
  }

  function toggleFromTrigger(trigger, e) {
    if (!trigger) return;
    if (trigger.tagName === "A" && trigger.getAttribute("href") && trigger.getAttribute("href").charAt(0) !== "#") {
      return;
    }
    var panel = findPanel(trigger);
    if (!panel) return;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    var expanded = trigger.getAttribute("aria-expanded");
    var willOpen = expanded == null ? !isOpen(panel) : expanded !== "true";
    if (willOpen) closeSiblings(trigger, panel);
    trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
    trigger.classList.toggle("collapsed", !willOpen);
    trigger.classList.toggle("active", willOpen);
    trigger.classList.toggle("open", willOpen);
    setOpen(panel, willOpen);
  }

  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("summary")) return;
      toggleFromTrigger(isFaqTrigger(t), e);
    },
    true
  );

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var t = e.target;
    if (!t || !t.closest) return;
    var trigger = isFaqTrigger(t);
    if (!trigger) return;
    toggleFromTrigger(trigger, e);
  });

  // Collapse stamped / clear FAQ panels on load
  document.querySelectorAll(
    "[data-adrival-faq-panel], .accordion-collapse:not(.show), .faq-answer:not(.show), [class*='faq-answer']:not(.show), [class*='FaqAnswer']:not(.show)"
  ).forEach(function (panel) {
    if (!looksLikeFaqPanel(panel)) return;
    if (isOpen(panel) && !panel.hasAttribute("data-adrival-faq-panel")) return;
    if (panel.getAttribute("aria-hidden") === "false" && !panel.hasAttribute("data-adrival-faq-panel")) return;
    panel.style.maxHeight = "0px";
    panel.style.overflow = "hidden";
    panel.style.opacity = "0";
    panel.setAttribute("aria-hidden", "true");
  });

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

  /* —— On-scroll / reveal sections —— */
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
    var style = el.style;
    style.opacity = "1";
    style.visibility = "visible";
    style.transform = "none";
    style.translate = "none";
    style.filter = "none";
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
      "[class*='motion']",
      "[data-framer-appear-id]",
      "section[style*='opacity: 0']",
      "section[style*='opacity:0']",
      "div[style*='opacity: 0']",
      "div[style*='opacity:0']",
      "section[style*='translate']",
      "div[style*='translateY']",
      "[class*='hero'] ~ section",
      "main > section",
      "main > div > section"
    ].join(",");
    var nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
    document.querySelectorAll("main section, main .section, [class*='Section'], [data-section], .elementor-section, .elementor-element").forEach(function (el) {
      try {
        var cs = getComputedStyle(el);
        var op = parseFloat(cs.opacity);
        var tr = cs.transform || "";
        if (
          ((op === 0 || cs.visibility === "hidden") || /matrix|translate/i.test(tr)) &&
          el.offsetParent !== null
        ) {
          nodes.push(el);
        }
      } catch (e) {}
    });
    var seen = new Set();
    return nodes.filter(function (el) {
      if (!el || seen.has(el)) return false;
      if (el.closest("header, nav, footer, script, style, noscript, [data-adrival-faq-panel]")) return false;
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

    tick();
    setTimeout(tick, 400);
    setTimeout(function () {
      candidates.forEach(function (el) {
        if (el.getAttribute("data-adrival-revealed") === "1") return;
        if (inView(el)) revealEl(el);
      });
    }, 1600);
    setTimeout(function () {
      candidates.forEach(function (el) {
        if (el.getAttribute("data-adrival-revealed") === "1") return;
        try {
          var cs = getComputedStyle(el);
          if ((parseFloat(cs.opacity) === 0 || /matrix|translate/i.test(cs.transform || "")) && inView(el)) {
            revealEl(el);
          }
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
    filter: none !important;
  }
  [data-aos],
  .aos-init,
  .wow,
  [class*="fade-up"],
  [class*="fade-in"],
  [class*="slide-up"],
  [class*="reveal"] {
    transition: opacity 0.55s ease, transform 0.55s ease;
  }
  [data-adrival-faq-panel],
  .accordion-collapse,
  .faq-answer,
  [class*="faq-answer"],
  [class*="FaqAnswer"] {
    transition: max-height 0.28s ease, opacity 0.2s ease;
  }
  [data-adrival-faq-trigger],
  .accordion-button,
  .faq-question,
  [class*="faq-question"] {
    cursor: pointer;
  }
  .accordion-collapse.show,
  .faq-answer.show,
  .faq-answer.open,
  .faq-answer.is-open,
  [class*="faq-answer"].show,
  [class*="faq-answer"].open,
  [class*="faq-answer"].is-open,
  [data-adrival-faq-panel].show,
  [data-adrival-faq-panel].open,
  [data-adrival-faq-panel].is-open {
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
