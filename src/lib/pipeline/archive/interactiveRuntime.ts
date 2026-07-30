/**
 * Lightweight interactivity runtime injected into archived recreations.
 * Restores FAQ / accordion / collapse behavior when original site JS is missing
 * or fails under srcDoc (still works alongside native <details>/<summary>).
 */
export const INTERACTIVE_RUNTIME_SCRIPT = `
(function () {
  if (window.__adrivalInteractive) return;
  window.__adrivalInteractive = true;

  function isOpen(el) {
    return (
      el.classList.contains("show") ||
      el.classList.contains("open") ||
      el.classList.contains("is-open") ||
      el.classList.contains("active") ||
      el.getAttribute("aria-hidden") === "false"
    );
  }

  function setOpen(panel, open) {
    if (!panel) return;
    panel.classList.toggle("show", open);
    panel.classList.toggle("open", open);
    panel.classList.toggle("is-open", open);
    panel.classList.toggle("active", open);
    panel.classList.toggle("collapsed", !open);
    if (panel.hasAttribute("hidden")) {
      if (open) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "");
    }
    if (panel.getAttribute("aria-hidden") != null) {
      panel.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (getComputedStyle(panel).display === "none" && open) {
      panel.style.display = "block";
    } else if (!open && panel.style.display === "block") {
      panel.style.display = "";
    }
    // Height animation hint for common accordion bodies
    if (open) {
      panel.style.maxHeight = panel.scrollHeight ? panel.scrollHeight + "px" : "none";
      panel.style.overflow = "hidden";
    } else {
      panel.style.maxHeight = "0px";
      panel.style.overflow = "hidden";
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
      var byHref = document.querySelector(href);
      if (byHref) return byHref;
    }
    var item = trigger.closest(".accordion-item, .faq-item, .accordion-section, [class*='accordion'], [class*='faq'], li, article, section, div");
    if (item) {
      var body = item.querySelector(".accordion-collapse, .accordion-body, .collapse, .faq-answer, .faq-content, [class*='answer'], [class*='panel'], [class*='content']");
      if (body && body !== trigger && !trigger.contains(body)) return body;
    }
    // next sibling panel
    var sib = trigger.nextElementSibling;
    while (sib) {
      if (/accordion|collapse|faq|answer|panel|content/i.test(sib.className || "") || sib.getAttribute("role") === "region") {
        return sib;
      }
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function closeSiblings(trigger, panel) {
    var root = trigger.closest(".accordion, .faq, [data-accordion], [class*='Accordion'], [class*='faq']") || document;
    var openPanels = root.querySelectorAll(".accordion-collapse.show, .collapse.show, .faq-answer.show, .is-open, .open");
    openPanels.forEach(function (p) {
      if (p === panel) return;
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

  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      // Native <summary> / <details> already work — don't interfere
      if (t.closest("summary")) return;

      var trigger = t.closest(
        '[aria-expanded], [data-bs-toggle="collapse"], [data-toggle="collapse"], .accordion-button, .accordion-header button, .faq-question, .faq-header, [class*="faq-question"], [class*="accordion-button"]'
      );
      if (!trigger) return;
      if (trigger.tagName === "A" && trigger.getAttribute("href") && trigger.getAttribute("href").charAt(0) !== "#") {
        return;
      }

      var panel = findPanel(trigger);
      if (!panel) return;

      e.preventDefault();
      var expanded = trigger.getAttribute("aria-expanded");
      var willOpen = expanded == null ? !isOpen(panel) : expanded !== "true";
      if (willOpen) closeSiblings(trigger, panel);
      trigger.setAttribute("aria-expanded", willOpen ? "true" : "false");
      trigger.classList.toggle("collapsed", !willOpen);
      setOpen(panel, willOpen);
    },
    true
  );

  // Initialize collapsed panels so they aren't all open
  document.querySelectorAll('.accordion-collapse, .collapse, [class*="faq-answer"]').forEach(function (panel) {
    var open = isOpen(panel);
    if (!open && !panel.style.maxHeight) {
      panel.style.maxHeight = "0px";
      panel.style.overflow = "hidden";
    }
  });

  // Tabs (simple role=tab)
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
})();
`.trim();

export function injectInteractiveRuntime(html: string): string {
  const tag = `<script data-adrival-interactive="1">${INTERACTIVE_RUNTIME_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>`;
  if (/data-adrival-interactive=/i.test(html)) return html;
  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${tag}</body>`);
  }
  return `${html}\n${tag}`;
}
