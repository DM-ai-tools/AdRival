import { cookies } from "next/headers";
import { getUserById, toPublicUser } from "@/lib/db";
import type { AppUserPublic } from "@/lib/types";
import { parseSessionToken, SESSION_COOKIE } from "@/lib/auth/session";

export async function getCurrentUser(): Promise<AppUserPublic | null> {
  const jar = await cookies();
  const session = await parseSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = getUserById(session.sub);
  return user ? toPublicUser(user) : null;
}

export async function requireCurrentUser(): Promise<AppUserPublic | null> {
  return getCurrentUser();
}
