import { getJob, getLookupJob, updateJob, updateLookupJob } from "./db";
import { LOOKUP_RECREATE_PREFIX } from "./pipeline/lookupRecreateBridge";

/*
 * The client's website on a search run, which a recreation brands the page
 * with. Shared by the Recreate page's "set_business_url" action and the
 * Recreate queue API.
 */

/** "acme.com.au/" → "https://acme.com.au", or null when it is not a website. */
export function normalizeWebsite(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

/** The run's client website, normalized, or null when it has none. */
export async function runBusinessUrl(runId: string): Promise<string | null> {
  const job = await getJob(runId);
  return normalizeWebsite(job?.businessUrl || job?.businessProfile?.url || "");
}

/**
 * Saves the client's website (already normalized) on the run, and on the
 * lookup behind a lookup's recreate run. False when the run is missing.
 * `fillProfileUrl` (default true) also gives a business profile without a
 * website this one; the Recreate queue passes false, since the website of a
 * job is not the search's own business (that profile's url must stay as it
 * was made).
 */
export async function saveRunBusinessUrl(
  runId: string,
  website: string,
  options: { fillProfileUrl?: boolean } = {},
): Promise<boolean> {
  const job = await getJob(runId);
  if (!job) return false;
  await updateJob(job.id, {
    businessUrl: website,
    ...((options.fillProfileUrl ?? true) && job.businessProfile && !job.businessProfile.url
      ? { businessProfile: { ...job.businessProfile, url: website } }
      : {}),
  });
  if (job.id.startsWith(LOOKUP_RECREATE_PREFIX)) {
    const lookupId = job.id.slice(LOOKUP_RECREATE_PREFIX.length);
    if (await getLookupJob(lookupId)) await updateLookupJob(lookupId, { businessUrl: website });
  }
  return true;
}
