import type { BrandLink, BrandSiteAssets } from "./brandAssets";

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isHomepageHref(href: string, businessUrl: string): boolean {
  try {
    const u = new URL(href);
    const b = new URL(businessUrl);
    if (
      u.hostname.replace(/^www\./i, "").toLowerCase() !==
      b.hostname.replace(/^www\./i, "").toLowerCase()
    ) {
      return false;
    }
    const path = u.pathname.replace(/\/$/, "") || "/";
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

/** All non-home internal pages available for routing. */
export function collectRoutableBrandLinks(
  assets: BrandSiteAssets | null | undefined,
  businessUrl: string,
): BrandLink[] {
  if (!assets) return [];
  const seen = new Set<string>();
  const out: BrandLink[] = [];
  for (const l of [
    ...(assets.ctaLinks || []),
    ...(assets.servicePages || []),
    ...(assets.navLinks || []),
    ...(assets.footerLinks || []),
  ]) {
    const href = (l.href || "").trim();
    if (!href || isHomepageHref(href, businessUrl)) continue;
    const key = href.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: l.label || href, href });
  }
  return out;
}

const SEMANTIC_RULES: Array<{ probe: RegExp; target: RegExp }> = [
  { probe: /privacy/, target: /privacy/ },
  { probe: /terms|condition/, target: /terms|condition/ },
  { probe: /cookie/, target: /cookie/ },
  { probe: /licen[cs]/, target: /licen[cs]/ },
  {
    probe: /contact|assistance|get in touch|reach us|enquire|enquir/,
    target: /contact|enquiry|enquir|get-in-touch|support|help/,
  },
  {
    probe: /book|schedule|appoint|consult|reserve/,
    target: /book|schedule|appoint|consult|reserve|booking/,
  },
  {
    probe: /apply|start|sign\s*up|register|get started|try|demo/,
    target: /apply|start|signup|sign-up|register|demo|trial|get-started/,
  },
  { probe: /about|our story|who we|team/, target: /about|team|our-story|who-we/ },
  {
    probe: /service|treatment|solution|offering|product|pricing|plan|package/,
    target: /service|treatment|solution|offering|product|pricing|plan|package/,
  },
  { probe: /blog|news|resource|guide|insight/, target: /blog|news|resource|guide|insight/ },
  { probe: /career|job|join/, target: /career|job|join/ },
  { probe: /faq|help|support/, target: /faq|help|support/ },
  { probe: /location|clinic|office|visit|find us/, target: /location|clinic|office|visit|find|branch/ },
];

/**
 * Map a competitor link (label + path) onto a real brand page.
 * Prefers semantic / slug matches; never invents URLs.
 * Returns null when no good match (caller decides homepage vs leave).
 */
export function resolveBrandPageHref(input: {
  label: string;
  competitorPath?: string | null;
  links: BrandLink[];
  businessUrl: string;
}): string | null {
  const lab = norm(input.label);
  const links = input.links.filter(
    (l) => l.href && !isHomepageHref(l.href, input.businessUrl),
  );
  if (!links.length) return null;

  if (lab) {
    const exact = links.find((l) => norm(l.label) === lab);
    if (exact) return exact.href;
    for (const l of links) {
      const k = norm(l.label);
      if (lab.length >= 4 && k.length >= 4 && (k.includes(lab) || lab.includes(k))) {
        return l.href;
      }
    }
  }

  const path = (input.competitorPath || "").replace(/\/$/, "").toLowerCase();
  if (path && path !== "/") {
    const same = links.find((l) => {
      try {
        return new URL(l.href).pathname.replace(/\/$/, "").toLowerCase() === path;
      } catch {
        return false;
      }
    });
    if (same) return same.href;

    const tail = path.split("/").filter(Boolean).pop();
    if (tail && tail.length >= 3) {
      const byTail = links.find((l) => {
        try {
          const p = new URL(l.href).pathname.toLowerCase();
          return p.endsWith(`/${tail}`) || p === `/${tail}`;
        } catch {
          return false;
        }
      });
      if (byTail) return byTail.href;
    }
  }

  const hay = `${lab} ${path}`;
  for (const rule of SEMANTIC_RULES) {
    if (!rule.probe.test(hay)) continue;
    const found = links.find(
      (l) => rule.target.test(norm(l.label)) || rule.target.test(l.href.toLowerCase()),
    );
    if (found) return found.href;
  }

  return null;
}

/**
 * Best destination for a CTA button — contact/book/apply/service, not bare homepage.
 */
export function pickCtaHref(input: {
  label: string;
  className?: string;
  assets: BrandSiteAssets | null | undefined;
  businessUrl: string;
}): string {
  const links = collectRoutableBrandLinks(input.assets, input.businessUrl);
  const hay = `${norm(input.label)} ${norm(input.className || "")}`;

  const matched = resolveBrandPageHref({
    label: input.label,
    competitorPath: null,
    links,
    businessUrl: input.businessUrl,
  });
  if (matched) return matched;

  const prefer = (re: RegExp) =>
    links.find((l) => re.test(norm(l.label)) || re.test(l.href.toLowerCase()));

  if (/book|schedule|appoint|consult/i.test(hay)) {
    const hit = prefer(/book|schedule|appoint|consult|booking/);
    if (hit) return hit.href;
  }
  if (/apply|start|sign\s*up|register|try|demo|get started/i.test(hay)) {
    const hit = prefer(/apply|start|signup|register|demo|trial|get-started/);
    if (hit) return hit.href;
  }
  if (/call|contact|enquire|enquir|quote|talk/i.test(hay)) {
    const hit = prefer(/contact|enquiry|enquir|quote|support/);
    if (hit) return hit.href;
  }

  // Dedicated CTA list first, then contact, then first service, then first nav
  const cta = (input.assets?.ctaLinks || []).find(
    (l) => !isHomepageHref(l.href, input.businessUrl),
  );
  if (cta) return cta.href;

  const contact = prefer(/contact|enquiry|enquir|book/);
  if (contact) return contact.href;

  const service = (input.assets?.servicePages || []).find(
    (l) => !isHomepageHref(l.href, input.businessUrl),
  );
  if (service) return service.href;

  if (links[0]) return links[0].href;
  return input.businessUrl;
}
