import type { BusinessProfile } from "../types";

/**
 * The client's own business must never be listed as its competitor. Its ads
 * show up in the same searches, often linking to WhatsApp or a booking app
 * rather than its website, so the page name and Facebook page count too.
 */

function hostOf(url?: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

/** "Pakenham Creek Family Dentist Pty Ltd" → "pakenhamcreekfamilydentist". */
function nameKey(name?: string | null): string {
  return (name || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(pty|ltd|limited|inc|llc|co|the|group)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

/** facebook.com/PakenhamCreekFamilyDentist/ → "pakenhamcreekfamilydentist". */
function facebookKey(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/facebook\.com\/(?:pg\/)?(?:profile\.php\?id=)?([^/?#&]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Social links on the client's site that point to Facebook. */
function ownFacebookKeys(profile: BusinessProfile | null): Set<string> {
  const keys = new Set<string>();
  for (const link of profile?.brandAssets?.socialLinks || []) {
    const key = facebookKey(link.href);
    if (key) keys.add(key);
  }
  return keys;
}

export type OwnBusinessCheck = (candidate: {
  pageName?: string | null;
  facebookUrl?: string | null;
  urls?: Array<string | null | undefined>;
}) => boolean;

/** Builds the check once per run from the client's profile and website. */
export function ownBusinessCheck(
  profile: BusinessProfile | null,
  businessUrl?: string | null,
): OwnBusinessCheck {
  const ownHosts = new Set(
    [hostOf(businessUrl), hostOf(profile?.url), hostOf(profile?.brandAssets?.finalUrl)].filter(
      (h): h is string => Boolean(h),
    ),
  );
  const ownName = nameKey(profile?.businessName);
  const ownSiteName = nameKey(profile?.brandAssets?.siteName);
  const ownFacebook = ownFacebookKeys(profile);

  const sameName = (name: string, own: string) => {
    if (!name || !own) return false;
    if (name === own) return true;
    // "Pakenham Creek Family Dentist - Pakenham" still counts; short names
    // like "Smile Dental" must match exactly.
    const shorter = name.length < own.length ? name : own;
    const longer = name.length < own.length ? own : name;
    return shorter.length >= 12 && longer.includes(shorter);
  };

  return (candidate) => {
    const name = nameKey(candidate.pageName);
    if (sameName(name, ownName) || sameName(name, ownSiteName)) return true;
    const fb = facebookKey(candidate.facebookUrl);
    if (fb && ownFacebook.has(fb)) return true;
    for (const url of candidate.urls || []) {
      const host = hostOf(url);
      if (!host) continue;
      for (const own of ownHosts) {
        if (host === own || host.endsWith(`.${own}`)) return true;
      }
    }
    return false;
  };
}
