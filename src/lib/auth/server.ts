import { toPublicUser } from "@/lib/db";
import { getSessionUser } from "@/lib/authz";
import type { AppUserPublic } from "@/lib/types";

/**
 * Server-side current user. Delegates to getSessionUser() so the account status
 * and session-epoch checks are applied everywhere, not just in API routes.
 */
export async function getCurrentUser(): Promise<AppUserPublic | null> {
  const user = await getSessionUser();
  return user ? toPublicUser(user) : null;
}

export async function requireCurrentUser(): Promise<AppUserPublic | null> {
  return getCurrentUser();
}
