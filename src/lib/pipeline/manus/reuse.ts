/**
 * Whether a generate request may return the page already there (finished or
 * still building) instead of starting a build. A requested reader (ICP) that
 * differs from the one the page was built for always rebuilds.
 */
export function shouldReuseCachedPage(input: {
  force: boolean;
  requestedIcpId: string | null;
  storedIcpId: string | null;
}): boolean {
  if (input.force) return false;
  if (input.requestedIcpId && input.requestedIcpId !== input.storedIcpId) return false;
  return true;
}
